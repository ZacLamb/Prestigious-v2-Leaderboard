/**
 * Optional GoHighLevel lookup, used for one purpose: filling in a lead source
 * where the sheet doesn't have one.
 *
 * The sheet remains authoritative for every figure. This never supplies money,
 * dates, brokers or lenders — only a source string, and only onto rows whose
 * Source cell is empty. If the tokens aren't configured the whole module
 * no-ops and the dashboard behaves exactly as it does today.
 *
 * Matching is by business name, which is the only key the two systems share.
 * That makes it inherently approximate, so the rules below are deliberately
 * conservative: normalize hard, and refuse to guess when a name is ambiguous.
 */

const API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

let report = (msg) => console.log(msg);
export function setCrmLogger(fn) { report = fn; }

/** Legal suffixes that differ between systems for the same business. */
const LEGAL_SUFFIXES = new Set([
  'llc', 'lllc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'limited', 'llp', 'lp', 'pllc', 'pc', 'pa', 'plc', 'dba', 'the',
]);

/**
 * Reduce a business name to a comparison key.
 * "THOMAS E. TUREK, M.D., LLC" and "Thomas E Turek MD LLC" both collapse to
 * "thomas e turek md", so the same merchant matches across both systems.
 */
export function normalizeBusinessName(name) {
  let s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing legal suffixes repeatedly ("Acme Holdings Co LLC").
  let parts = s.split(' ');
  while (parts.length > 1 && LEGAL_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop();
  }
  // A leading "the" is noise too.
  while (parts.length > 1 && parts[0] === 'the') parts.shift();

  /**
   * Join runs of two or more single letters, so punctuated initials match
   * their unpunctuated form: "M.D." becomes "m d" after the strip above, and
   * must end up as "md" to match a CRM record written "MD". Also handles
   * "A&B Trucking" vs "AB Trucking". A lone initial is left alone, so
   * "Thomas E Turek" keeps its middle initial separate.
   */
  const merged = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) merged.push(run.join(''));
    else merged.push(...run);
    run = [];
  };
  for (const p of parts) {
    if (p.length === 1 && /[a-z]/.test(p)) run.push(p);
    else { flush(); merged.push(p); }
  }
  flush();

  return merged.join(' ');
}

async function ghlFetch(path, { token, params = {}, retries = 2 } = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: API_VERSION,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if ((res.status === 429 || res.status >= 500) && retries > 0) {
      await new Promise((r) => setTimeout(r, (3 - retries) * 800 + 400));
      return ghlFetch(path, { token, params, retries: retries - 1 });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GHL ${res.status} on ${path}: ${body.slice(0, 160)}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Custom field id -> name, restricted to opportunity fields.
 * Needed because opportunity payloads carry field IDs, not names.
 */
async function fetchFieldDefs({ token, locationId }) {
  let data;
  try {
    data = await ghlFetch(`/locations/${locationId}/customFields`, {
      token, params: { model: 'opportunity' },
    });
  } catch {
    data = await ghlFetch(`/locations/${locationId}/customFields`, { token });
  }

  const map = {};
  for (const f of data.customFields || data.customField || []) {
    if (!f.id) continue;
    const fieldKey = f.fieldKey || f.key || '';
    const model = f.model || f.objectType || '';
    const isOpp = model
      ? String(model).toLowerCase() === 'opportunity'
      : (fieldKey.includes('.') ? fieldKey.startsWith('opportunity.') : true);
    if (!isOpp) continue;
    map[f.id] = { name: f.name || fieldKey, fieldKey };
  }
  return map;
}

/** Pull a usable scalar out of GHL's typed custom-field value properties. */
function fieldValue(f) {
  const keys = ['fieldValue', 'fieldValueString', 'fieldValueNumber', 'value', 'text'];
  for (const k of keys) {
    const v = f[k];
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return v;
  }
  for (const [k, v] of Object.entries(f)) {
    if (!/^fieldValue/i.test(k)) continue;
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return v;
  }
  return '';
}

/** The source for one opportunity, checked in order of reliability. */
function sourceOf(opp, fieldDefs) {
  if (opp.source) return String(opp.source).trim();
  if (opp.contact?.source) return String(opp.contact.source).trim();

  for (const f of opp.customFields || []) {
    const def = f.id ? fieldDefs[f.id] : null;
    const name = String(def?.name || f.name || '').toLowerCase();
    const key = String(def?.fieldKey || f.fieldKey || '').toLowerCase();
    if (name === 'source' || name === 'lead source' ||
        key.endsWith('.source') || key.endsWith('.lead_source')) {
      const v = fieldValue(f);
      if (v) return String(v).trim();
    }
  }
  return '';
}

/**
 * Build businessName -> source for one location.
 *
 * Names that resolve to conflicting sources are dropped rather than guessed:
 * attributing a deal to the wrong channel is worse than leaving it
 * unattributed, because it silently skews the channel numbers.
 */
export async function fetchSourceMap({ token, locationId, officeName, maxPages = 30 }) {
  const fieldDefs = await fetchFieldDefs({ token, locationId });

  const candidates = new Map(); // normalized name -> Set of sources
  let page = 1;
  let scanned = 0;
  const limit = 100;

  while (page <= maxPages) {
    const data = await ghlFetch('/opportunities/search', {
      token,
      params: { location_id: locationId, limit, page },
    });

    const batch = data.opportunities || [];
    scanned += batch.length;

    for (const opp of batch) {
      const src = sourceOf(opp, fieldDefs);
      if (!src) continue;

      // Every name this opportunity might be known by in the sheet.
      const names = [
        opp.contact?.companyName,
        opp.contact?.company,
        opp.name,
      ].filter(Boolean);

      for (const f of opp.customFields || []) {
        const def = f.id ? fieldDefs[f.id] : null;
        const nm = String(def?.name || '').toLowerCase();
        if (nm === 'business name') {
          const v = fieldValue(f);
          if (v) names.push(v);
        }
      }

      for (const n of names) {
        const key = normalizeBusinessName(n);
        if (!key || key.length < 3) continue;
        if (!candidates.has(key)) candidates.set(key, new Set());
        candidates.get(key).add(src);
      }
    }

    if (batch.length < limit) break;
    page += 1;
  }

  const map = new Map();
  let ambiguous = 0;
  for (const [key, sources] of candidates) {
    if (sources.size === 1) map.set(key, [...sources][0]);
    else ambiguous++;
  }

  report(`[${officeName}] CRM: scanned ${scanned} opportunities, ` +
         `${map.size} business names with a single source` +
         (ambiguous ? `, ${ambiguous} skipped as ambiguous` : ''));

  return map;
}

/**
 * Fill blank sources from the CRM map. The sheet always wins: a row that
 * already has a source is returned untouched.
 */
export function applySourceMap(rows, sourceMap, report = () => {}) {
  if (!sourceMap || sourceMap.size === 0) return { rows, filled: 0, unmatched: 0 };

  let filled = 0;
  let unmatched = 0;

  const out = rows.map((r) => {
    const hasSheetSource = r.source && r.source !== '—';
    if (hasSheetSource) return r;

    const key = normalizeBusinessName(r.businessName);
    const found = key ? sourceMap.get(key) : null;

    if (!found) { unmatched++; return r; }

    filled++;
    return { ...r, source: found, sourceFrom: 'crm' };
  });

  report(`Filled ${filled} blank source(s) from the CRM; ${unmatched} still unmatched`);
  return { rows: out, filled, unmatched };
}

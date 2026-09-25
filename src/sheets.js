/**
 * Reads a commission spreadsheet through Google's gviz endpoint.
 *
 * No API key or service account — the sheet only has to be shared so anyone
 * with the link can view it.
 *
 * Consolidation is treated as its own independent dimension rather than a
 * fallback: a row's regular funded/commission and its consolidation
 * funded/commission are read from their own columns and never substituted for
 * one another, so consolidation money can be reported separately from regular
 * production without either total absorbing the other.
 */

/** Column headers we look for, in priority order. Matching ignores case/punctuation. */
const COLUMNS = {
  date:        ['date'],
  broker:      ['broker name', 'broker', 'rep', 'agent'],
  business:    ['business name', 'business', 'merchant', 'company'],
  funded:      ['funded amount', 'funded', 'amount funded'],
  commission:  ['commision amount', 'commission amount', 'commision', 'commission'],
  payout:      ['payout', 'payout amount'],
  datePaid:    ['date paid', 'paid date'],
  clawback:    ['clawback', 'claw back'],
  fee:         ['fee', 'psf'],
  lender:      ['lender/s', 'lenders', 'lender', 'funder'],
  gotPaid:     ['did we get paid', 'got paid', 'paid'],
  source:      ['source', 'lead source', 'leadsource'],
  consolidationFunded:     ['total consolidation funded', 'consolidation funded'],
  consolidationCommission: ['total consolidation commision', 'total consolidation commission',
                            'consolidation commision', 'consolidation commission'],
  notes:       ['notes', 'note'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function parseAmount(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Turn Google's response into a sentence naming the actual problem. A sign-in
 * page, a permissions error and a bad gid all fail identically otherwise, and
 * each needs a different fix.
 */
function describeSheetBody(text) {
  const body = String(text || '');
  const head = body.slice(0, 400).replace(/\s+/g, ' ');

  if (/accounts\.google\.com|ServiceLogin|signin\/v2|Sign in/i.test(body)) {
    return 'Google served a sign-in page — the sheet is not readable without logging in. ' +
           'Set File → Share → General access → Anyone with the link → Viewer.';
  }
  if (/permission|not have access|PERMISSION_DENIED|requires access/i.test(body)) {
    return 'Google reported a permissions error. ' +
           'Set File → Share → General access → Anyone with the link → Viewer.';
  }
  if (/<!DOCTYPE html|<html/i.test(body)) {
    return `Google returned an HTML page instead of data. First 200 chars: ${head.slice(0, 200)}`;
  }
  return `Unexpected response. First 200 chars: ${head.slice(0, 200)}`;
}

/** gviz returns dates as the literal string "Date(2026,6,10)" — month is 0-based. */
function parseSheetDate(v) {
  if (!v) return null;
  try {
    if (typeof v === 'string' && v.startsWith('Date(')) {
      const p = v.replace('Date(', '').replace(')', '').split(',').map(Number);
      return new Date(Date.UTC(p[0], p[1], p[2], 12)); // midday UTC avoids TZ edge flips
    }
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;

    // Free text lands in date columns ("Ari paid $600" parses as year 600).
    const year = d.getUTCFullYear();
    if (year < 2000 || year > 2100) return null;

    return d;
  } catch {
    return null;
  }
}

/** Locate each logical column by header text, so column order can change safely. */
function mapColumns(cols) {
  const labels = cols.map((c) => norm(c.label));
  const found = {};
  const taken = new Set();

  for (const [key, candidates] of Object.entries(COLUMNS)) {
    for (const cand of candidates) {
      const idx = labels.indexOf(norm(cand));
      if (idx !== -1 && !taken.has(idx)) { found[key] = idx; taken.add(idx); break; }
    }
  }

  // Second pass: contains-match for headers with extra words, skipping columns
  // already claimed by an exact match so "Fee" can't steal a consolidation column.
  for (const [key, candidates] of Object.entries(COLUMNS)) {
    if (found[key] !== undefined) continue;
    for (const cand of candidates) {
      const idx = labels.findIndex((l, i) => l && l.includes(norm(cand)) && !taken.has(i));
      if (idx !== -1) { found[key] = idx; taken.add(idx); break; }
    }
  }

  return found;
}

/**
 * Fetch and parse one office's commission sheet.
 * @returns {{ rows: object[], meta: object }}
 */
/**
 * Parse CSV, respecting quoted fields that contain commas or newlines.
 * Google quotes anything containing a delimiter, and the notes columns in
 * these sheets routinely do.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Read a sheet, trying each public endpoint in turn.
 *
 * Google treats these differently: a sheet shared "anyone with the link" can
 * be readable through one and refused through another, and which one works has
 * changed over time. Trying several means a policy shift on Google's side
 * degrades to a slower path instead of an outage.
 */
async function fetchSheetPayload({ sheetId, gid, tab, report }) {
  const stamp = Date.now();
  const target = gid
    ? `gid=${encodeURIComponent(gid)}`
    : (tab ? `sheet=${encodeURIComponent(tab)}` : '');

  const endpoints = [
    { kind: 'gviz', url: `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&${target}&t=${stamp}` },
    { kind: 'csv',  url: `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&${target}&t=${stamp}` },
    { kind: 'csv',  url: `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&${target}&t=${stamp}` },
  ];

  const failures = [];

  for (const ep of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const res = await fetch(ep.url, { signal: controller.signal, redirect: 'follow' });
      const text = await res.text();

      if (!res.ok) { failures.push(`${ep.kind} HTTP ${res.status}`); continue; }

      if (ep.kind === 'gviz') {
        const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/);
        if (!match) { failures.push(`gviz: ${describeSheetBody(text).slice(0, 80)}`); continue; }

        const json = JSON.parse(match[1]);
        if (json.status === 'error' || !json.table) {
          const reasons = (json.errors || [])
            .map((e) => e.detailed_message || e.message || e.reason).filter(Boolean).join('; ');
          failures.push(`gviz: ${reasons || 'query rejected'}`);
          continue;
        }

        report('Read via gviz JSON');
        return { kind: 'gviz', cols: json.table.cols || [], rows: json.table.rows || [] };
      }

      // A sign-in page is still HTML, so check before trying to parse it as CSV.
      if (/<!DOCTYPE html|<html/i.test(text.slice(0, 200))) {
        failures.push(`csv: ${describeSheetBody(text).slice(0, 80)}`);
        continue;
      }

      const table = parseCsv(text);
      if (!table.length) { failures.push('csv: empty response'); continue; }

      report(`Read via CSV export (${table.length - 1} data rows)`);
      return {
        kind: 'csv',
        cols: table[0].map((label) => ({ label })),
        // Match the gviz row shape so downstream code doesn't branch.
        rows: table.slice(1).map((cells) => ({ c: cells.map((v) => ({ v })) })),
      };
    } catch (err) {
      failures.push(`${ep.kind}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `Could not read the sheet through any endpoint. ${failures.join(' | ')} — ` +
    'Check File → Share → General access → Anyone with the link → Viewer.'
  );
}

/**
 * Fetch and parse one office's commission sheet.
 * @returns {{ rows: object[], meta: object }}
 */
export async function fetchSheetRows({ sheetId, gid, tab, officeName, report = () => {} }) {
  const payload = await fetchSheetPayload({
    sheetId, gid, tab,
    report: (m) => report(`[${officeName}] ${m}`),
  });

  const cols = payload.cols;
  const rawRows = payload.rows;
  const map = mapColumns(cols);

  const missing = ['date', 'broker'].filter((k) => map[k] === undefined);
  if (missing.length) {
    throw new Error(
      `Sheet is missing required column(s): ${missing.join(', ')}. ` +
      `Headers found: ${cols.map((c) => c.label).filter(Boolean).join(' | ')}`
    );
  }

  const cell = (r, idx) => {
    if (idx === undefined) return '';
    const c = r.c?.[idx];
    if (!c) return '';
    return c.v !== undefined && c.v !== null ? c.v : (c.f || '');
  };

  const rows = [];
  let skippedNoBroker = 0;
  let skippedNoDate = 0;

  for (const r of rawRows) {
    const broker = String(cell(r, map.broker)).trim();
    if (!broker || norm(broker) === norm('broker name')) { skippedNoBroker++; continue; }

    const date = parseSheetDate(cell(r, map.date));
    if (!date) { skippedNoDate++; continue; }

    /**
     * Each money column is read on its own. Regular and consolidation figures
     * are kept apart so neither total can absorb the other; fees are a single
     * column that applies to both kinds of deal.
     */
    const fundedAmount            = parseAmount(cell(r, map.funded));
    const commission              = parseAmount(cell(r, map.commission));
    const consolidationFunded     = parseAmount(cell(r, map.consolidationFunded));
    const consolidationCommission = parseAmount(cell(r, map.consolidationCommission));
    const fee                     = parseAmount(cell(r, map.fee));

    rows.push({
      broker,
      businessName: String(cell(r, map.business) || '—').trim(),
      fundedAmount,
      commission,
      consolidationFunded,
      consolidationCommission,
      // A row counts as consolidation when it carries consolidation money.
      isConsolidation: consolidationFunded > 0 || consolidationCommission > 0,
      fee,
      payout: parseAmount(cell(r, map.payout)),
      clawback: parseAmount(cell(r, map.clawback)),
      lender: String(cell(r, map.lender) || '—').trim(),
      source: String(cell(r, map.source) || '—').trim(),
      notes: String(cell(r, map.notes) || '').trim(),
      datePaid: parseSheetDate(cell(r, map.datePaid))?.toISOString() || null,
      gotPaid: String(cell(r, map.gotPaid) || '').trim(),
      fundedDate: date.toISOString(),
    });
  }

  return {
    rows,
    meta: {
      totalSheetRows: rawRows.length,
      usableRows: rows.length,
      skippedNoBroker,
      skippedNoDate,
      columnsMatched: map,
      headers: cols.map((c) => c.label).filter(Boolean),
      hasSourceColumn: map.source !== undefined,
      readVia: payload.kind,
    },
  };
}

/**
 * Normalize a name's casing: "JAMES" -> "James", "jack/sean" -> "Jack/Sean".
 *
 * The board groups by broker name, so without this the same person entered as
 * "Ari" and "ari" becomes two rows splitting one rep's production.
 */
export function canonicalizeBrokerNames(rows, report = () => {}) {
  let recased = 0;

  const out = rows.map((r) => {
    const cased = String(r.broker)
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\s+/g, ' ')
      .trim();
    if (cased !== r.broker) recased++;
    return cased === r.broker ? r : { ...r, broker: cased };
  });

  if (recased) report(`Normalized casing on ${recased} broker name(s) so variants merge`);
  return out;
}

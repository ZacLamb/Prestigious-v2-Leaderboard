import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig } from './src/config.js';
import { fetchSheetRows, canonicalizeBrokerNames } from './src/sheets.js';
import { fetchSourceMap, applySourceMap, setCrmLogger } from './src/crm.js';
import {
  acceptPush, getPushed, loadSnapshots, pushStatus, setIngestLogger, snapshotDir,
} from './src/ingest.js';
import {
  buildTotals, aggregateByBroker, summarizeBySource, buildDealRows, availableMonths,
} from './src/aggregate.js';
import { resolveRange } from './src/dateRange.js';
import { cached, getStale, invalidate, cacheMeta } from './src/cache.js';
import {
  attachRole, createSession, clearSession, verifyAdminPassword, verifySharedSecret,
} from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const app = express();

/**
 * Ring buffer of recent sync output, served over HTTP.
 * Railway's log view isn't always reachable when you need it, and the admin
 * cookie can be blocked inside an iframe — so keep the lines here too.
 */
const LOG_CAP = 300;
const recentLogs = [];

function logLine(msg) {
  console.log(msg);
  recentLogs.push(`${new Date().toISOString().slice(11, 19)}  ${msg}`);
  if (recentLogs.length > LOG_CAP) recentLogs.splice(0, recentLogs.length - LOG_CAP);
}

const { errors: configErrors, warnings: configWarnings } = validateConfig(cfg);

if (configErrors.length) {
  console.error('\n❌ Configuration errors — dashboard will show a setup screen:\n');
  configErrors.forEach((e) => console.error('   • ' + e));
  console.error('');
}
if (configWarnings.length) {
  console.warn('\n⚠️  Configuration warnings:\n');
  configWarnings.forEach((w) => console.warn('   • ' + w));
  console.warn('');
}

setCrmLogger(logLine);
setIngestLogger(logLine);
loadSnapshots(cfg.offices.map((o) => o.key));

app.set('trust proxy', 1); // Railway sits behind a proxy

/**
 * A whole commission tab arrives as one JSON body, far past express.json's
 * 100kb default. The large limit is confined to the ingest route — the default
 * parser must skip that path entirely, because otherwise it runs first and
 * rejects the push with 413 before the route is ever reached.
 */
const ingestBodyParser = express.json({ limit: '24mb' });
const defaultBodyParser = express.json();

app.use((req, res, next) =>
  (req.path.startsWith('/api/ingest/') ? next() : defaultBodyParser(req, res, next)));
app.use(cookieParser());
app.use(attachRole(cfg.jwtSecret || 'unset-secret-config-invalid'));

// ── Data ─────────────────────────────────────────────────────────────────────

/**
 * Get one office's table, from whichever source has it.
 *
 * Pushed data wins when it's fresh: the Apps Script inside the spreadsheet
 * runs as the sheet's owner, so it keeps working when Google's sharing policy
 * refuses anonymous reads — which is the failure this path exists for.
 *
 * When a push goes stale the trigger has probably stopped, so the direct read
 * is tried before falling back to the old push. That way a stopped trigger
 * self-heals if sharing happens to be open, and still serves something (with
 * a banner) if it isn't.
 */
async function readOfficeTable(office, log) {
  const pushed = getPushed(office.key);
  const staleAfterMs = cfg.pushStaleMinutes * 60 * 1000;

  if (pushed && pushed.ageMs < staleAfterMs) {
    log(`Using pushed data from the sheet's own script (${Math.round(pushed.ageMs / 60000)} min old)`);
    return { ...pushed, notice: null };
  }

  if (pushed) {
    const hours = (pushed.ageMs / 3_600_000).toFixed(1);
    log(`Pushed data is ${hours}h old — trying a direct read before trusting it`);
    try {
      const fresh = await fetchSheetRows({
        sheetId: office.sheetId,
        gid: office.sheetGid,
        officeName: office.name,
        report: logLine,
      });
      log('Direct read succeeded — using it instead of the stale push');
      return { ...fresh, notice: null };
    } catch (err) {
      log(`Direct read failed (${err.message.slice(0, 120)}) — serving the stale push`);
      return {
        ...pushed,
        notice: `${office.name}: the sheet's push script last reported ${hours}h ago. ` +
                'Check the Apps Script trigger in that spreadsheet.',
      };
    }
  }

  log(`No pushed data yet; reading sheet ${office.sheetId} (gid ${office.sheetGid}) directly`);
  const fresh = await fetchSheetRows({
    sheetId: office.sheetId,
    gid: office.sheetGid,
    officeName: office.name,
    report: logLine,
  });
  return { ...fresh, notice: null };
}

/** Read and normalize one office's data. Cached. */
async function syncOffice(office) {
  const key = `office:${office.key}`;

  const { value } = await cached(key, cfg.cacheTtlMs, async () => {
    const log = (m) => logLine(`[${office.name}] ${m}`);
    log('─'.repeat(50));

    const { rows, meta, notice } = await readOfficeTable(office, log);

    log(`Read via ${meta.readVia} · columns matched: ${Object.keys(meta.columnsMatched).join(', ')}`);
    log(`${meta.usableRows} usable rows of ${meta.totalSheetRows}` +
        (meta.skippedNoDate ? `, ${meta.skippedNoDate} skipped (no date)` : '') +
        (meta.skippedNoBroker ? `, ${meta.skippedNoBroker} skipped (no broker)` : ''));

    if (!meta.hasSourceColumn) {
      log('No Source column in this sheet — lead sources will read as Unattributed.');
    }

    let named = canonicalizeBrokerNames(rows, log);

    /**
     * Optional: fill blank Source cells from the CRM. Wrapped so a GHL outage
     * degrades to "no sources" rather than taking the whole office down — the
     * sheet's figures are what actually matter here.
     */
    if (cfg.crmSourceLookup && office.token && office.locationId) {
      try {
        const map = await fetchSourceMap({
          token: office.token,
          locationId: office.locationId,
          officeName: office.name,
        });
        const applied = applySourceMap(named, map, log);
        named = applied.rows;
      } catch (err) {
        log(`CRM source lookup failed (sheet data unaffected): ${err.message}`);
      }
    }

    const out = named.map((r) => ({ ...r, officeKey: office.key, officeName: office.name }));

    const funded = out.reduce((t, r) => t + r.fundedAmount, 0);
    const consol = out.reduce((t, r) => t + r.consolidationFunded, 0);
    log(`${out.length} deals · funded $${funded.toLocaleString()} · consolidation $${consol.toLocaleString()}`);

    return { rows: out, notice, readVia: meta.readVia };
  });

  return value;
}

/** Resolve ?office= into the set of offices to include. */
function selectOffices(param) {
  const want = String(param || 'joint').toLowerCase();
  if (want === 'joint' || want === 'all' || want === 'both') return cfg.offices;
  const match = cfg.offices.filter((o) => o.key === want || o.name.toLowerCase() === want);
  return match.length ? match : cfg.offices;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const selftestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/login', loginLimiter, (req, res) => {
  if (!verifyAdminPassword(req.body?.password, cfg.adminPassword)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  createSession(res, { role: 'admin' }, cfg.jwtSecret);
  res.json({ role: 'admin' });
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ role: 'viewer' });
});

app.get('/api/session', (req, res) => {
  res.json({
    role: req.role,
    offices: cfg.offices.map((o) => ({ key: o.key, name: o.name })),
    barMax: cfg.barMax,
    configured: configErrors.length === 0,
    configErrors: configErrors.length ? configErrors : undefined,
    configWarnings: configWarnings.length ? configWarnings : undefined,
  });
});

// ── Leaderboard ──────────────────────────────────────────────────────────────

app.get('/api/leaderboard', async (req, res) => {
  const isAdmin = req.role === 'admin';

  try {
    const offices = selectOffices(req.query.office);
    const results = await Promise.allSettled(offices.map(syncOffice));

    const rows = [];
    const warnings = [];

    results.forEach((r, i) => {
      const office = offices[i];
      if (r.status === 'fulfilled') {
        rows.push(...r.value.rows);
        if (r.value.notice) warnings.push(r.value.notice);
      } else {
        // Serve the last good read rather than blanking the office.
        const stale = getStale(`office:${office.key}`);
        if (stale?.rows) {
          rows.push(...stale.rows);
          warnings.push(`${office.name}: showing cached data (${r.reason.message})`);
        } else {
          warnings.push(`${office.name}: ${r.reason.message}`);
        }
      }
    });

    const range = resolveRange({
      preset: req.query.preset,
      month: req.query.month,
      from: req.query.from,
      to: req.query.to,
      start: req.query.start,
      end: req.query.end,
    }, cfg.tz);

    const inRange = rows.filter((r) => {
      if (!r.fundedDate) return false;
      const d = new Date(r.fundedDate);
      return d >= range.start && d <= range.end;
    });

    /**
     * Lead-source filter runs after the date filter, but the source list below
     * is built from the unfiltered set — otherwise picking one source would
     * erase every other option from the dropdown.
     */
    const sourceFilter = String(req.query.source || '').trim();
    const filtered = sourceFilter && sourceFilter !== 'all'
      ? inRange.filter((r) => (r.source && r.source !== '—' ? r.source : 'Unattributed') === sourceFilter)
      : inRange;

    res.json({
      role: req.role,
      range: { label: range.label, preset: range.preset, start: range.start, end: range.end },
      offices: offices.map((o) => ({ key: o.key, name: o.name })),
      totals: buildTotals(filtered, { includeCommission: isAdmin }),
      leaderboard: aggregateByBroker(filtered, { includeCommission: isAdmin }),
      sources: summarizeBySource(inRange, { includeCommission: isAdmin }),
      appliedSource: sourceFilter || 'all',
      deals: buildDealRows(filtered, { includeCommission: isAdmin }),
      months: availableMonths(rows),
      warnings: warnings.length ? warnings : undefined,
      cache: cacheMeta(`office:${offices[0].key}`),
    });
  } catch (err) {
    console.error('leaderboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Receive one office's tab, pushed by the Apps Script inside that spreadsheet.
 *
 * This is the path that survives Google's sharing policy: the script runs as
 * the sheet's owner, so both spreadsheets stay private and nothing depends on
 * anonymous access being permitted.
 *
 * Auth is a shared secret in a header, not the admin password — the secret
 * lives in a script that everyone with sheet access can read.
 */
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many pushes. Slow the trigger down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/ingest/:office', ingestLimiter, ingestBodyParser, (req, res) => {
  if (!cfg.ingestSecret) {
    return res.status(503).json({ error: 'INGEST_SECRET is not set on the server.' });
  }

  const presented = req.get('X-Ingest-Secret') || req.body?.secret || '';
  if (!verifySharedSecret(presented, cfg.ingestSecret)) {
    logLine(`Rejected push for "${req.params.office}" — bad secret`);
    return res.status(401).json({ error: 'Bad or missing X-Ingest-Secret.' });
  }

  const office = cfg.offices.find((o) => o.key === String(req.params.office).toLowerCase());
  if (!office) {
    return res.status(404).json({
      error: `Unknown office "${req.params.office}". Expected one of: ${cfg.offices.map((o) => o.key).join(', ')}`,
    });
  }

  try {
    const summary = acceptPush(office.key, req.body);
    // Show the new data immediately instead of after the cache expires.
    invalidate(`office:${office.key}`);
    res.json({ ok: true, office: office.name, ...summary });
  } catch (err) {
    logLine(`[${office.name}] Push rejected: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/refresh', (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  invalidate('office:');
  res.json({ ok: true });
});

/**
 * Self-test: forces a fresh read and reports everything needed to diagnose it.
 * Authenticated by ?key= rather than the session cookie, because the cookie is
 * what fails inside an iframe — exactly when you need this most.
 */
app.get('/api/selftest', selftestLimiter, async (req, res) => {
  if (!verifyAdminPassword(req.query.key, cfg.adminPassword)) {
    return res.status(401).json({ error: 'Add ?key=<your ADMIN_PASSWORD> to this URL.' });
  }

  recentLogs.length = 0;
  invalidate('office:');

  const out = { startedAt: new Date().toISOString(), offices: [] };

  for (const office of cfg.offices) {
    const entry = { name: office.name, sheetId: office.sheetId, gid: office.sheetGid };
    try {
      // Same resolution the dashboard uses, so this reports the source actually
      // in play rather than testing a path the dashboard isn't taking.
      const { rows, meta, notice } = await readOfficeTable(
        office, (m) => logLine(`[${office.name}] ${m}`)
      );
      if (notice) entry.notice = notice;
      let named = canonicalizeBrokerNames(rows);

      // Report how lead sources resolved, since that's the part most likely
      // to look wrong without an explanation.
      entry.sources = { fromSheet: named.filter((r) => r.source && r.source !== '—').length };

      if (cfg.crmSourceLookup && office.token && office.locationId) {
        try {
          const map = await fetchSourceMap({
            token: office.token,
            locationId: office.locationId,
            officeName: office.name,
          });
          const applied = applySourceMap(named, map);
          named = applied.rows;
          entry.sources.crmNamesIndexed = map.size;
          entry.sources.filledFromCrm = applied.filled;
          entry.sources.stillUnattributed = applied.unmatched;
        } catch (err) {
          entry.sources.crmError = err.message;
        }
      } else {
        entry.sources.crmLookup = office.token && office.locationId
          ? 'disabled by CRM_SOURCE_LOOKUP'
          : 'not configured (no token / location id)';
      }

      const withOffice = named.map((r) => ({ ...r, officeName: office.name }));

      entry.ok = true;
      entry.readVia = meta.readVia;
      entry.headers = meta.headers;
      entry.columnsMatched = Object.keys(meta.columnsMatched);
      entry.hasSourceColumn = meta.hasSourceColumn;
      entry.totalRows = meta.totalSheetRows;
      entry.usableRows = meta.usableRows;
      entry.skipped = { noBroker: meta.skippedNoBroker, noDate: meta.skippedNoDate };
      entry.brokersSeen = [...new Set(withOffice.map((r) => r.broker))].sort();
      entry.totals = buildTotals(withOffice, { includeCommission: true });
      entry.consolidationDeals = withOffice.filter((r) => r.isConsolidation).length;
      entry.sampleRows = withOffice.slice(0, 3);
    } catch (err) {
      entry.ok = false;
      entry.error = err.message;
    }
    out.offices.push(entry);
  }

  out.pushes = pushStatus(cfg.offices.map((o) => o.key));
  out.config = {
    timezone: cfg.tz,
    cacheMinutes: cfg.cacheTtlMs / 60000,
    barMax: cfg.barMax,
    ingestConfigured: Boolean(cfg.ingestSecret),
    pushStaleMinutes: cfg.pushStaleMinutes,
    snapshotDir,
  };
  out.syncLog = recentLogs.slice();
  res.json(out);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(cfg.port, () => {
  console.log(`\n🏆 PCG Leaderboard (sheets) on port ${cfg.port}`);
  console.log(`   Offices:   ${cfg.offices.map((o) => o.name).join(', ')}`);
  console.log(`   Timezone:  ${cfg.tz}`);
  console.log(`   Cache TTL: ${cfg.cacheTtlMs / 60000} min`);
  console.log(`   Push:      ${cfg.ingestSecret
    ? `enabled — POST /api/ingest/{${cfg.offices.map((o) => o.key).join('|')}}`
    : 'disabled (INGEST_SECRET unset) — direct sheet reads only'}`);
  console.log(`   Snapshots: ${snapshotDir || 'none (no writable directory)'}\n`);
});

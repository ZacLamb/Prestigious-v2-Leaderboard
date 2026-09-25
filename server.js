import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig } from './src/config.js';
import { fetchSheetRows, canonicalizeBrokerNames } from './src/sheets.js';
import {
  buildTotals, aggregateByBroker, summarizeBySource, buildDealRows, availableMonths,
} from './src/aggregate.js';
import { resolveRange } from './src/dateRange.js';
import { cached, getStale, invalidate, cacheMeta } from './src/cache.js';
import { attachRole, createSession, clearSession, verifyAdminPassword } from './src/auth.js';

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

app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(express.json());
app.use(cookieParser());
app.use(attachRole(cfg.jwtSecret || 'unset-secret-config-invalid'));

// ── Data ─────────────────────────────────────────────────────────────────────

/** Read and normalize one office's sheet. Cached. */
async function syncOffice(office) {
  const key = `office:${office.key}`;

  const { value } = await cached(key, cfg.cacheTtlMs, async () => {
    const log = (m) => logLine(`[${office.name}] ${m}`);
    log('─'.repeat(50));
    log(`Reading sheet ${office.sheetId} (gid ${office.sheetGid})`);

    const { rows, meta } = await fetchSheetRows({
      sheetId: office.sheetId,
      gid: office.sheetGid,
      officeName: office.name,
      report: logLine,
    });

    log(`Read via ${meta.readVia} · columns matched: ${Object.keys(meta.columnsMatched).join(', ')}`);
    log(`${meta.usableRows} usable rows of ${meta.totalSheetRows}` +
        (meta.skippedNoDate ? `, ${meta.skippedNoDate} skipped (no date)` : '') +
        (meta.skippedNoBroker ? `, ${meta.skippedNoBroker} skipped (no broker)` : ''));

    if (!meta.hasSourceColumn) {
      log('No Source column in this sheet — lead sources will read as Unattributed.');
    }

    const named = canonicalizeBrokerNames(rows, log);
    const out = named.map((r) => ({ ...r, officeKey: office.key, officeName: office.name }));

    const funded = out.reduce((t, r) => t + r.fundedAmount, 0);
    const consol = out.reduce((t, r) => t + r.consolidationFunded, 0);
    log(`${out.length} deals · funded $${funded.toLocaleString()} · consolidation $${consol.toLocaleString()}`);

    return out;
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
        rows.push(...r.value);
      } else {
        // Serve the last good read rather than blanking the office.
        const stale = getStale(`office:${office.key}`);
        if (stale) {
          rows.push(...stale);
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
      const { rows, meta } = await fetchSheetRows({
        sheetId: office.sheetId,
        gid: office.sheetGid,
        officeName: office.name,
      });
      const named = canonicalizeBrokerNames(rows);
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

  out.config = { timezone: cfg.tz, cacheMinutes: cfg.cacheTtlMs / 60000, barMax: cfg.barMax };
  out.syncLog = recentLogs.slice();
  res.json(out);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(cfg.port, () => {
  console.log(`\n🏆 PCG Leaderboard (sheets) on port ${cfg.port}`);
  console.log(`   Offices:   ${cfg.offices.map((o) => o.name).join(', ')}`);
  console.log(`   Timezone:  ${cfg.tz}`);
  console.log(`   Cache TTL: ${cfg.cacheTtlMs / 60000} min\n`);
});

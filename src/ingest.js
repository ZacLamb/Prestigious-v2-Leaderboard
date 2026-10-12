/**
 * Pushed-sheet store.
 *
 * The pull path (reading docs.google.com directly) depends on each spreadsheet
 * being shared "anyone with the link". A Google Workspace admin policy that
 * forbids sharing outside the organization silently revokes that, and every
 * read then returns HTTP 401 — the dashboard goes stale through no fault of
 * its own and no amount of clicking in the Share dialog holds.
 *
 * So the data also arrives the other way round: an Apps Script inside each
 * spreadsheet posts its tab here on a timer. The script runs as the sheet's
 * owner, which makes sharing policy irrelevant and lets both sheets stay fully
 * private. Nothing needs a Workspace admin.
 *
 * Pushed tables are parsed by the same `parseTable` the pull path uses, so the
 * eight figures cannot depend on how the data got here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTable } from './sheets.js';

let report = (msg) => console.log(msg);
export function setIngestLogger(fn) { report = fn; }

/**
 * Where snapshots live.
 *
 * Without this, a Railway restart leaves the board blank until the next push —
 * up to a full trigger interval of an empty dashboard for something we already
 * had. The snapshot is a cache, not a database: losing it costs one cycle.
 */
function resolveDir() {
  const candidates = [
    process.env.INGEST_DIR,
    path.join(process.cwd(), '.data'),
    path.join(os.tmpdir(), 'pcg-ingest'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try the next one */ }
  }
  return null;
}

const DIR = resolveDir();

/** officeKey -> { values, receivedAt, tab, rowCount } */
const memory = new Map();

const snapshotPath = (officeKey) =>
  (DIR ? path.join(DIR, `push-${officeKey.replace(/[^a-z0-9_-]/gi, '')}.json`) : null);

function persist(officeKey, record) {
  const file = snapshotPath(officeKey);
  if (!file) return;
  try {
    // Write-then-rename: a restart mid-write would otherwise leave a truncated
    // file that parses as garbage, which is worse than having no snapshot.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
  } catch (err) {
    report(`Could not persist ${officeKey} snapshot (in-memory copy still live): ${err.message}`);
  }
}

function restore(officeKey) {
  const file = snapshotPath(officeKey);
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(record?.values) || record.values.length < 2) return null;
    return record;
  } catch (err) {
    report(`Ignoring unreadable ${officeKey} snapshot: ${err.message}`);
    return null;
  }
}

/** Reload snapshots from disk. Call once at boot. */
export function loadSnapshots(officeKeys) {
  const loaded = [];
  for (const key of officeKeys) {
    const record = restore(key);
    if (record) {
      memory.set(key, record);
      loaded.push(`${key} (${record.values.length - 1} rows, pushed ${record.receivedAt})`);
    }
  }
  if (loaded.length) report(`Restored pushed snapshots: ${loaded.join('; ')}`);
  else report('No pushed snapshots on disk yet — waiting for the first push.');
  return loaded.length;
}

/** The 2D grid of display values becomes the same shape the CSV path produces. */
function toTable(values) {
  return {
    cols: values[0].map((label) => ({ label: String(label ?? '') })),
    rows: values.slice(1).map((cells) => ({ c: (cells || []).map((v) => ({ v })) })),
  };
}

/**
 * Accept one office's pushed tab.
 *
 * Throws on anything that would make the board worse than leaving it alone —
 * notably an empty table, which is what a misfiring script or a cleared tab
 * looks like, and which would otherwise wipe a working dashboard.
 */
export function acceptPush(officeKey, payload) {
  const values = payload?.values;

  if (!Array.isArray(values) || !Array.isArray(values[0])) {
    throw new Error('Expected { values: [[header...], [row...], ...] }.');
  }
  if (values.length < 2) {
    throw new Error('Table has a header but no data rows — refusing to replace live data with an empty sheet.');
  }

  // Parse before storing: a push that can't be parsed is rejected loudly at the
  // moment it arrives, rather than breaking the next dashboard load.
  const { rows, meta } = parseTable(toTable(values));

  if (rows.length === 0) {
    throw new Error(
      `No usable rows: ${meta.skippedNoBroker} lacked a broker, ${meta.skippedNoDate} lacked a date. ` +
      `Headers seen: ${meta.headers.join(' | ')}`
    );
  }

  const previous = memory.get(officeKey);
  const record = {
    values,
    tab: payload.tab || null,
    receivedAt: new Date().toISOString(),
    rowCount: rows.length,
  };

  memory.set(officeKey, record);
  persist(officeKey, record);

  /**
   * A sharp drop usually means someone filtered or re-sorted the tab, or the
   * script is pointed at the wrong range. Accepted either way — the sheet is
   * the source of truth — but said out loud so it isn't discovered weeks later
   * in a leaderboard that quietly lost half its deals.
   */
  if (previous && rows.length < previous.rowCount * 0.5) {
    report(`⚠️  ${officeKey}: pushed rows dropped from ${previous.rowCount} to ${rows.length}. ` +
           'Accepted, but check the tab range in the Apps Script.');
  }

  report(`${officeKey}: accepted push — ${rows.length} usable rows of ${values.length - 1}` +
         (meta.hasSourceColumn ? ', Source column present' : ', no Source column'));

  return {
    officeKey,
    receivedAt: record.receivedAt,
    usableRows: rows.length,
    totalRows: values.length - 1,
    columnsMatched: Object.keys(meta.columnsMatched),
    headers: meta.headers,
    skipped: { noBroker: meta.skippedNoBroker, noDate: meta.skippedNoDate },
  };
}

/**
 * The latest pushed data for one office, parsed.
 * @returns {{rows, meta, receivedAt, ageMs}|null}
 */
export function getPushed(officeKey) {
  const record = memory.get(officeKey);
  if (!record) return null;

  const { rows, meta } = parseTable(toTable(record.values));
  return {
    rows,
    meta: { ...meta, readVia: 'push', tab: record.tab },
    receivedAt: record.receivedAt,
    ageMs: Date.now() - new Date(record.receivedAt).getTime(),
  };
}

/** Diagnostics: what has been pushed, and how long ago. */
export function pushStatus(officeKeys) {
  return officeKeys.map((key) => {
    const record = memory.get(key);
    if (!record) return { office: key, pushed: false };
    return {
      office: key,
      pushed: true,
      receivedAt: record.receivedAt,
      minutesAgo: Math.round((Date.now() - new Date(record.receivedAt).getTime()) / 60000),
      rows: record.rowCount,
      tab: record.tab,
    };
  });
}

export const snapshotDir = DIR;

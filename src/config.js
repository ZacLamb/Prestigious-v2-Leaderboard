/**
 * Configuration.
 *
 * This build reads the two commission spreadsheets and nothing else — no CRM,
 * no API tokens. Both sheets are baked in, so Railway only needs the two
 * secrets that guard commission data.
 */

const OFFICES = [
  {
    key: 'ny',
    name: 'New York',
    slug: 'NY',
    sheetId: '160-0nkSZ9641mTcGewLYIGTxU0rVP8OSEIqsuY_C6e0',
    // gid identifies the tab, so renaming it can't break the read.
    sheetGid: '644411698',
  },
  {
    key: 'miami',
    name: 'Miami',
    slug: 'MIAMI',
    sheetId: '1RIw6GEcvWaS77bw633YydoRuNsrqmyIuLrpElxpFzX8',
    sheetGid: '177844678',
  },
];

export function loadConfig() {
  const offices = OFFICES.map((o) => ({
    ...o,
    // Env overrides, in case a sheet is moved or a tab is rebuilt.
    sheetId: process.env[`${o.slug}_SHEET_ID`] || o.sheetId,
    sheetGid: process.env[`${o.slug}_SHEET_GID`] || o.sheetGid,
    /**
     * Optional GHL credentials. Used only to fill in a lead source where the
     * sheet has none — never for money, dates, brokers or lenders. Leave them
     * unset and the dashboard runs sheets-only exactly as before.
     */
    locationId: process.env[`${o.slug}_LOCATION_ID`] || null,
    token: process.env[`${o.slug}_TOKEN`] || null,
  }));

  return {
    offices,
    port: Number(process.env.PORT) || 3000,
    tz: process.env.REPORT_TZ || 'America/New_York',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    jwtSecret: process.env.JWT_SECRET || '',

    /**
     * Shared secret for POST /api/ingest/:office — the Apps Script push path.
     *
     * Deliberately not ADMIN_PASSWORD: this value is pasted into a script
     * inside a spreadsheet that the whole office can open, so it must not be
     * the credential that unlocks commission data.
     */
    ingestSecret: process.env.INGEST_SECRET || '',

    /**
     * How long pushed data stays trusted. Past this the dashboard says so in
     * the banner rather than presenting a silently frozen board as current —
     * a stopped trigger is otherwise invisible.
     */
    pushStaleMinutes: Number(process.env.PUSH_STALE_MINUTES) || 90,
    cacheTtlMs: (Number(process.env.CACHE_TTL_MINUTES) || 10) * 60 * 1000,
    // Revenue total that fills a broker's progress bar to 100%.
    barMax: Number(process.env.BAR_MAX) || 30000,

    // Set CRM_SOURCE_LOOKUP=false to turn the source backfill off without
    // removing the tokens.
    crmSourceLookup: String(process.env.CRM_SOURCE_LOOKUP || 'true').toLowerCase() !== 'false',
  };
}

/**
 * Blocking errors stop the dashboard; warnings are shown but let it run.
 */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];

  if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) {
    errors.push(
      'JWT_SECRET must be a random string of at least 32 characters. Generate one with: openssl rand -base64 32'
    );
  }

  if (!cfg.adminPassword) {
    errors.push('ADMIN_PASSWORD must be set — commission data is gated behind it.');
  } else if (cfg.adminPassword.length < 12) {
    warnings.push('ADMIN_PASSWORD is short. Use at least 12 characters — this guards commission data.');
  }

  if (!cfg.ingestSecret) {
    warnings.push(
      'INGEST_SECRET is not set, so the Apps Script push path is disabled and the app ' +
      'can only read the sheets if both are shared "anyone with the link". Set it to ' +
      'keep working when sharing is locked down.'
    );
  } else if (cfg.ingestSecret.length < 24) {
    warnings.push('INGEST_SECRET is short. Use at least 24 random characters.');
  } else if (cfg.adminPassword && cfg.ingestSecret === cfg.adminPassword) {
    errors.push(
      'INGEST_SECRET must not equal ADMIN_PASSWORD. The ingest secret is pasted into ' +
      'a script inside the spreadsheet, where anyone with sheet access can read it — ' +
      'it would hand them the commission data.'
    );
  }

  return { errors, warnings };
}

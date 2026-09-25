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
  }));

  return {
    offices,
    port: Number(process.env.PORT) || 3000,
    tz: process.env.REPORT_TZ || 'America/New_York',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    jwtSecret: process.env.JWT_SECRET || '',
    cacheTtlMs: (Number(process.env.CACHE_TTL_MINUTES) || 10) * 60 * 1000,
    // Revenue total that fills a broker's progress bar to 100%.
    barMax: Number(process.env.BAR_MAX) || 30000,
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

  return { errors, warnings };
}

# PCG Commission Leaderboard

Broker leaderboard for Prestigious Capital Group's **New York** and **Miami**
offices, built entirely from the two commission spreadsheets. No CRM
connection, no API tokens.

Toggle between New York, Miami, or a combined **Joint** view.

---

## Setup

### 1. Share both spreadsheets

This is the only prerequisite. In each sheet:

**File → Share → General access → Anyone with the link → Viewer**

Without it the app can't read them. Both sheet IDs and tab gids are baked into
`src/config.js`, so there's nothing to paste.

### 2. Push to GitHub, deploy on Railway

New Project → Deploy from GitHub repo. Railway detects Node and runs
`npm start`.

### 3. Set two variables

```
ADMIN_PASSWORD = <unlocks commission columns>
JWT_SECRET     = <random 32+ chars — openssl rand -base64 32>
```

Then **Settings → Networking → Generate Domain**.

---

## The eight figures

| Card | What it counts |
|---|---|
| Total Funded | `Funded Amount` only — **excludes** consolidation |
| # of Deals Funded | every row in range, consolidation included |
| Active Brokers | distinct brokers with a deal in range |
| Total Fees | the `FEE` column on **every** row, regular or consolidation |
| Commissions | `Commision Amount` only — **excludes** consolidation |
| Commission + Fee | Commissions + Total Fees |
| Total Consolidation Funded | `Total Consolidation Funded` |
| Total Consolidation Commision | `Total Consolidation Commision` |

Consolidation money is never folded into the regular totals. Each money column
is read independently, so a row can carry regular and consolidation figures at
once without either absorbing the other.

Fees are a single pool by design: a fee counts in Total Fees regardless of
which kind of deal it came from.

---

## Access levels

| | Viewer | Admin |
|---|---|---|
| Funded, deals, brokers, fees | ✅ | ✅ |
| Consolidation Funded | ✅ | ✅ |
| Commissions, Commission + Fee | ❌ | ✅ |
| Consolidation Commision | ❌ | ✅ |
| Force refresh, self-test | ❌ | ✅ |

Gated figures are omitted from the API response rather than hidden in the UI,
so there's nothing to recover in devtools.

**Ranking:** admins rank by total revenue (commission + fees + consolidation
commission). Viewers don't receive commission, so they rank by funded volume
including consolidation.

---

## Filters

- **Office** — New York, Miami, Joint
- **Period** — MTD, 30/60/90 days, Last Month, YTD
- **Month** — any single month present in the data
- **Range** — any span of months, inclusive
- **Lead Source** — rescopes the whole board

Date boundaries are computed in `REPORT_TZ` (Eastern), not the server's
timezone, so a container in UTC still agrees with the office about which deals
belong to "this month".

**Deal Detail** has its own filters: a search box covering business, broker,
lender and source; multi-select checkboxes for brokers and lenders; and
sortable columns.

---

## Columns it reads

Matched by header text, not position, so column order can change safely:

`DATE` · `Broker Name` · `Business Name` · `Funded Amount` ·
`Commision Amount` · `Payout` · `Date Paid` · `Clawback` · `FEE` ·
`lender/s` · `DID WE GET PAID` · `Total Consolidation Funded` ·
`Total Consolidation Commision` · `Source` (optional) · `notes` (optional)

A row needs a **Broker Name** and a **DATE** to count. Rows missing either are
skipped — that's how repeated header rows and half-filled rows stay out.

**Lead source:** neither sheet currently has a Source column, so every deal
reads as "Unattributed". Add a column headed `Source` or `Lead Source` to
either sheet and it's picked up automatically — no code change.

---

## Broker names

The sheets record first names, and the same person sometimes appears as `Ari`
and `ari`. Since the board groups by name, that would split one rep across two
rows — so casing is normalized before grouping (`JAMES` → `James`).

Entries naming two people, like `Jack/sean`, are left as their own row rather
than guessed at.

Headshots are mapped by first name in `public/app.js`:

```js
const BROKER_PHOTOS = { ari: 'https://…', vanessa: 'https://…' };
```

A photo that fails to load falls back to initials.

---

## Self-test

```
https://<your-app>.up.railway.app/api/selftest?key=YOUR_ADMIN_PASSWORD
```

Forces a fresh read and returns, per office: whether the sheet loaded, its
headers, which columns matched, usable vs skipped rows, every broker name seen,
the eight totals, and the sync log. If a sheet fails, `error` names the cause —
a sign-in wall, a permissions error and a bad gid are reported distinctly.

It authenticates on `?key=` rather than the session cookie, because the cookie
is what fails inside a GHL iframe — exactly when you need this most.

---

## Caching

Each office's sheet is cached for 10 minutes, with concurrent requests sharing
one read. If a sheet read fails, the last good data is served with a banner
rather than the office going blank. Admins can force a refresh from the
dashboard; the self-test URL also clears it.

---

## Project layout

```
server.js           Express app, routes, auth wiring
src/config.js       Offices, sheet IDs, validation
src/sheets.js       gviz reader, column matching, row parsing
src/aggregate.js    The eight figures, rankings, source summary
src/dateRange.js    Timezone-correct period resolution
src/auth.js         Session cookies, admin password check
src/cache.js        TTL cache with single-flight
public/             Frontend — vanilla JS, no build step
```

## Local development

```
npm install
cp .env.example .env   # fill in the two values
npm run dev
```

Runs on http://localhost:3000.

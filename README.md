# PCG Commission Leaderboard

Broker leaderboard for Prestigious Capital Group's **New York** and **Miami**
offices, built entirely from the two commission spreadsheets. No CRM
connection, no API tokens.

Toggle between New York, Miami, or a combined **Joint** view.

---

## How the data gets here

Two paths, and the app prefers whichever has fresh data.

**Push (recommended).** An Apps Script inside each spreadsheet posts its tab to
`/api/ingest/{ny|miami}` every 15 minutes. The script runs as the sheet's owner,
so **both spreadsheets stay completely private** and no sharing setting can
break it.

**Pull (fallback).** The app reads `docs.google.com` directly. This needs the
file shared *anyone with the link*, which a Google Workspace policy forbidding
external sharing silently revokes — every read then returns HTTP 401 and the
board freezes. That's the failure the push path exists for.

When a push goes stale the trigger has probably stopped, so a direct read is
tried before falling back to the old push. A stalled trigger therefore heals
itself if sharing happens to be open, and still shows data — with a banner
naming the stalled script — if it isn't.

---

## Setup

### 1. Deploy

New Project → Deploy from GitHub repo. Railway detects Node and runs
`npm start`. Then **Settings → Networking → Generate Domain**.

Both sheet IDs and tab gids are baked into `src/config.js`, so there's nothing
to paste for those.

### 2. Set three variables

```
ADMIN_PASSWORD = <unlocks commission columns>
JWT_SECRET     = <random 32+ chars — openssl rand -base64 32>
INGEST_SECRET  = <random 24+ chars — openssl rand -hex 24>
```

`INGEST_SECRET` must not equal `ADMIN_PASSWORD`. It gets pasted into a script
inside a spreadsheet that the whole office can open, so it must not be the
credential that unlocks commission data — the app refuses to start if the two
match.

### 3. Install the push script in each spreadsheet

`appsscript/pcg-push.gs` carries its own instructions. In short, for each of
the two sheets:

1. **Extensions → Apps Script**
2. **+ → Script**, name it `PCGPush` — as a **new file**. Don't paste over the
   scripts already in there; the submission and consolidation logic is
   unrelated and has to stay.
3. Paste the file in, fill in `APP_URL`, `OFFICE` (`ny` or `miami`),
   `SECRET` and `TAB_GID`.
4. Run `pcgPushNow` once and approve the permission prompt.
5. Run `pcgInstallTrigger` once.

`pcgDiagnose` prints what the script sees — tab, row count, headers,
destination — without sending anything.

Google emails the sheet owner if a scheduled push ever fails, because the
script throws rather than logging. A push that stops is otherwise invisible.

### Optional: share the sheets too

If link sharing is permitted in your Workspace, setting each sheet to
**File → Share → General access → Anyone with the link → Viewer** gives the app
a second way in. Not required, and the push path doesn't care either way.

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

**Lead source** comes from a `Source` (or `Lead Source`) column in the sheet,
picked up automatically wherever you put it.

Where that cell is blank, the dashboard can optionally fill it from GoHighLevel
— see below. A deal with no source in either place groups as "Unattributed"
rather than disappearing, so source totals always reconcile to the overall
totals.

---

## Optional: lead sources from the CRM

Set the four GHL variables in `.env.example` and blank Source cells get filled
from the CRM. This is the **only** thing the CRM is used for — every figure
still comes from the sheet, and the sheet's own Source value always wins.

Matching is by business name, since that's the only key the two systems share.
Names are normalized before comparing: case, punctuation, legal suffixes
(`LLC`, `Inc`, `Co`) and punctuated initials are all collapsed, so
`THOMAS E. TUREK, M.D., LLC` matches `Thomas E Turek MD LLC`.

Two deliberate refusals:

- A business name that resolves to **two different sources** in the CRM is
  skipped rather than guessed. Mis-attributing a deal silently skews the
  channel numbers, which is worse than leaving it blank.
- A sheet row with no CRM counterpart stays Unattributed.

If GHL is unreachable the lookup is skipped and the sheet data loads normally —
a CRM outage can't take the dashboard down.

`/api/selftest` reports, per office: how many sources came from the sheet, how
many names the CRM indexed, how many blanks were filled, and how many are still
unattributed.

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

Forces a fresh read and returns, per office: **which source the data came
from** (`readVia: "push"` or `"gviz"`/`"csv"`), when each sheet last pushed,
its headers, which columns matched, usable vs skipped rows, every broker name
seen, the eight totals, and the sync log. If a sheet fails, `error` names the
cause — a sign-in wall, a permissions error and a bad gid are reported
distinctly.

`readVia: "csv"` where you expected `"push"` means that sheet's trigger isn't
running. `pushes[]` gives each office's last push time in minutes.

It authenticates on `?key=` rather than the session cookie, because the cookie
is what fails inside a GHL iframe — exactly when you need this most.

---

## Caching

Each office is cached for 10 minutes, with concurrent requests sharing one
read. An incoming push clears that office's cache immediately, so pushed data
shows up at once rather than up to 10 minutes later.

If a read fails, the last good data is served with a banner rather than the
office going blank. Pushed tables are also written to `.data/` on disk, so a
Railway restart recovers instantly instead of showing an empty board until the
next trigger fires. That file is a cache — losing it costs one push cycle — and
it's gitignored, since it holds commission figures.

Admins can force a refresh from the dashboard; the self-test URL also clears it.

---

## Project layout

```
server.js             Express app, routes, auth wiring
src/config.js         Offices, sheet IDs, validation
src/sheets.js         Sheet reader + parseTable (column matching, row parsing)
src/ingest.js         Pushed-sheet store, disk snapshots
src/aggregate.js      The eight figures, rankings, source summary
src/dateRange.js      Timezone-correct period resolution
src/crm.js            Optional GHL lead-source backfill
src/auth.js           Session cookies, admin password, ingest secret
src/cache.js          TTL cache with single-flight
appsscript/           The Apps Script to paste into each spreadsheet
public/               Frontend — vanilla JS, no build step
```

Both paths parse through the same `parseTable`, so the eight figures can't
depend on how the data arrived.

## Local development

```
npm install
cp .env.example .env   # fill in the two values
npm run dev
```

Runs on http://localhost:3000.

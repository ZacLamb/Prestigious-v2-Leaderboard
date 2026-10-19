/**
 * Data-quality checks on the rows a sheet produced.
 *
 * These never change a figure. They exist because the two failures found in
 * production were both silent: a row double-counted across the regular and
 * consolidation columns, and a sheet quietly dropping rows that had no date.
 * Both showed up as plausible-looking numbers, which is the worst way for a
 * commission report to be wrong.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  These strings go into the dashboard's warning banner, which EVERY viewer
 *  sees. The payload rule for this app is that commission figures are never
 *  computed into a viewer's response at all — and a warning string is part of
 *  that response. So no commission amount may appear here unless the caller
 *  passes includeCommission, which only the admin path and the
 *  password-gated self-test do. A number baked into prose can't be stripped
 *  downstream, so the gate has to be here.
 * ──────────────────────────────────────────────────────────────────────────
 */

const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Rows are anchored at midday UTC, so UTC parts give the calendar date. */
const onDate = (iso) => {
  if (!iso) return 'no date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'no date';
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const monthOf = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * Rows carrying BOTH regular and consolidation money.
 *
 * The rule for this board is that consolidation funded and commission never
 * enter Total Funded or Commissions. A row with money in both sets of columns
 * breaks that: the same dollars are reported twice, once in each card.
 *
 * `identicalFunded` / `identicalCommission` mark the strong case — the exact
 * same amount in both columns, which is duplication rather than a deal that
 * genuinely did both. A row with two *different* amounts might be a real
 * combined deal, so the two cases are worded differently below.
 */
export function findOverlapRows(rows) {
  const out = [];

  for (const r of rows || []) {
    const hasRegular = (r.fundedAmount || 0) > 0 || (r.commission || 0) > 0;
    const hasConsolidation = (r.consolidationFunded || 0) > 0 || (r.consolidationCommission || 0) > 0;
    if (!hasRegular || !hasConsolidation) continue;

    out.push({
      date: r.fundedDate,
      broker: r.broker,
      businessName: r.businessName,
      fundedAmount: r.fundedAmount || 0,
      commission: r.commission || 0,
      consolidationFunded: r.consolidationFunded || 0,
      consolidationCommission: r.consolidationCommission || 0,
      identicalFunded: (r.fundedAmount || 0) > 0 && r.fundedAmount === r.consolidationFunded,
      identicalCommission: (r.commission || 0) > 0 && r.commission === r.consolidationCommission,
    });
  }

  return out;
}

/**
 * Warnings naming the offending deals, so the fix can be made in the sheet
 * without hunting for the row.
 *
 * Returns an array because the confident case (identical amounts in both
 * columns — certainly duplication) and the uncertain case (two different
 * amounts — possibly a real combined deal) deserve different wording, and
 * stating the second as if it were the first would send someone to "fix" a
 * correct row.
 *
 * @param {boolean} includeCommission admin only — see the note at the top.
 */
export function describeOverlaps(officeName, overlaps, { includeCommission = false } = {}) {
  if (!overlaps?.length) return [];

  const describe = (o) => {
    const parts = [];
    if (o.fundedAmount) parts.push(`${money(o.fundedAmount)} funded`);
    if (o.consolidationFunded) parts.push(`${money(o.consolidationFunded)} consolidation funded`);
    if (includeCommission) {
      if (o.commission) parts.push(`${money(o.commission)} commission`);
      if (o.consolidationCommission) parts.push(`${money(o.consolidationCommission)} consolidation commission`);
    }
    const amounts = parts.length ? `: ${parts.join(' + ')}` : '';
    return `${o.businessName} (${onDate(o.date)}, ${o.broker})${amounts}`;
  };

  const list = (rows) => {
    const named = rows.slice(0, 3).map(describe).join('; ');
    return rows.length > 3 ? `${named} …and ${rows.length - 3} more` : named;
  };

  const warnings = [];
  const duplicated = overlaps.filter((o) => o.identicalFunded || o.identicalCommission);
  const ambiguous = overlaps.filter((o) => !(o.identicalFunded || o.identicalCommission));

  if (duplicated.length) {
    /**
     * The overstatement is attributed to the month the row falls in. The check
     * runs over the office's whole history, but Total Funded on screen covers
     * only the selected period — so an unqualified "overstated by $106,000"
     * would sit next to a card containing none of it.
     */
    const byMonth = new Map();
    for (const o of duplicated) {
      if (!o.identicalFunded) continue;
      const m = monthOf(o.date) || 'an undated row';
      byMonth.set(m, (byMonth.get(m) || 0) + o.fundedAmount);
    }

    const impact = byMonth.size
      ? ' Total Funded is overstated by ' +
        [...byMonth].map(([m, amt]) => `${money(amt)} in ${m}`).join(' and ') + '.'
      : '';

    const plural = duplicated.length === 1 ? 'deal has' : 'deals have';
    warnings.push(
      `${officeName}: ${duplicated.length} ${plural} the same amount in both the regular and ` +
      `consolidation columns, so the same dollars are counted twice.${impact} ` +
      `Consolidation amounts belong only in the consolidation columns. ${list(duplicated)}`
    );
  }

  if (ambiguous.length) {
    const plural = ambiguous.length === 1 ? 'deal carries' : 'deals carry';
    warnings.push(
      `${officeName}: ${ambiguous.length} ${plural} both a regular and a consolidation amount on ` +
      `one row. If that row is a single consolidation, the regular columns should be empty; if it ` +
      `really was both, it is fine as recorded — worth a look either way. ${list(ambiguous)}`
    );
  }

  return warnings;
}

/**
 * Rows the sheet produced but the parser couldn't use.
 *
 * Only `skippedNoDate` triggers this. A row counted there had a broker name
 * and no date, which means it has content — that is what caught Miami dropping
 * 6 of 14 rows. `skippedNoBroker` is mostly blank formatting rows, so
 * thresholding on it produces a warning on perfectly good sheets.
 *
 * Any single content-bearing row that fell out is worth saying, because on a
 * commission report a dropped row is a missing deal.
 */
export function describeSkipped(officeName, meta = {}, { minRows = 1 } = {}) {
  const noDate = meta.skippedNoDate || 0;
  const total = meta.totalSheetRows || 0;
  if (noDate < minRows || !total) return null;

  const share = Math.round((noDate / total) * 100);
  const plural = noDate === 1 ? 'row' : 'rows';
  // A sub-1% loss shouldn't be dressed up with a "0%".
  const pct = share >= 1 ? ` (${share}% of the tab)` : '';

  return `${officeName}: ${noDate} ${plural} of ${total} had a broker name but no date, so ` +
         `${noDate === 1 ? 'it was' : 'they were'} left out of every figure${pct}. ` +
         `Check ${noDate === 1 ? "it isn't a real deal" : "none of them are real deals"}.`;
}

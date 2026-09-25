/**
 * Rolls deal rows into the dashboard's figures.
 *
 * Two rules shape everything here:
 *
 *  1. Consolidation money is reported separately. Consolidation funded and
 *     consolidation commission never enter Total Funded or Commissions.
 *  2. Fees are a single pool. Every fee counts in Total Fees whether the deal
 *     was regular or consolidation.
 *
 * Access: commission figures (regular and consolidation) are admin-only, and
 * are omitted from the payload entirely rather than hidden in the UI. Fees and
 * funded volume are visible to everyone.
 */

const round = (n) => Math.round(n * 100) / 100;

/** The eight headline figures, gated by role. */
export function buildTotals(rows, { includeCommission }) {
  const sum = (key) => rows.reduce((t, r) => t + (r[key] || 0), 0);

  const totals = {
    fundedAmount: round(sum('fundedAmount')),
    deals: rows.length,
    brokers: new Set(rows.map((r) => r.broker)).size,
    fee: round(sum('fee')),
    consolidationFunded: round(sum('consolidationFunded')),
  };

  if (includeCommission) {
    totals.commission = round(sum('commission'));
    totals.consolidationCommission = round(sum('consolidationCommission'));
    // "Commission + Fees" — regular commission plus the whole fee pool.
    totals.commissionPlusFee = round(totals.commission + totals.fee);
    // Everything the office earned, used for ranking.
    totals.revenue = round(totals.commission + totals.fee + totals.consolidationCommission);
  }

  return totals;
}

/** Per-broker rows for the rankings table. */
export function aggregateByBroker(rows, { includeCommission }) {
  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.broker)) {
      map.set(r.broker, {
        broker: r.broker,
        deals: 0,
        fundedAmount: 0,
        commission: 0,
        fee: 0,
        consolidationFunded: 0,
        consolidationCommission: 0,
        consolidationDeals: 0,
        offices: new Set(),
        lenders: new Set(),
      });
    }

    const b = map.get(r.broker);
    b.deals += 1;
    b.fundedAmount += r.fundedAmount || 0;
    b.commission += r.commission || 0;
    b.fee += r.fee || 0;
    b.consolidationFunded += r.consolidationFunded || 0;
    b.consolidationCommission += r.consolidationCommission || 0;
    if (r.isConsolidation) b.consolidationDeals += 1;
    b.offices.add(r.officeName);
    if (r.lender && r.lender !== '—') b.lenders.add(r.lender);
  }

  const out = [...map.values()].map((b) => {
    const base = {
      broker: b.broker,
      deals: b.deals,
      fundedAmount: round(b.fundedAmount),
      fee: round(b.fee),
      consolidationFunded: round(b.consolidationFunded),
      consolidationDeals: b.consolidationDeals,
      offices: [...b.offices],
      lenderCount: b.lenders.size,
    };

    if (includeCommission) {
      base.commission = round(b.commission);
      base.consolidationCommission = round(b.consolidationCommission);
      base.commissionPlusFee = round(b.commission + b.fee);
      base.revenue = round(b.commission + b.fee + b.consolidationCommission);
    }

    return base;
  });

  /**
   * Admins rank by total revenue — commission plus fees plus consolidation
   * commission, i.e. everything the rep brought in. Viewers don't receive
   * commission at all, so they rank by funded volume instead.
   */
  out.sort((a, b) =>
    includeCommission
      ? b.revenue - a.revenue || b.fundedAmount - a.fundedAmount
      : (b.fundedAmount + b.consolidationFunded) - (a.fundedAmount + a.consolidationFunded)
        || b.deals - a.deals
  );

  return out;
}

/** Funded volume and deal count grouped by lead source, biggest first. */
export function summarizeBySource(rows, { includeCommission }) {
  const map = new Map();

  for (const r of rows) {
    const key = r.source && r.source !== '—' ? r.source : 'Unattributed';
    if (!map.has(key)) {
      map.set(key, {
        source: key, deals: 0, fundedAmount: 0, commission: 0,
        fee: 0, consolidationFunded: 0, consolidationCommission: 0,
      });
    }
    const s = map.get(key);
    s.deals += 1;
    s.fundedAmount += r.fundedAmount || 0;
    s.commission += r.commission || 0;
    s.fee += r.fee || 0;
    s.consolidationFunded += r.consolidationFunded || 0;
    s.consolidationCommission += r.consolidationCommission || 0;
  }

  return [...map.values()]
    .map((s) => {
      const base = {
        source: s.source,
        deals: s.deals,
        fundedAmount: round(s.fundedAmount),
        fee: round(s.fee),
        consolidationFunded: round(s.consolidationFunded),
      };
      if (includeCommission) {
        base.commission = round(s.commission);
        base.consolidationCommission = round(s.consolidationCommission);
        base.revenue = round(s.commission + s.fee + s.consolidationCommission);
      }
      return base;
    })
    .sort((a, b) =>
      (b.fundedAmount + b.consolidationFunded) - (a.fundedAmount + a.consolidationFunded)
      || b.deals - a.deals);
}

/** Deal-level rows for the detail table, with commission stripped for viewers. */
export function buildDealRows(rows, { includeCommission }) {
  return rows
    .map((r) => {
      const base = {
        broker: r.broker,
        businessName: r.businessName,
        fundedAmount: r.fundedAmount,
        fee: r.fee,
        consolidationFunded: r.consolidationFunded,
        isConsolidation: r.isConsolidation,
        lender: r.lender,
        source: r.source,
        fundedDate: r.fundedDate,
        officeName: r.officeName,
      };
      if (includeCommission) {
        base.commission = r.commission;
        base.consolidationCommission = r.consolidationCommission;
      }
      return base;
    })
    .sort((a, b) => new Date(b.fundedDate) - new Date(a.fundedDate));
}

/** Months present in the data, newest first, for the month picker. */
export function availableMonths(rows) {
  const seen = new Map();

  for (const r of rows) {
    if (!r.fundedDate) continue;
    const d = new Date(r.fundedDate);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  return [...seen.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

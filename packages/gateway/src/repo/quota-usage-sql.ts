import { addUsageCharges, quotaUsageBounds, usageChargeForTerms } from './quota-usage.ts';
import type { QuotaUsageWindow, UsageSettlement } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { addDecimalStrings, multiplyDecimalStrings } from '@floway-dev/protocols/common';

const settlementColumns = 'id, key_id AS keyId, upstream, timestamp, spent_usd AS spentUsd, unpriced';
type SettlementRow = Omit<UsageSettlement, 'unpriced'> & { unpriced: 0 | 1 };

export const usageSettlementUpsert = (db: SqlDatabase, record: UsageSettlement) => db.prepare(`
  INSERT INTO usage_settlements (id, key_id, upstream, timestamp, spent_usd, unpriced) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET key_id = excluded.key_id, upstream = excluded.upstream,
    timestamp = excluded.timestamp, spent_usd = excluded.spent_usd, unpriced = excluded.unpriced
`).bind(record.id, record.keyId, record.upstream, record.timestamp, record.spentUsd, Number(record.unpriced));

export const listUsageSettlements = async (db: SqlDatabase): Promise<UsageSettlement[]> => {
  const { results } = await db.prepare(`SELECT ${settlementColumns} FROM usage_settlements ORDER BY timestamp, id`).all<SettlementRow>();
  return results.map(row => ({ ...row, unpriced: row.unpriced === 1 }));
};

export const querySqlQuotaUsage = async (db: SqlDatabase, window: QuotaUsageWindow) => {
  const { boundary, firstFullHour, endHour } = quotaUsageBounds(window);
  const scoped = window.upstreamId === null ? '' : 'AND upstream = ?';
  const upstreamParams = window.upstreamId === null ? [] : [window.upstreamId];
  // Historical pricing remains authoritative for the complete hours. Only
  // the first, split hour uses request settlements; the two ranges are disjoint.
  const { results: hours } = await db.prepare(`
    SELECT quantity, unit_price AS unitPrice, COUNT(*) AS occurrences FROM usage
    WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ?)
      AND hour >= ? AND hour < ? ${scoped}
    GROUP BY quantity, unit_price
  `).bind(window.userId, firstFullHour, endHour, ...upstreamParams)
    .all<{ quantity: string; unitPrice: string | null; occurrences: number }>();
  const hourly = usageChargeForTerms(hours);
  if (boundary === null) return { ...hourly, partialHistory: false };

  // The bucket count and the matching timed settlements are compared in one
  // snapshot. A legacy request without a timestamp is never charged to a
  // cycle that began partway through its hour.
  const { results: tail } = await db.prepare(`
    WITH keys AS MATERIALIZED (SELECT id FROM api_keys WHERE user_id = ?),
    timed AS MATERIALIZED (
      SELECT timestamp, spent_usd, unpriced FROM usage_settlements
      WHERE key_id IN keys AND timestamp >= ? AND timestamp < ? ${scoped}
    )
    SELECT spent_usd AS spentUsd, unpriced, COUNT(*) AS count, 0 AS missing
    FROM timed WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY spent_usd, unpriced
    UNION ALL
    SELECT '0', 0, 0, (
      SELECT COALESCE(SUM(requests), 0) FROM usage_requests
      WHERE key_id IN keys AND hour = ? ${scoped}
    ) > (SELECT COUNT(*) FROM timed)
  `).bind(window.userId, boundary.from, boundary.end, ...upstreamParams, window.start, window.through, boundary.hour, ...upstreamParams)
    .all<{ spentUsd: string; unpriced: 0 | 1; count: number; missing: 0 | 1 }>();
  let spentUsd = '0';
  let unpriced = false;
  let partialHistory = false;
  for (const row of tail) {
    spentUsd = addDecimalStrings(spentUsd, multiplyDecimalStrings(row.spentUsd, String(row.count)));
    unpriced ||= row.unpriced === 1;
    partialHistory ||= row.missing === 1;
  }
  return { ...addUsageCharges(hourly, { spentUsd, unpriced }), partialHistory };
};

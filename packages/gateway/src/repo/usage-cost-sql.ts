import type { UsageRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { addDecimalStrings, decimalStringIsZero, multiplyDecimalStrings, parseNonNegativeDecimalString } from '@floway-dev/protocols/common';

interface CostTerm { quantity: string; unitPrice: string | null; occurrences: number }

export const sumUsageCostTerms = (terms: readonly CostTerm[]): string | null => {
  if (terms.length === 0) return null;
  let cost = '0';
  for (const term of terms) {
    if (!Number.isSafeInteger(term.occurrences) || term.occurrences <= 0) throw new RangeError('Usage cost occurrence count must be a positive safe integer');
    const quantity = parseNonNegativeDecimalString(term.quantity, 'usage cost quantity');
    if (decimalStringIsZero(quantity)) continue;
    if (term.unitPrice === null) return null;
    const price = parseNonNegativeDecimalString(term.unitPrice, 'usage cost unit price');
    cost = addDecimalStrings(cost, multiplyDecimalStrings(multiplyDecimalStrings(quantity, price), String(term.occurrences)));
  }
  return cost;
};

export const querySqlUsageCost = async (db: SqlDatabase, { upstreamId, start, end }: Parameters<UsageRepo['queryCost']>[0]): Promise<string | null> => {
  const [{ results }, missing] = await Promise.all([
    db.prepare(`SELECT quantity, unit_price AS unitPrice, COUNT(*) AS occurrences FROM usage
      WHERE upstream = ? AND hour >= ? AND hour < ? GROUP BY quantity, unit_price`)
      .bind(upstreamId, start, end).all<CostTerm>(),
    db.prepare(`SELECT 1 AS missing FROM usage_requests request
      WHERE request.upstream = ? AND request.hour >= ? AND request.hour < ? AND request.requests > 0
        AND NOT EXISTS (SELECT 1 FROM usage metric WHERE metric.key_id = request.key_id
          AND metric.model = request.model AND metric.upstream = request.upstream AND metric.model_key = request.model_key
          AND metric.hour = request.hour AND metric.pricing_selector = request.pricing_selector) LIMIT 1`)
      .bind(upstreamId, start, end).first<{ missing: number }>(),
  ]);
  return missing === null ? sumUsageCostTerms(results) : null;
};

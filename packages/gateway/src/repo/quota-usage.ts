import type { QuotaUsageWindow, UsageCharge, UsageRecord, UsageSettlement } from './types.ts';
import { addDecimalStrings, decimalStringIsZero, multiplyDecimalStrings, parseNonNegativeDecimalString, TELEMETRY_HOUR_MS, telemetryHourKey } from '@floway-dev/protocols/common';

const floorHour = (timestamp: number) => Math.floor(timestamp / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS;
export const usageHourAt = (timestamp: number) => telemetryHourKey(floorHour(timestamp));

export const quotaUsageBounds = ({ start, through }: QuotaUsageWindow) => {
  const hourStart = floorHour(start);
  const boundary = hourStart === start ? null : {
    hour: telemetryHourKey(hourStart),
    from: hourStart,
    end: hourStart + TELEMETRY_HOUR_MS,
  };
  return {
    boundary,
    firstFullHour: telemetryHourKey(boundary?.end ?? start),
    endHour: telemetryHourKey(floorHour(through) + TELEMETRY_HOUR_MS),
  };
};

export const assertSettlementForUsage = (record: UsageRecord, settlement: UsageSettlement): void => {
  if (record.requests !== 1 || record.keyId !== settlement.keyId || record.upstream !== settlement.upstream
    || record.hour !== usageHourAt(settlement.timestamp)) {
    throw new TypeError('Floway: usage settlement must match one request in its hourly bucket');
  }
};

export const addUsageCharges = (a: UsageCharge, b: UsageCharge): UsageCharge => ({
  spentUsd: addDecimalStrings(a.spentUsd, b.spentUsd),
  unpriced: a.unpriced || b.unpriced,
});

export const usageChargeForTerms = (terms: readonly { quantity: string; unitPrice: string | null; occurrences: number }[]): UsageCharge => {
  let spentUsd = '0';
  let unpriced = false;
  for (const { quantity: raw, unitPrice, occurrences } of terms) {
    if (!Number.isSafeInteger(occurrences) || occurrences <= 0) throw new RangeError('Invalid usage cost occurrence count');
    const quantity = parseNonNegativeDecimalString(raw, 'usage cost quantity');
    if (decimalStringIsZero(quantity)) continue;
    if (unitPrice === null) unpriced = true;
    else spentUsd = addDecimalStrings(spentUsd, multiplyDecimalStrings(
      multiplyDecimalStrings(quantity, parseNonNegativeDecimalString(unitPrice, 'usage cost unit price')),
      String(occurrences),
    ));
  }
  return { spentUsd, unpriced };
};

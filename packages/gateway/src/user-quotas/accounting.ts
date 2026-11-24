import { readQuotaPeriod } from './period.ts';
import type { QuotaRecord } from './schema.ts';
import { addUsageCharges } from '../repo/quota-usage.ts';
import type { Repo, UsageCharge, UsageMetricRecord } from '../repo/types.ts';
import { addDecimalStrings, compareDecimalStrings, decimalStringIsZero, divideDecimalString, multiplyDecimalStrings } from '@floway-dev/protocols/common';

export const USER_QUOTA_MESSAGE = 'Floway user quota reached.';
export const USER_QUOTA_CODE = 'user_quota_exceeded';

export class UserQuotaExceededError extends Error {
  constructor() {
    super(USER_QUOTA_MESSAGE);
    this.name = 'UserQuotaExceededError';
  }
}

export const hasQuotaCapacity = async (repo: Repo, userId: number, upstreamId: string | null): Promise<boolean> => {
  const quotas = (await repo.userQuotas.list(userId, upstreamId)).filter(quota => quota.enforce);
  const now = Date.now();
  const effective = await Promise.all(quotas.map(quota => readQuotaPeriod(repo, quota, now)));
  return effective.every(quota => quota === null || !quota.enforce || compareDecimalStrings(quota.spentUsd, quota.limitUsd) < 0);
};

export const quotaChargeForMetrics = (
  metrics: readonly UsageMetricRecord[],
): UsageCharge => {
  let usd = '0';
  let unpriced = false;
  for (const { metric, quantity, unitPrice } of metrics) {
    const direction = compareDecimalStrings(quantity, '0');
    if (direction < 0 || (unitPrice !== null && compareDecimalStrings(unitPrice, '0') < 0)) {
      throw new RangeError(`Floway: negative quota charge for ${metric}`);
    }
    if (direction === 0) continue;
    if (unitPrice === null) unpriced = true;
    else usd = addDecimalStrings(usd, multiplyDecimalStrings(quantity, unitPrice));
  }
  return { spentUsd: usd, unpriced };
};

// Manual periods, and upstream rules still waiting for their first observed
// refill, have no historical cycle to synchronize with.
export const chargeUserQuota = async (
  repo: Repo, userId: number, upstreamId: string | null, charge: UsageCharge,
): Promise<boolean> => {
  const needsCounter = (quota: QuotaRecord) => quota.reset.kind === 'manual'
    || (quota.reset.kind === 'upstream' && quota.observedCycleStart === undefined);
  const hasCharge = charge.unpriced || !decimalStringIsZero(charge.spentUsd);
  for (let attempt = 0; attempt < 100; attempt++) {
    const quotas = await repo.userQuotas.list(userId, upstreamId);
    const updates = hasCharge ? quotas.filter(needsCounter).map(quota => ({ ...quota, ...addUsageCharges(quota, charge) })) : [];
    if (await repo.userQuotas.replaceIfCurrent(updates)) return quotas.some(quota => quota.reset.kind !== 'manual');
  }
  throw new Error('Floway: quota charge could not be committed after 100 concurrent updates');
};

export const quotaProgress = (quota: QuotaRecord) => {
  const ratio = divideDecimalString(quota.spentUsd, quota.limitUsd);
  const severity: 'brand' | 'success' | 'warning' | 'error' = compareDecimalStrings(quota.spentUsd, quota.limitUsd) > 0 ? 'error'
    : compareDecimalStrings(quota.spentUsd, multiplyDecimalStrings(quota.limitUsd, '0.8')) >= 0 ? 'warning'
      : compareDecimalStrings(quota.spentUsd, multiplyDecimalStrings(quota.limitUsd, '0.5')) >= 0 ? 'success' : 'brand';
  return { ratio, severity };
};

import type { QuotaRecord } from './schema.ts';
import { metricDisplayResolverForKind } from '../data-plane/providers/registry.ts';
import type { QuotaRevision, Repo } from '../repo/types.ts';
import type { UpstreamMetricIdentity, UpstreamProviderKind } from '@floway-dev/provider';

export const quotaResetDisplay = (kind: UpstreamProviderKind, metric: UpstreamMetricIdentity) => {
  const display = metricDisplayResolverForKind(kind)?.(metric, { quotaDisplay: 'remaining' });
  if (display?.resetThreshold === undefined) return null;
  const { name, labelKey, labelValues, windowSeconds, resetThreshold } = display;
  return { name, labelKey, labelValues, windowSeconds, resetThreshold };
};

const naturalPeriod = (kind: 'day' | 'week' | 'month', now: number) => {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (kind === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (kind === 'month') start.setUTCDate(1);
  const end = new Date(start);
  if (kind === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + (kind === 'week' ? 7 : 1));
  return { startsAt: start.getTime(), renewsAt: end.getTime() };
};

export const currentQuota = async <T extends QuotaRecord>(repo: Repo, quota: T, now: number) => {
  const { reset } = quota;
  let alignedStart: number | undefined;
  let observedCycleStart = quota.observedCycleStart;
  let renewsAt: number | null = null;
  let resetAvailable = true;
  if (reset.kind === 'upstream') {
    const upstream = await repo.upstreams.getById(reset.upstreamId);
    const display = upstream === null ? null : quotaResetDisplay(upstream.kind, reset.metric);
    resetAvailable = display !== null && upstream?.enabled === true;
    if (display !== null && (observedCycleStart ?? -1) < now) {
      observedCycleStart = await repo.upstreamMetrics.latestReset(
        reset.upstreamId, reset.metric, display.resetThreshold, observedCycleStart ?? -1, now,
      ) ?? observedCycleStart;
    }
    alignedStart = observedCycleStart;
  } else if (reset.kind !== 'manual') {
    const period = naturalPeriod(reset.kind, now);
    alignedStart = period.startsAt;
    renewsAt = period.renewsAt;
  }
  const usage = alignedStart === undefined
    ? { spentUsd: quota.spentUsd, unpriced: quota.unpriced, partialHistory: false }
    : await repo.usage.queryQuotaUsage({ userId: quota.userId, upstreamId: quota.upstreamId, start: alignedStart, through: now });
  return {
    ...quota,
    ...usage,
    startsAt: alignedStart ?? quota.startsAt,
    observedCycleStart,
    renewsAt,
    resetAvailable,
    waitingForReset: reset.kind === 'upstream' && observedCycleStart === undefined,
  };
};

// Minute buckets retain only their latest gauge observation. Once a refill
// has opened a new period, a later observation in that minute cannot undo it.
export const readQuotaPeriod = async (repo: Repo, initial: QuotaRevision, now: number) => {
  let quota: QuotaRevision | null = initial;
  for (let attempt = 0; attempt < 100 && quota !== null; attempt++) {
    const current = await currentQuota(repo, quota, now);
    if (current.observedCycleStart === quota.observedCycleStart
      || await repo.userQuotas.replaceIfCurrent([{ ...quota, observedCycleStart: current.observedCycleStart }])) return current;
    quota = await repo.userQuotas.get(quota.id);
  }
  if (quota === null) return null;
  throw new Error('Floway: quota period could not be committed after 100 concurrent updates');
};

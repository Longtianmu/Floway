import { checkMany } from '../../access-control/check.ts';
import { costQuotaForKind } from '../../data-plane/providers/registry.ts';
import { userFromContext } from '../../middleware/auth.ts';
import type { CtxWithQuery } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { upstreamResetCyclesQuery } from '../schemas.ts';
import { decimalStringIsZero, divideDecimalString, multiplyDecimalStrings, TELEMETRY_HOUR_MS, telemetryHourKey } from '@floway-dev/protocols/common';

export interface QuotaCostEstimate {
  window: 'five-hour' | 'week';
  spentUsd: string | null;
  fullQuotaUsd: string | null;
  reason: 'unsupported' | 'no-reset' | 'no-consumption' | 'unpriced' | 'stale' | null;
}

const windows = [{ window: 'five-hour', seconds: 5 * 60 * 60 }, { window: 'week', seconds: 7 * 24 * 60 * 60 }] as const;

export const upstreamQuotaEstimates = async (c: CtxWithQuery<typeof upstreamResetCyclesQuery>) => {
  const { upstream_id: upstreamId, end } = c.req.valid('query');
  const [allowed] = await checkMany(userFromContext(c), [{ target: { kind: 'upstream', upstreamId }, requirement: { permission: 'Upstream.Audit' } }]);
  const unavailable = { upstreamId, available: false, estimates: [] as QuotaCostEstimate[] };
  if (!allowed) return c.json(unavailable);
  const repo = getRepo();
  const upstream = await repo.upstreams.getById(upstreamId);
  if (upstream === null) return c.json(unavailable);
  // One bucket spans the entire interval, retaining the latest raw gauge per identity.
  const samples = await repo.upstreamMetrics.query(upstreamId, 0, end, end);
  if (samples.length === 0) return c.json(unavailable);
  const candidates = samples.flatMap(sample => {
    const display = costQuotaForKind(upstream.kind, sample);
    return display === null ? [] : [{ sample, display }];
  });
  const costs = new Map<string, Promise<string | null>>();
  const estimates = await Promise.all(windows.map(async ({ window, seconds }): Promise<QuotaCostEstimate> => {
    const empty: QuotaCostEstimate = { window, spentUsd: null, fullQuotaUsd: null, reason: 'unsupported' };
    const matching = candidates.filter(candidate => candidate.display.windowSeconds === seconds);
    const fresh = matching.filter(candidate => end - candidate.sample.timestamp < seconds * 1_000);
    if (fresh.length === 0) return matching.length ? { ...empty, reason: 'stale' } : empty;
    if (fresh.length !== 1) return empty;
    const { sample, display } = fresh[0]!;
    const [start] = await repo.upstreamMetrics.queryResetStarts(upstreamId, sample, display.resetValue!, end);
    if (start === undefined || sample.timestamp - start >= seconds * 1_000) return { ...empty, reason: 'no-reset' };
    const percent = display.toDisplayValue(sample.value);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('Quota cost estimation requires a used percentage between 0 and 100');
    const firstHour = telemetryHourKey(Math.floor(start / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS);
    const lastHour = telemetryHourKey((Math.floor(sample.timestamp / TELEMETRY_HOUR_MS) + 1) * TELEMETRY_HOUR_MS);
    const key = `${firstHour}/${lastHour}`;
    let cost = costs.get(key);
    if (cost === undefined) {
      cost = repo.usage.queryCost({ upstreamId, start: firstHour, end: lastHour });
      costs.set(key, cost);
    }
    const spentUsd = await cost;
    if (spentUsd === null) return { ...empty, reason: 'unpriced' };
    if (percent === 0 || decimalStringIsZero(spentUsd)) return { ...empty, spentUsd, reason: 'no-consumption' };
    return { window, spentUsd, fullQuotaUsd: divideDecimalString(multiplyDecimalStrings(spentUsd, '100'), String(percent)), reason: null };
  }));
  return c.json({ upstreamId, available: true, estimates });
};

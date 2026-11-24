import { recordPerformance, type PerformanceTelemetryContext } from './performance.ts';
import { recordUsage, tokenUsageMeasurement, type UsageMeasurement } from './usage.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import type { GatewayCtx } from '../gateway-ctx.ts';
import type { SseOutcome } from '../sse.ts';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const recordSseOutcome = (ctx: GatewayCtx, outcome: SseOutcome, identity: TelemetryModelIdentity, usage: TokenUsage | null): boolean => {
  if (outcome.type === 'completed') {
    ctx.dump?.success(identity, usage);
    return false;
  }
  ctx.dump?.failed('error' in outcome ? outcome.error : outcome.type === 'protocol-error' ? 'Upstream SSE reported an error' : 'Downstream cancelled the SSE response');
  return true;
};

// Await quota settlement before completing the response so a subsequent
// request observes the charge. Hourly telemetry remains a background task;
// a storage error must not replace an upstream response already in flight.
export const settle = (
  ctx: GatewayCtx,
  telemetry: PerformanceTelemetryContext | undefined,
  identity: TelemetryModelIdentity,
  usage: TokenUsage | null,
  failed: boolean,
  requestFinishedAt: number = performance.now(),
): Promise<void> => settleUsageMeasurement(ctx, telemetry, identity, tokenUsageMeasurement(usage), failed, requestFinishedAt);

export const settleUsageMeasurement = async (
  ctx: GatewayCtx,
  telemetry: PerformanceTelemetryContext | undefined,
  identity: TelemetryModelIdentity,
  measurement: UsageMeasurement,
  failed: boolean,
  requestFinishedAt: number = performance.now(),
): Promise<void> => {
  const outputTokens = Number(measurement.quantities.output_tokens ?? '0');
  recordPerformance(ctx, telemetry, failed, outputTokens, requestFinishedAt);
  await recordUsage(
    ctx,
    identity,
    measurement.quantities,
    measurement.pricingFacts,
  ).catch(error => {
    console.error('Floway: failed to prepare usage settlement', error);
  });
};

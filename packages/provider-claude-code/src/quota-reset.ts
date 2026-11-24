import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { readClaudeCodeUpstreamState } from './state.ts';
import { resolveUpstreamMetricDisplay } from './upstream-metrics.ts';
import type { UpstreamMetricIdentity, UpstreamRecord } from '@floway-dev/provider';

const probeWindow = (data: unknown, label: string): object | null => {
  if (typeof data !== 'object' || data === null || !Object.hasOwn(data, label)) return null;
  const window = (data as Record<string, unknown>)[label];
  return typeof window === 'object' && window !== null && !Array.isArray(window) ? window : null;
};

export const readClaudeCodeMetricResetAt = (record: UpstreamRecord, metric: UpstreamMetricIdentity): string | null => {
  const label = metric.labels.quota;
  if (typeof label !== 'string' || resolveUpstreamMetricDisplay(metric, { quotaDisplay: 'remaining' })?.resetThreshold === undefined) return null;
  assertClaudeCodeUpstreamRecord(record);
  const accountUuid = record.config.accounts[0].accountUuid;
  const account = readClaudeCodeUpstreamState(record.state).accounts.find(credential => credential.accountUuid === accountUuid);
  if (account === undefined) return null;
  const { quotaSnapshot: header, usageProbeSnapshot: probe } = account;
  const headerWindow = label === 'five_hour' ? header?.data.fiveHour : label === 'seven_day' ? header?.data.sevenDay : null;
  if (probe !== null && (header === null || headerWindow == null || probe.fetchedAt > header.fetchedAt)) {
    const window = probeWindow(probe.data, label);
    // The OAuth usage payload names this field separately from the response headers.
    // https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.288.tgz
    if (window !== null) return 'resets_at' in window && typeof window.resets_at === 'string' ? window.resets_at : null;
  }
  return headerWindow?.reset ?? null;
};

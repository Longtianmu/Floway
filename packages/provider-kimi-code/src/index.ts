import { KIMI_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { createKimiCodeProvider } from './provider.ts';
import { readKimiCodeUpstreamState } from './state.ts';
import { resolveUpstreamMetricDisplay } from './upstream-metrics.ts';
import { readKimiCodeUsage } from './usage.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const kimiCodeProviderModule: ProviderModule = {
  create: createKimiCodeProvider,
  defaultFlags: KIMI_CODE_DEFAULT_FLAGS,
  resolveUpstreamMetricDisplay,
  readUpstreamMetricResetAt(record, { name, labels }) {
    if (name !== 'quota.used_percent') return null;
    const snapshot = readKimiCodeUpstreamState(record.state).usageProbe?.observation;
    return snapshot == null ? null : readKimiCodeUsage(snapshot.data).windows.find(window => window.id === labels.window)?.resetsAt ?? null;
  },
};

export { pricingForKimiCodePublicModelId } from './pricing.ts';
export { parseKimiCodeUpstreamConfig, assertKimiCodeUpstreamRecord, kimiCodeStateSurvivesConfigChange, type KimiCodeUpstreamConfig } from './config.ts';
export { readKimiCodeUpstreamState, type KimiCodeUpstreamState } from './state.ts';
export { refreshKimiCodeUsageProbe, refreshKimiCodeAccountProbe } from './probe.ts';

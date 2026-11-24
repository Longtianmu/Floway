import { readOllamaAccountUsage } from './account-usage.ts';
import { OLLAMA_DEFAULT_FLAGS } from './defaults.ts';
import { createOllamaProvider } from './provider.ts';
import { readOllamaUpstreamState } from './state.ts';
import { resolveUpstreamMetricDisplay } from './upstream-metrics.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const ollamaProviderModule: ProviderModule = {
  create: createOllamaProvider,
  defaultFlags: OLLAMA_DEFAULT_FLAGS,
  resolveUpstreamMetricDisplay,
  readUpstreamMetricResetAt(record, { name, labels }) {
    const snapshot = readOllamaUpstreamState(record.state).usageProbe?.observation;
    if (snapshot == null) return null;
    const { included } = readOllamaAccountUsage(snapshot.data);
    if (included.kind === 'credits') return name === 'balance.usd' && labels.source === 'included' ? included.until : null;
    if (name !== 'quota.remaining_percent' || (labels.window !== 'session' && labels.window !== 'weekly')) return null;
    return included[labels.window].resetsAt;
  },
};

export { createOllamaProvider } from './provider.ts';
export { assertOllamaUpstreamRecord, parseOllamaUpstreamConfig, type OllamaUpstreamConfig, type OllamaUpstreamRecord } from './config.ts';
export { pricingForOllamaModelKey } from './pricing.ts';
export { readOllamaUpstreamState, type OllamaAccountEntry, type OllamaUpstreamState } from './state.ts';
export { isOllamaUsageEnabled, refreshOllamaUsageProbe } from './usage-probe.ts';
export { fetchOllamaAccount, refreshOllamaAccount } from './account-probe.ts';

export { ollamaMetrics, resolveUpstreamMetricDisplay, resolveUpstreamMetricDisplays } from './upstream-metrics.ts';

export { readOllamaAccountUsage, type OllamaAccountUsage, type OllamaUsageData } from './account-usage.ts';

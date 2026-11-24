import { COPILOT_DEFAULT_FLAGS } from './defaults.ts';
import { createCopilotProvider } from './provider.ts';
import { readCopilotUpstreamState } from './state.ts';
import { resolveUpstreamMetricDisplay } from './upstream-metrics.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const copilotProviderModule: ProviderModule = {
  create: createCopilotProvider,
  defaultFlags: COPILOT_DEFAULT_FLAGS,
  resolveUpstreamMetricDisplay,
  readUpstreamMetricResetAt(record, { name, labels }) {
    if (name !== 'quota.remaining' || typeof labels.quota !== 'string') return null;
    const snapshot = readCopilotUpstreamState(record.state).quotaSnapshot?.data;
    if (snapshot === undefined || !Object.hasOwn(snapshot.quotas, labels.quota)) return null;
    const quota = snapshot.quotas[labels.quota]!;
    return quota.unlimited || quota.entitlement === 0 ? null : snapshot.reset_at;
  },
};

export {
  clearInProcessCopilotTokenCache,
  exchangeCopilotToken,
} from './auth.ts';
export { fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from './github-device-flow.ts';
export { normalizeGitHubHost } from './github-host.ts';
export { pricingForCopilotPublicModelId } from './pricing.ts';
export {
  fetchCopilotUsage,
  projectCopilotSeat,
  projectCopilotUsageResponse,
  putCopilotQuota,
  putCopilotSeat,
  type CopilotQuotaDetail,
  type CopilotQuotaSnapshot,
  type CopilotSeat,
  type CopilotUsageResponse,
} from './quota.ts';
export {
  assertCopilotUpstreamRecord,
  parseCopilotUpstreamConfig,
  type CopilotUpstreamConfig,
  type CopilotUpstreamUser,
} from './config.ts';
export {
  assertCopilotUpstreamState,
  emptyCopilotUpstreamState,
  readCopilotUpstreamState,
  type CopilotQuotaSnapshotEntry,
  type CopilotSeatEntry,
  type CopilotTokenEntry,
  type CopilotUpstreamState,
} from './state.ts';

// Data transfer routes — export/import operator-managed database data as JSON.
//
// Ephemeral stored OpenAI Responses state is omitted from exports and cleared on
// replace imports; clients can regenerate it through normal OpenAI Responses use.
//
// The export contains all persisted authentication material, including raw API
// keys and server secrets, user password hashes, provider tokens, and
// credential-bearing proxy URIs. The endpoint is admin-only; handle the file
// with the same care as a DB backup.

import { parseImportData, type SerializedProxy } from './import-schema.ts';
import type { AccessRecordInput } from '../../access-control/types.ts';
import { parseWebSearchConfigDefault, parseWebSearchConfigStrict } from '../../data-plane/tools/web-search/config.ts';
import type { WebSearchConfig } from '../../data-plane/tools/web-search/types.ts';
import { notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type CtxWithJson, type CtxWithQuery } from '../../middleware/zod-validator.ts';
import { groupNameKey } from '../../repo/group-names.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_FALLBACK_IDS } from '../../repo/proxy-fallback-list.ts';
import type { ApiKey, Group, SiteSettings, UpstreamMetricRecord, PerformanceTelemetryRecord, UsageRecord, UsageSettlement, User, UserPreferencesRepo, WebSearchUsageRecord } from '../../repo/types.ts';
import type { QuotaRecord } from '../../user-quotas/schema.ts';
import { type exportQuery, type importBody } from '../schemas.ts';
import { saveUpstreams } from '../shared/save-upstreams.ts';
import { type FullSerializedUpstreamRecord, upstreamRecordToFullJson } from '../upstreams/serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

interface ExportPayload {
  version: 25;
  exportedAt: string;
  data: {
    users: User[];
    userPreferences: Awaited<ReturnType<UserPreferencesRepo['listAll']>>;
    userQuotas: QuotaRecord[];
    groups: Array<Group & { memberIds: number[] }>;
    accessRecords: AccessRecordInput[];
    apiKeys: ApiKey[];
    upstreams: FullSerializedUpstreamRecord[];
    proxies: SerializedProxy[];
    usage: UsageRecord[];
    usageSettlements: UsageSettlement[];
    searchUsage: WebSearchUsageRecord[];
    upstreamMetrics: UpstreamMetricRecord[];
    performance?: PerformanceTelemetryRecord[];
    performanceIncluded: boolean;
    searchConfig: WebSearchConfig;
    siteSettings: SiteSettings;
  };
}

const EXPORT_VERSION = 25;

const validateApiKeyIdentities = (records: readonly ApiKey[], existing: readonly ApiKey[], mode: 'merge' | 'replace'): string | null => {
  const ids = new Map<string, number>();
  const rawKeys = new Map<string, string>();
  const serverSecrets = new Map<string, string>();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const existingIdIndex = ids.get(record.id);
    if (existingIdIndex !== undefined) return `duplicate apiKeys id ${record.id} at indexes ${existingIdIndex} and ${i}`;
    ids.set(record.id, i);

    const existingRawKeyId = rawKeys.get(record.key);
    if (existingRawKeyId !== undefined) return `duplicate apiKeys raw key used by ${existingRawKeyId} and ${record.id}`;
    rawKeys.set(record.key, record.id);

    const existingServerSecretId = serverSecrets.get(record.serverSecret);
    if (existingServerSecretId !== undefined) return `duplicate apiKeys server secret used by ${existingServerSecretId} and ${record.id}`;
    serverSecrets.set(record.serverSecret, record.id);
  }

  if (mode === 'merge') {
    const existingRawKeys = new Map(existing.map(record => [record.key, record.id]));
    const existingServerSecrets = new Map(existing.map(record => [record.serverSecret, record.id]));
    for (const record of records) {
      const existingId = existingRawKeys.get(record.key);
      if (existingId !== undefined && existingId !== record.id) {
        return `apiKeys raw key for ${record.id} conflicts with existing api key ${existingId}`;
      }
      const existingServerSecretId = existingServerSecrets.get(record.serverSecret);
      if (existingServerSecretId !== undefined && existingServerSecretId !== record.id) {
        return `apiKeys server secret for ${record.id} conflicts with existing api key ${existingServerSecretId}`;
      }
    }
  }

  return null;
};

// Every fallback must resolve in the post-import catalog. Merge mode may refer
// to an existing local proxy; replace mode may only refer to imported proxies
// and the built-in direct transports because it clears the proxy repository.
const validateProxyFallbackReferences = (
  upstreams: readonly UpstreamRecord[],
  proxies: readonly SerializedProxy[],
  existingProxyIds: readonly string[],
): string | null => {
  const knownIds = new Set<string>(proxies.map(proxy => proxy.id));
  for (const id of existingProxyIds) knownIds.add(id);
  for (const id of DIRECT_FALLBACK_IDS) knownIds.add(id);
  for (const upstream of upstreams) {
    for (const ref of upstream.proxyFallbackList) {
      if (!knownIds.has(ref.id)) return `upstream ${upstream.id} references unknown proxy ${ref.id}`;
    }
  }
  return null;
};

const normalizeUpstreamOrder = (upstreams: readonly UpstreamRecord[]): UpstreamRecord[] => upstreams
  .toSorted((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  .map((upstream, sortOrder) => ({ ...upstream, sortOrder }));

export const exportData = async (c: CtxWithQuery<typeof exportQuery>) => {
  const repo = getRepo();
  const includePerformance = c.req.valid('query').include_performance === '1';
  const memberships = await repo.groups.listMemberships();

  const [users, userPreferences, userQuotas, groups, accessRecords, apiKeys, usage, usageSettlements, webSearchUsage, upstreamMetrics, performance, rawWebSearchConfig, upstreams, proxies, siteSettings] = await Promise.all([
    repo.users.listIncludingDeleted(),
    repo.userPreferences.listAll(),
    repo.userQuotas.list(),
    repo.groups.listIncludingDeleted(),
    repo.accessRecords.list(),
    repo.apiKeys.listIncludingDeleted(),
    repo.usage.listAll(),
    repo.usage.listSettlements(),
    repo.webSearchUsage.listAll(),
    repo.upstreamMetrics.listAll(),
    includePerformance ? repo.performance.listAll() : Promise.resolve([]),
    repo.webSearchConfig.get(),
    repo.upstreams.list(),
    repo.proxies.list(),
    repo.siteSettings.get(),
  ]);
  const activeUserIds = new Set(users.filter(user => user.deletedAt === null).map(user => user.id));

  const payload: ExportPayload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      users,
      userPreferences,
      userQuotas: userQuotas.filter(quota => activeUserIds.has(quota.userId)).map(({ revision: _revision, ...quota }) => quota),
      groups: groups.map(group => ({ ...group, memberIds: memberships.get(group.id) ?? [] })),
      accessRecords: accessRecords.map(({ principal, scope, sortOrder, values }) => ({ principal, scope, sortOrder, values })),
      apiKeys,
      upstreams: upstreams.map(upstreamRecordToFullJson),
      proxies: proxies.map(proxy => ({ id: proxy.id, name: proxy.name, url: proxy.url, dial_timeout_seconds: proxy.dialTimeoutSeconds })),
      usage,
      usageSettlements,
      searchUsage: webSearchUsage,
      upstreamMetrics,
      performanceIncluded: includePerformance,
      searchConfig: rawWebSearchConfig === null ? parseWebSearchConfigDefault() : parseWebSearchConfigStrict(rawWebSearchConfig),
      siteSettings,
    },
  };
  if (includePerformance) payload.data.performance = performance;

  return c.json(payload);
};

export const importData = async (c: CtxWithJson<typeof importBody>) => {
  const { mode, data: rawData } = c.req.valid('json');
  const parsed = parseImportData(rawData);
  if (parsed.type === 'invalid') return c.json({ error: parsed.error }, 400);
  const { users, userPreferences, userQuotas, groups, accessRecords, apiKeys, upstreams, proxies, usage, usageSettlements, searchUsage, upstreamMetrics, performance, performanceIncluded, searchConfig, siteSettings } = parsed.data;

  const repo = getRepo();
  // Merge mode needs each key's prior dump policy to identify transitions that
  // must disconnect live subscribers after the replacement row is stored.
  const preImportKeys = await repo.apiKeys.listIncludingDeleted();
  const apiKeyIdentityError = validateApiKeyIdentities(apiKeys, mode === 'merge' ? preImportKeys : [], mode);
  if (apiKeyIdentityError) return c.json({ error: `invalid apiKeys: ${apiKeyIdentityError}` }, 400);
  const importedGroupIds = new Set(groups.map(group => group.id));
  const retainedGroups = mode === 'merge' ? (await repo.groups.list()).filter(group => !importedGroupIds.has(group.id)) : [];
  const groupNames = new Map<string, number>();
  for (const group of [...retainedGroups, ...groups]) {
    if (group.deletedAt !== null) continue;
    const key = groupNameKey(group.name);
    const previousId = groupNames.get(key);
    if (previousId !== undefined) return c.json({ error: `invalid groups: active group names conflict for ids ${previousId} and ${group.id}` }, 400);
    groupNames.set(key, group.id);
  }
  const preImportRetentionById = new Map<string, number | null>(preImportKeys.map(key => [key.id, key.dumpRetentionSeconds]));

  const existingProxyIdsForRefs = mode === 'merge' ? (await repo.proxies.list()).map(proxy => proxy.id) : [];
  const fallbackRefError = validateProxyFallbackReferences(upstreams, proxies, existingProxyIdsForRefs);
  if (fallbackRefError) return c.json({ error: `invalid upstreams: ${fallbackRefError}` }, 400);
  const importedUpstreamIds = new Set(upstreams.map(upstream => upstream.id));
  const retainedUpstreams = mode === 'merge'
    ? (await repo.upstreams.list()).filter(upstream => !importedUpstreamIds.has(upstream.id))
    : [];
  const normalizedUpstreams = normalizeUpstreamOrder([...retainedUpstreams, ...upstreams]);
  const previousQuotas = mode === 'merge' && userQuotas.length > 0 ? await repo.userQuotas.list() : [];
  const quotaById = new Map(previousQuotas.map(quota => [quota.id, quota]));
  const quotaByScope = new Map(previousQuotas.map(quota => [JSON.stringify([quota.userId, quota.upstreamId]), quota]));
  for (const quota of userQuotas) {
    const previous = quotaById.get(quota.id);
    if (previous && (previous.userId !== quota.userId || previous.upstreamId !== quota.upstreamId)) {
      return c.json({ error: 'invalid userQuotas: quota id belongs to another scope' }, 400);
    }
  }

  if (mode === 'replace') {
    for (const key of preImportKeys) await notifyDisabledBestEffort(key.id, 'replace-mode import');

    // D1 does not expose a transaction spanning these repositories. Complete
    // validation therefore happens before this delete wave; a storage failure
    // after it begins can still leave a partially restored deployment.
    const deletes: Promise<unknown>[] = [
      repo.userQuotas.deleteAll(),
      repo.sessions.deleteAll(),
      repo.apiKeys.deleteAll(),
      repo.usage.deleteAll(),
      repo.webSearchUsage.deleteAll(),
      repo.upstreamMetrics.deleteAll(),
      repo.upstreams.deleteAll(),
      repo.proxies.deleteAll(),
      repo.openaiResponsesSnapshots.deleteAll(),
      repo.openaiResponsesItems.deleteAll(),
      repo.userPreferences.deleteAll(),
      repo.accessRecords.deleteAll(),
      repo.groups.deleteAll(),
      repo.users.deleteAll(),
    ];
    if (performanceIncluded) deletes.push(repo.performance.deleteAll());
    await Promise.all(deletes);
  }

  // Users precede their API keys, and proxies precede upstream fallback refs.
  for (const user of users) await repo.users.save(user);
  for (const quota of userQuotas) {
    const previous = quotaByScope.get(JSON.stringify([quota.userId, quota.upstreamId]));
    const saved = previous === undefined
      ? await repo.userQuotas.insert(quota)
      : await repo.userQuotas.replaceIfCurrent([{ ...quota, id: previous.id, revision: previous.revision }]);
    if (!saved) throw new Error('Floway: quota changed while restoring the backup');
  }
  for (const { userId, preferences } of userPreferences) await repo.userPreferences.save(userId, preferences);
  await repo.groups.restore(groups);
  for (const record of accessRecords) await repo.accessRecords.save(record);
  for (const proxy of proxies) {
    await repo.proxies.save({
      id: proxy.id,
      name: proxy.name,
      url: proxy.url,
      dialTimeoutSeconds: proxy.dial_timeout_seconds,
    });
  }
  for (const key of apiKeys) {
    const previous = preImportRetentionById.get(key.id) ?? null;
    await repo.apiKeys.save(key);
    if (mode === 'merge' && key.dumpRetentionSeconds === null && previous !== null) {
      await notifyDisabledBestEffort(key.id, 'merge-mode retention disable');
    }
  }
  for (const record of usage) await repo.usage.set(record);
  for (const settlement of usageSettlements) await repo.usage.setSettlement(settlement);
  for (const record of searchUsage) await repo.webSearchUsage.set(record);
  for (const record of upstreamMetrics) await repo.upstreamMetrics.set(record);
  await saveUpstreams(await Promise.all(normalizedUpstreams.map(async next => ({
    previous: await repo.upstreams.getById(next.id),
    next,
  }))));
  for (const record of performance) await repo.performance.set(record);
  await repo.siteSettings.save(siteSettings);
  await repo.webSearchConfig.save(searchConfig);

  return c.json({
    ok: true,
    imported: {
      users: users.length,
      userPreferences: userPreferences.length,
      groups: groups.length,
      accessRecords: accessRecords.length,
      apiKeys: apiKeys.length,
      upstreams: upstreams.length,
      proxies: proxies.length,
      usage: usage.length,
      searchUsage: searchUsage.length,
      upstreamMetrics: upstreamMetrics.length,
      performance: performance.length,
    },
  });
};

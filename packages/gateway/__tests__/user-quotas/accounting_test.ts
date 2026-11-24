import { afterEach, describe, expect, it, vi } from 'vitest';

import { usageHourAt } from '../../src/repo/quota-usage.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { chargeUserQuota, hasQuotaCapacity, quotaChargeForMetrics, quotaProgress } from '../../src/user-quotas/accounting.ts';
import { currentQuota, readQuotaPeriod } from '../../src/user-quotas/period.ts';
import type { QuotaRecord } from '../../src/user-quotas/schema.ts';
import { createSqliteTestDb } from '../repo/test-sqlite.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { buildChatGPTUpstreamRecord } from '../test-utils/app.ts';

const makeQuota = (overrides: Partial<QuotaRecord> = {}): QuotaRecord => ({
  id: crypto.randomUUID(),
  userId: 1,
  upstreamId: null,
  limitUsd: '1',
  enforce: true,
  reset: { kind: 'manual' },
  startsAt: Date.now(),
  spentUsd: '0',
  unpriced: false,
  ...overrides,
});

const seedKey = async (repo: Repo) => {
  await repo.apiKeys.save({
    id: 'key-1', name: 'Test key', key: 'test-raw', userId: 1, serverSecret: '00'.repeat(32),
    createdAt: new Date(0).toISOString(), upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
    dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
  });
};

const recordSpend = async (repo: Repo, upstream: string, timestamp: number, spentUsd: string, precise = true) => {
  const keyId = 'key-1';
  const metrics = [{ metric: 'input_tokens' as const, quantity: spentUsd, unitPrice: '1' }];
  await repo.usage.record({
    keyId, upstream, model: 'model', modelKey: 'model', hour: usageHourAt(timestamp), requests: 1, pricingSelector: {}, metrics,
  }, precise ? { id: crypto.randomUUID(), keyId, upstream, timestamp, spentUsd, unpriced: false } : undefined);
};

afterEach(() => vi.useRealTimers());

describe('user quota accounting', () => {
  it('adds exact settled pricing to both scopes across concurrent settlements and retains overflow', async () => {
    const db = await createSqliteTestDb();
    const first = new SqlRepo(db);
    const second = new SqlRepo(db);
    const total = makeQuota({ limitUsd: '2' });
    const upstream = makeQuota({ upstreamId: 'upstream-a' });
    expect(await first.userQuotas.insert(total)).toBe(true);
    expect(await first.userQuotas.insert(upstream)).toBe(true);
    expect(await first.userQuotas.insert(makeQuota())).toBe(false);
    await Promise.all(Array.from({ length: 5 }, (_, index) => chargeUserQuota(
      index % 2 === 0 ? first : second, 1, 'upstream-a', { spentUsd: '0.21', unpriced: false },
    )));
    await chargeUserQuota(second, 1, 'upstream-b', { spentUsd: '0.15', unpriced: true });
    expect(await first.userQuotas.get(total.id)).toMatchObject({ spentUsd: '1.2', unpriced: true });
    expect(await first.userQuotas.get(upstream.id)).toMatchObject({ spentUsd: '1.05', unpriced: false });
    expect(() => quotaChargeForMetrics([{ metric: 'input_tokens', quantity: '-1', unitPrice: '0.25' }])).toThrow('negative quota charge');
    expect(await hasQuotaCapacity(first, 1, 'upstream-a')).toBe(false);
    expect(await hasQuotaCapacity(first, 1, 'upstream-b')).toBe(true);
    await chargeUserQuota(second, 1, 'upstream-b', { spentUsd: '0.8', unpriced: false });
    expect(await hasQuotaCapacity(first, 1, 'upstream-b')).toBe(false);
  });

  it('does not partially charge one rule when another rule has just changed', async () => {
    const repo = new SqlRepo(await createSqliteTestDb());
    const total = makeQuota();
    const scope = makeQuota({ upstreamId: 'upstream' });
    await repo.userQuotas.insert(total);
    await repo.userQuotas.insert(scope);
    const initial = await repo.userQuotas.list(1, 'upstream');
    const specific = initial.find(quota => quota.id === scope.id)!;
    expect(await repo.userQuotas.replaceIfCurrent([{ ...specific, enforce: false }])).toBe(true);
    expect(await repo.userQuotas.replaceIfCurrent(initial.map(quota => ({ ...quota, spentUsd: '0.5' })))).toBe(false);
    expect(await repo.userQuotas.get(total.id)).toMatchObject({ spentUsd: '0' });
    expect(await repo.userQuotas.get(scope.id)).toMatchObject({ spentUsd: '0', enforce: false });
  });

  it.each([
    ['day', '2026-01-31T23:59:59.999Z', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z'],
    ['week', '2026-01-04T23:59:59.999Z', '2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.000Z'],
    ['month', '2024-02-29T23:59:59.999Z', '2024-03-01T00:00:00.000Z', '2024-04-01T00:00:00.000Z'],
  ] as const)('renews a %s quota at its UTC calendar boundary', async (kind, before, boundary, renewed) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const repo = new SqlRepo(await createSqliteTestDb());
    await seedKey(repo);
    vi.setSystemTime(Date.parse(before));
    await recordSpend(repo, 'upstream', Date.now() - 3_600_000, '1.2', false);
    const quota = makeQuota({ reset: { kind } });
    await repo.userQuotas.insert(quota);
    expect(await hasQuotaCapacity(repo, 1, 'upstream')).toBe(false);
    vi.setSystemTime(Date.parse(boundary));
    expect(await hasQuotaCapacity(repo, 1, 'upstream')).toBe(true);
    const after = await currentQuota(repo, quota, Date.now());
    expect(after).toMatchObject({ startsAt: Date.parse(boundary), renewsAt: Date.parse(renewed), spentUsd: '0' });
    await recordSpend(repo, 'upstream', Date.now(), '0.07');
    expect(await currentQuota(repo, quota, Date.now())).toMatchObject({ startsAt: Date.parse(boundary), spentUsd: '0.07' });
  });

  it('only renews on a refill of the chosen upstream and window, even within the current telemetry hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(20 * 60_000);
    const repo = new SqlRepo(await createSqliteTestDb());
    await seedKey(repo);
    const upstream = buildChatGPTUpstreamRecord();
    await saveUpstreamForTest(repo.upstreams, upstream);
    const metric = { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } };
    const quota = makeQuota({ startsAt: 300_000, spentUsd: '1.2', reset: { kind: 'upstream', upstreamId: upstream.id, metric } });
    await repo.userQuotas.insert(quota);
    const observe = (timestamp: number, value: number, window = 18_000) => repo.upstreamMetrics.record({
      upstreamId: upstream.id, ...metric, labels: { ...metric.labels, window_seconds: window }, timestamp, value,
    });
    await observe(1_000, 0);
    await observe(61_000, 0);
    await observe(121_000, 85);
    await observe(121_000, 90, 604_800);
    await observe(181_000, 0, 604_800);
    expect(await hasQuotaCapacity(repo, 1, 'not-the-clock-upstream')).toBe(false);
    await observe(181_000, 0);
    await observe(241_000, 0);
    await recordSpend(repo, 'not-the-clock-upstream', 120_000, '2');
    await recordSpend(repo, 'not-the-clock-upstream', 181_000, '0.6');
    expect(await hasQuotaCapacity(repo, 1, 'not-the-clock-upstream')).toBe(true);
    await observe(182_000, 4);
    await observe(242_000, 5);
    const saved = (await repo.userQuotas.get(quota.id))!;
    expect(saved.observedCycleStart).toBe(181_000);
    expect(await readQuotaPeriod(repo, saved, Date.now())).toMatchObject({ startsAt: 181_000, spentUsd: '0.6', partialHistory: false });
    await recordSpend(repo, 'not-the-clock-upstream', 300_000, '5', false);
    expect(await readQuotaPeriod(repo, saved, Date.now())).toMatchObject({ startsAt: 181_000, spentUsd: '0.6', partialHistory: true });
    await recordSpend(repo, 'not-the-clock-upstream', 301_000, '0.4');
    expect(await hasQuotaCapacity(repo, 1, 'not-the-clock-upstream')).toBe(false);
  });

  it.each([
    ['0.49999', 'brand'],
    ['0.5', 'success'],
    ['0.79999', 'success'],
    ['0.8', 'warning'],
    ['1', 'warning'],
    ['1.00001', 'error'],
  ])('reports ratio %s without capping it and uses the exact threshold', (spentUsd, severity) => {
    expect(quotaProgress(makeQuota({ spentUsd }))).toEqual({ ratio: spentUsd, severity });
  });
});

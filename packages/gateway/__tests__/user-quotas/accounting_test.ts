import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqlRepo } from '../../src/repo/sql.ts';
import type { UsageMetricRecord } from '../../src/repo/types.ts';
import { chargeUserQuota, hasQuotaCapacity, quotaProgress } from '../../src/user-quotas/accounting.ts';
import { currentQuota } from '../../src/user-quotas/period.ts';
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

const charge = (quantity: string, unitPrice: string | null): UsageMetricRecord =>
  ({ metric: 'input_tokens', quantity, unitPrice });

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
      index % 2 === 0 ? first : second, 1, 'upstream-a', [charge('3', '0.07')],
    )));
    await chargeUserQuota(second, 1, 'upstream-b', [charge('5', '0.03'), charge('2', null)]);
    expect(await first.userQuotas.get(total.id)).toMatchObject({ spentUsd: '1.2', unpriced: true });
    expect(await first.userQuotas.get(upstream.id)).toMatchObject({ spentUsd: '1.05', unpriced: false });
    await expect(chargeUserQuota(first, 1, 'upstream-a', [charge('-1', '0.25')])).rejects.toThrow('negative quota charge');
    expect(await hasQuotaCapacity(first, 1, 'upstream-a')).toBe(false);
    expect(await hasQuotaCapacity(first, 1, 'upstream-b')).toBe(true);
    await chargeUserQuota(second, 1, 'upstream-b', [charge('8', '0.1')]);
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
    vi.setSystemTime(Date.parse(before));
    const quota = makeQuota({ reset: { kind }, spentUsd: '1.2' });
    await repo.userQuotas.insert(quota);
    expect(await hasQuotaCapacity(repo, 1, 'upstream')).toBe(false);
    vi.setSystemTime(Date.parse(boundary));
    expect(await hasQuotaCapacity(repo, 1, 'upstream')).toBe(true);
    const after = await currentQuota(repo, quota, Date.now());
    expect(after).toMatchObject({ startsAt: Date.parse(boundary), renewsAt: Date.parse(renewed), spentUsd: '0' });
    await chargeUserQuota(repo, 1, 'upstream', [charge('7', '0.01')]);
    expect(await repo.userQuotas.get(quota.id)).toMatchObject({ startsAt: Date.parse(boundary), spentUsd: '0.07' });
  });

  it('only renews on a refill of the chosen upstream and window, even within the current telemetry hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(20 * 60_000);
    const repo = new SqlRepo(await createSqliteTestDb());
    const upstream = buildChatGPTUpstreamRecord();
    await saveUpstreamForTest(repo.upstreams, upstream);
    const metric = { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } };
    const quota = makeQuota({ startsAt: 10_000, spentUsd: '1.2', reset: { kind: 'upstream', upstreamId: upstream.id, metric } });
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
    expect(await hasQuotaCapacity(repo, 1, 'not-the-clock-upstream')).toBe(true);
    await observe(182_000, 4);
    await observe(242_000, 5);
    await chargeUserQuota(repo, 1, 'not-the-clock-upstream', [charge('3', '0.2')]);
    expect(await repo.userQuotas.get(quota.id)).toMatchObject({ startsAt: 181_000, spentUsd: '0.6' });
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

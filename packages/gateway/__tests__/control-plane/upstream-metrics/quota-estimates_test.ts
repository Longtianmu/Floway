import { expect, it } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCodexUpstreamRecord, buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';

const end = Date.UTC(2026, 10, 12, 12, 30);
const url = `/api/upstream-quota-estimates?upstream_id=selected&end=${end}`;

const fixture = async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCodexUpstreamRecord({ id: 'selected' }));
  const headers = { 'x-api-key': apiKey.key };
  const grant = () => repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'upstream', upstreamId: 'selected' }, sortOrder: 0, values: { 'Upstream.Audit': true } });
  const gauge = (seconds: number, timestamp: number, value: number, limit = 'codex') => repo.upstreamMetrics.record({ upstreamId: 'selected', name: 'quota.window.used_percent', labels: { limit, window_seconds: seconds }, timestamp, value });
  for (const [seconds, start, used] of [[18_000, Date.UTC(2026, 10, 12, 10, 15), 25], [604_800, Date.UTC(2026, 10, 10, 8, 15), 50]] as const) {
    await gauge(seconds, start - 60_000, 70);
    await gauge(seconds, start, 0);
    await gauge(seconds, end - 60_000, used);
  }
  for (const [hour, price] of [['2026-11-10T09', '10'], ['2026-11-12T10', '2'], ['2026-11-12T11', '3'], ['2026-11-12T12', '5'], ['2026-11-12T13', '100'], ['2026-11-10T07', '100']] as const) {
    await repo.usage.set({ keyId: hour, model: 'model', modelKey: 'model', upstream: 'selected', hour, pricingSelector: {}, requests: 1, metrics: [{ metric: 'input_tokens', quantity: '1', unitPrice: price }] });
  }
  return { repo, headers, grant, gauge };
};

it('requires upstream audit before reading cost or disclosing telemetry availability', async () => {
  const { repo, headers } = await fixture();
  repo.usage.queryCost = () => Promise.reject(new Error('Unauthorized cost read'));
  const response = await requestApp(url, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ upstreamId: 'selected', available: false, estimates: [] });
});

it('values both current quota windows using all keys, stored prices, and complete hourly buckets', async () => {
  const { repo, headers, grant } = await fixture();
  await grant();
  await repo.usage.set({ keyId: 'other', model: 'model', modelKey: 'model', upstream: 'unrelated', hour: '2026-11-12T11', pricingSelector: {}, requests: 1, metrics: [{ metric: 'input_tokens', quantity: '1', unitPrice: '999' }] });
  const response = await requestApp(url, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    upstreamId: 'selected', available: true, estimates: [
      { window: 'five-hour', spentUsd: '10', fullQuotaUsd: '40', reason: null },
      { window: 'week', spentUsd: '20', fullQuotaUsd: '40', reason: null },
    ],
  });
});

it('withholds full quota estimates at zero consumption and when prices are incomplete', async () => {
  const { repo, headers, grant, gauge } = await fixture();
  await grant();
  await gauge(18_000, end - 120_000, 25);
  await gauge(18_000, end - 30_000, 0);
  let body = await (await requestApp(url, { headers })).json();
  expect(body.estimates[0]).toEqual({ window: 'five-hour', spentUsd: '5', fullQuotaUsd: null, reason: 'no-consumption' });
  await repo.usage.set({ keyId: 'unpriced', model: 'model', modelKey: 'model', upstream: 'selected', hour: '2026-11-12T12', pricingSelector: {}, requests: 1, metrics: [{ metric: 'output_tokens', quantity: '1', unitPrice: null }] });
  body = await (await requestApp(url, { headers })).json();
  expect(body.estimates.every((estimate: { reason: string }) => estimate.reason === 'unpriced')).toBe(true);
});

it('values a premium weekly quota without inventing an absent five-hour window', async () => {
  const { repo, headers, grant, gauge } = await fixture();
  await grant();
  await repo.upstreamMetrics.deleteAll();
  const start = Date.UTC(2026, 10, 10, 8, 15);
  await gauge(604_800, start - 60_000, 70, 'premium');
  await gauge(604_800, start, 0, 'premium');
  await gauge(604_800, end - 60_000, 50, 'premium');
  const body = await (await requestApp(url, { headers })).json();
  expect(body.estimates).toEqual([
    { window: 'five-hour', spentUsd: null, fullQuotaUsd: null, reason: 'unsupported' },
    { window: 'week', spentUsd: '20', fullQuotaUsd: '40', reason: null },
  ]);
});

it('ignores obsolete quota identities instead of treating them as competing current quotas', async () => {
  const { headers, grant, gauge } = await fixture();
  await grant();
  await gauge(18_000, end - 6 * 3_600_000, 20, '');
  const body = await (await requestApp(url, { headers })).json();
  expect(body.estimates[0]).toEqual({ window: 'five-hour', spentUsd: '10', fullQuotaUsd: '40', reason: null });
});

it('does not invent resets or combine ambiguous quota families', async () => {
  const { repo, headers, grant, gauge } = await fixture();
  await grant();
  await repo.upstreamMetrics.deleteAll();
  await gauge(18_000, end - 60_000, 20);
  let body = await (await requestApp(url, { headers })).json();
  expect(body.estimates[0].reason).toBe('no-reset');
  await gauge(18_000, end - 60_000, 30, '');
  body = await (await requestApp(url, { headers })).json();
  expect(body.estimates[0].reason).toBe('unsupported');
});

it('does not substitute model-scoped Claude quotas for the upstream weekly quota', async () => {
  const { repo, headers, grant } = await fixture();
  await grant();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'selected', kind: 'claude-code',
    config: { accounts: [{ email: 'a@example.test', accountUuid: 'a', organizationUuid: null, subscriptionType: 'pro', rateLimitTier: null }] }, state: null,
  }));
  await repo.upstreamMetrics.deleteAll();
  await repo.upstreamMetrics.record({ upstreamId: 'selected', name: 'quota.utilization', labels: { quota: 'seven_day_sonnet' }, timestamp: end - 60_000, value: 20 });
  const body = await (await requestApp(url, { headers })).json();
  expect(body.estimates.every((estimate: { reason: string }) => estimate.reason === 'unsupported')).toBe(true);
});

it('supports remaining-percent Ollama legacy windows and withholds stale readings', async () => {
  const { repo, headers, grant } = await fixture();
  await grant();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'selected', kind: 'ollama',
    config: { baseUrl: 'https://ollama.com', apiKey: 'test-only', cloudUsage: true, models: [] }, state: null,
  }));
  await repo.upstreamMetrics.deleteAll();
  for (const [minute, value] of [[0, 30], [1, 100], [2, 75]] as const) {
    await repo.upstreamMetrics.record({ upstreamId: 'selected', name: 'quota.remaining_percent', labels: { window: 'session' }, timestamp: end - (3 - minute) * 60_000, value });
  }
  let body = await (await requestApp(url, { headers })).json();
  expect(body.estimates[0]).toEqual({ window: 'five-hour', spentUsd: '5', fullQuotaUsd: '20', reason: null });
  body = await (await requestApp(url.replace(String(end), String(end + 18_000_000)), { headers })).json();
  expect(body.estimates[0].reason).toBe('stale');
});

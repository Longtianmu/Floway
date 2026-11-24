import { expect, it } from 'vitest';

import { chargeUserQuota } from '../../../src/user-quotas/accounting.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildChatGPTUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';

it('lets admins manage quotas while users can only read their own usage', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  const session = await repo.sessions.create(apiKey.userId);
  const request = (path: string, sendAs: string, method = 'GET', json?: unknown) => requestApp(`/api/${path}`, {
    method,
    headers: { 'x-floway-session': sendAs, 'content-type': 'application/json' },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  const policy = { limitUsd: '0.50', enforce: true, reset: { kind: 'manual' } };
  const input = { ...policy, userId: apiKey.userId, upstreamId: null };
  expect((await request('user-quotas', session.id, 'POST', input)).status).toBe(403);
  expect((await request('user-quotas', adminSession, 'POST', { ...input, limitUsd: '0' })).status).toBe(400);
  const response = await request('user-quotas', adminSession, 'POST', input);
  expect(response.status).toBe(201);
  const { id } = await response.json();
  expect((await request('user-quotas', adminSession, 'POST', input)).status).toBe(409);
  expect((await request('user-quotas', adminSession, 'POST', { ...input, userId: 1 })).status).toBe(201);
  await chargeUserQuota(repo, apiKey.userId, 'u1', { spentUsd: '0.9', unpriced: false });
  const userData = await (await request('user-quotas?userId=1', session.id)).json();
  expect(userData.options).toBeNull();
  expect(userData.quotas).toHaveLength(1);
  expect(userData.quotas[0]).toMatchObject({ id, userId: apiKey.userId, ratio: '1.8', severity: 'error' });
  expect(userData.quotas[0]).not.toHaveProperty('revision');
  expect((await (await request('user-quotas', adminSession)).json()).quotas).toHaveLength(2);
  for (const [path, method] of [[`user-quotas/${id}`, 'PUT'], [`user-quotas/${id}/reset`, 'POST'], [`user-quotas/${id}`, 'DELETE']]) {
    expect((await request(path, session.id, method, method === 'PUT' ? policy : undefined)).status).toBe(403);
  }
  expect((await request(`user-quotas/${id}`, adminSession, 'PUT', { ...policy, enforce: false, limitUsd: '2' })).status).toBe(200);
  expect(await repo.userQuotas.get(id)).toMatchObject({ spentUsd: '0.9', limitUsd: '2', enforce: false });
  expect((await request(`user-quotas/${id}/reset`, adminSession, 'POST')).status).toBe(200);
  expect(await repo.userQuotas.get(id)).toMatchObject({ spentUsd: '0', limitUsd: '2', enforce: false });
  expect((await request(`user-quotas/${id}`, adminSession, 'DELETE')).status).toBe(200);
  expect((await (await request('user-quotas', session.id)).json()).quotas).toEqual([]);
});

it('offers only provider-owned reset clocks and validates reset inputs', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  const upstream = buildChatGPTUpstreamRecord();
  await saveUpstreamForTest(repo.upstreams, upstream);
  const metric = { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } };
  await repo.upstreamMetrics.record({ upstreamId: upstream.id, ...metric, timestamp: Date.now(), value: 8 });
  await repo.upstreamMetrics.record({ upstreamId: upstream.id, name: 'credits.balance', labels: {}, timestamp: Date.now(), value: 5 });
  const route = `/api/user-quota-reset-options/${upstream.id}`;
  expect((await requestApp(route, { headers: { 'x-api-key': apiKey.key } })).status).toBe(403);
  const headers = { 'x-floway-session': adminSession, 'content-type': 'application/json' };
  const result = await requestApp(route, { headers });
  expect(result.status).toBe(200);
  const { metrics } = await result.json();
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ metric, display: { windowSeconds: 18_000 } });
  const create = (name: string) => requestApp('/api/user-quotas', {
    method: 'POST', headers, body: JSON.stringify({
      userId: apiKey.userId, upstreamId: null, limitUsd: '1', enforce: true,
      reset: { kind: 'upstream', upstreamId: upstream.id, metric: { ...metric, name } },
    }),
  });
  expect((await create('credits.balance')).status).toBe(400);
  const valid = await create(metric.name);
  expect(valid.status).toBe(201);
  const { id } = await valid.json();
  expect((await requestApp(`/api/user-quotas/${id}/reset`, { method: 'POST', headers })).status).toBe(409);
});

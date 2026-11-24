import { expect, it } from 'vitest';

import { usageHourAt } from '../../../src/repo/quota-usage.ts';
import { readQuotaPeriod } from '../../../src/user-quotas/period.ts';
import type { QuotaRecord } from '../../../src/user-quotas/schema.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

it('charges equivalent pricing across API keys, skips an exhausted upstream, and blocks only enforced limits', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const model = 'quota-embedding';
  for (const [id, sortOrder] of [['primary', 0], ['fallback', 1]] as const) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id, name: id, sortOrder,
      config: { baseUrl: `https://${id}.example.com`, ingressHeadersRules: [], apiKey: 'fake', endpoints: { openaiEmbeddings: {} } },
    }));
  }
  const secondKey = { ...apiKey, id: 'second-key', key: 'second-raw-key', serverSecret: 'ab'.repeat(32) };
  await repo.apiKeys.save(secondKey);
  const quota = (scope: string | null, limitUsd: string, enforce: boolean): QuotaRecord => ({
    id: crypto.randomUUID(), userId: apiKey.userId, upstreamId: scope, limitUsd, enforce, reset: { kind: 'manual' },
    startsAt: Date.now(), spentUsd: '0', unpriced: false,
  });
  const primary: QuotaRecord = { ...quota('primary', '0.4', true), reset: { kind: 'day' } };
  const total = quota(null, '0.7', false);
  await repo.usage.set({
    keyId: secondKey.id, upstream: 'primary', model, modelKey: model, hour: usageHourAt(Date.now()),
    requests: 1, pricingSelector: {}, metrics: [{ metric: 'input_tokens', quantity: '2', unitPrice: '0.1' }],
  });
  await repo.userQuotas.insert(primary);
  await repo.userQuotas.insert(total);
  const calls: string[] = [];
  const request = (key: string, warm = false) => (warm ? requestAppWithWarmModels : requestApp)('/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ model, input: 'hello' }),
  });
  await withMockedFetch(upstream => {
    const url = new URL(upstream.url);
    if (url.pathname === '/v1/models') return jsonResponse({
      data: [{
        id: model, kind: 'embedding', pricing: { entries: [{ rates: { input_tokens: '0.1' } }] },
      }],
    });
    if (url.pathname === '/v1/embeddings') {
      calls.push(url.hostname);
      return jsonResponse({ object: 'list', model, data: [], usage: { prompt_tokens: 5, total_tokens: 5 } });
    }
    throw new Error(`Unexpected upstream request: ${upstream.url}`);
  }, async () => {
    expect((await request(apiKey.key, true)).status).toBe(200);
    const current = await readQuotaPeriod(repo, (await repo.userQuotas.get(primary.id))!, Date.now());
    expect(current).toMatchObject({ spentUsd: '0.7' });
    expect((await request(secondKey.key)).status).toBe(200);
    expect((await request(apiKey.key)).status).toBe(200);
    expect(calls).toEqual(['primary.example.com', 'fallback.example.com', 'fallback.example.com']);
    const totalCurrent = (await repo.userQuotas.get(total.id))!;
    expect(totalCurrent.spentUsd).toBe('1.5');
    expect(await repo.userQuotas.replaceIfCurrent([{ ...totalCurrent, enforce: true }])).toBe(true);
    const denied = await request(secondKey.key);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({ error: { code: 'user_quota_exceeded' } });
    expect(calls).toHaveLength(3);
  });
});

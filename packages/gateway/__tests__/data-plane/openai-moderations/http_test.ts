import { test, vi } from 'vitest';

import type { InMemoryRepo } from '../../repo/memory.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

interface ModerationUpstreamOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  sortOrder?: number;
  upstreamModelId?: string;
  publicModelId?: string;
  replaceExisting?: boolean;
}

const saveModerationUpstream = async (
  repo: InMemoryRepo,
  options: ModerationUpstreamOptions = {},
): Promise<void> => {
  if (options.replaceExisting !== false) {
    await repo.upstreams.deleteAll();
    clearInProcessCopilotTokenCache();
  }

  const id = options.id ?? 'up_moderations';
  const upstreamModelId = options.upstreamModelId ?? 'omni-moderation-latest';
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id,
    name: options.name ?? 'Moderation Provider',
    sortOrder: options.sortOrder ?? 100,
    config: {
      baseUrl: options.baseUrl ?? 'https://moderation.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: options.apiKey ?? 'sk-moderation',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId,
        ...(options.publicModelId === undefined ? {} : { publicModelId: options.publicModelId }),
        kind: 'moderation',
        endpoints: { openaiModerations: {} },
      }],
    },
  }));
};

const requestHeaders = (apiKey: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
});

test('/v1/moderations applies the OpenAI default model and preserves a text request and successful response', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveModerationUpstream(repo);

  const clientBody = {
    input: 'The quick brown fox jumps over the lazy dog.',
    provider_extension: { policy: 'strict' },
  };
  const upstreamBody = {
    id: 'modr-default',
    model: 'omni-moderation-latest',
    results: [{
      flagged: false,
      categories: { hate: false, violence: false },
      category_scores: { hate: 0.001, violence: 0.002 },
    }],
  };
  let forwardedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      assertEquals(url.hostname, 'moderation.example.com');
      assertEquals(url.pathname, '/v1/moderations');
      assertEquals(request.headers.get('authorization'), 'Bearer sk-moderation');
      forwardedBody = await request.json() as Record<string, unknown>;
      return new Response(JSON.stringify(upstreamBody), {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-default-moderation',
        },
      });
    },
    async () => {
      const response = await requestApp('/v1/moderations', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify(clientBody),
      });

      assertEquals(response.status, 201);
      assertEquals(response.headers.get('x-request-id'), 'req-default-moderation');
      assertEquals(await response.json(), upstreamBody);
    },
  );

  assertEquals(forwardedBody, {
    ...clientBody,
    model: 'omni-moderation-latest',
  });
});

test('/moderations alias remaps an explicit public model and preserves multimodal input verbatim', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveModerationUpstream(repo, {
    upstreamModelId: 'omni-moderation-2024-09-26',
    publicModelId: 'safety-latest',
  });

  const input = [
    { type: 'text', text: 'Classify the accompanying image.' },
    { type: 'image_url', image_url: { url: 'https://assets.example.com/example.png' } },
  ];
  const clientBody = {
    model: 'safety-latest',
    input,
    vendor_policy: 'preview-2026-08',
  };
  let forwardedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      assertEquals(new URL(request.url).pathname, '/v1/moderations');
      forwardedBody = await request.json() as Record<string, unknown>;
      return jsonResponse({
        id: 'modr-multimodal',
        model: 'omni-moderation-2024-09-26',
        results: [{ flagged: true }],
      });
    },
    async () => {
      const response = await requestApp('/moderations', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify(clientBody),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertEquals(forwardedBody, {
    ...clientBody,
    model: 'omni-moderation-2024-09-26',
  });
});

test('/v1/moderations forwards the exhausted upstream error status, headers, and body verbatim', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveModerationUpstream(repo);

  const upstreamError = JSON.stringify({
    error: {
      message: 'Moderation rate limit exceeded.',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  });

  await withMockedFetch(
    () => new Response(upstreamError, {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '9',
        'x-request-id': 'req-rate-limited',
      },
    }),
    async () => {
      const response = await requestApp('/v1/moderations', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ input: 'rate limited text' }),
      });

      assertEquals(response.status, 429);
      assertEquals(response.headers.get('retry-after'), '9');
      assertEquals(response.headers.get('x-request-id'), 'req-rate-limited');
      assertEquals(await response.text(), upstreamError);
    },
  );

  await flushAsyncWork();
  assertEquals(await repo.usage.listAll(), []);
  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.operation, 'moderation');
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 1);
});

test('/v1/moderations rejects malformed JSON, non-object JSON, and an invalid explicit model', async () => {
  const { apiKey } = await setupAppTest();

  const malformed = await requestApp('/v1/moderations', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body: 'not valid JSON',
  });
  assertEquals(malformed.status, 400);
  assertEquals(await malformed.json(), {
    error: {
      message: 'OpenAI Moderations request body must be valid JSON.',
      type: 'api_error',
    },
  });

  const arrayBody = await requestApp('/v1/moderations', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body: '[]',
  });
  assertEquals(arrayBody.status, 400);
  assertEquals(await arrayBody.json(), {
    error: {
      message: 'OpenAI Moderations request body must be an object.',
      type: 'api_error',
    },
  });

  const invalidModel = await requestApp('/v1/moderations', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body: JSON.stringify({ model: '', input: 'hello' }),
  });
  assertEquals(invalidModel.status, 400);
  assertEquals(await invalidModel.json(), {
    error: {
      message: 'OpenAI Moderations request body must include a model string.',
      type: 'api_error',
    },
  });
});

test('/v1/moderations distinguishes a wrong-kind model from an unknown model', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'Chat Only Provider',
    config: {
      baseUrl: 'https://chat-only.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-chat-only',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'gpt-4o',
        publicModelId: 'chat-only',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
      }],
    },
  }));

  await withMockedFetch(
    request => {
      throw new Error(`Moderations must not dispatch an unavailable model: ${request.url}`);
    },
    async () => {
      const wrongKind = await requestApp('/v1/moderations', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'chat-only', input: 'hello' }),
      });
      assertEquals(wrongKind.status, 400);
      assertEquals(await wrongKind.json(), {
        error: {
          message: 'Model chat-only does not support the /moderations endpoint.',
          type: 'api_error',
        },
      });

      const unknown = await requestApp('/v1/moderations', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'unknown-moderation-model', input: 'hello' }),
      });
      assertEquals(unknown.status, 404);
      assertEquals(await unknown.json(), {
        error: {
          message: 'Model unknown-moderation-model is not available on any configured upstream.',
          type: 'api_error',
        },
      });
    },
  );
});

test('/v1/moderations records a request-only usage row and neutral performance without token usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveModerationUpstream(repo, {
    upstreamModelId: 'omni-moderation-2024-09-26',
    publicModelId: 'moderation-public',
  });

  await withMockedFetch(
    () => jsonResponse({
      id: 'modr-telemetry',
      model: 'omni-moderation-2024-09-26',
      results: [{ flagged: false }],
    }),
    async () => {
      const response = await requestApp('/v1/moderations', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'moderation-public', input: 'hello' }),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushAsyncWork();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.keyId, apiKey.id);
  assertEquals(usage[0]?.model, 'moderation-public');
  assertEquals(usage[0]?.upstream, 'up_moderations');
  assertEquals(usage[0]?.modelKey, 'omni-moderation-2024-09-26');
  assertEquals(usage[0]?.requests, 1);
  assertEquals(usage[0]?.metrics, []);

  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.keyId, apiKey.id);
  assertEquals(performance[0]?.model, 'moderation-public');
  assertEquals(performance[0]?.upstream, 'up_moderations');
  assertEquals(performance[0]?.operation, 'moderation');
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.neutral, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);
  assertEquals(performance[0]?.errorsWithOutput, 0);
});

test('/v1/moderations rolls a non-2xx candidate over to the next custom upstream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveModerationUpstream(repo, {
    id: 'up_moderations_a',
    name: 'Moderation Provider A',
    baseUrl: 'https://moderation-a.example.com',
    apiKey: 'sk-a',
    sortOrder: 100,
    upstreamModelId: 'moderation-wire-a',
    publicModelId: 'moderation-fallback',
  });
  await saveModerationUpstream(repo, {
    id: 'up_moderations_b',
    name: 'Moderation Provider B',
    baseUrl: 'https://moderation-b.example.com',
    apiKey: 'sk-b',
    sortOrder: 200,
    upstreamModelId: 'moderation-wire-b',
    publicModelId: 'moderation-fallback',
    replaceExisting: false,
  });

  const attempts: Array<{ host: string; body: Record<string, unknown> }> = [];
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      attempts.push({ host: url.hostname, body: await request.json() as Record<string, unknown> });
      if (url.hostname === 'moderation-a.example.com') {
        return jsonResponse({ error: { message: 'temporarily unavailable' } }, 503);
      }
      if (url.hostname === 'moderation-b.example.com') {
        return jsonResponse({ id: 'modr-fallback', results: [{ flagged: false }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/moderations', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({ model: 'moderation-fallback', input: 'hello' }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { id: 'modr-fallback', results: [{ flagged: false }] });
    },
  );

  assertEquals(attempts, [
    {
      host: 'moderation-a.example.com',
      body: { model: 'moderation-wire-a', input: 'hello' },
    },
    {
      host: 'moderation-b.example.com',
      body: { model: 'moderation-wire-b', input: 'hello' },
    },
  ]);
});

test('/v1/moderations surfaces an upstream transport exception as an internal 502 and records failure', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveModerationUpstream(repo);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await withMockedFetch(
      () => {
        throw new Error('moderation transport failed');
      },
      async () => {
        const response = await requestApp('/v1/moderations', {
          method: 'POST',
          headers: requestHeaders(apiKey.key),
          body: JSON.stringify({ input: 'hello' }),
        });

        assertEquals(response.status, 502);
        const body = await response.json() as {
          error: { type: string; name: string; message: string; stack?: string };
        };
        assertEquals(body.error.type, 'internal_error');
        assertEquals(body.error.name, 'Error');
        assertEquals(body.error.message, 'moderation transport failed');
        assertExists(body.error.stack);
        assertEquals(body.error.stack.includes('moderation transport failed'), true);
      },
    );

    await flushAsyncWork();
    const performance = await repo.performance.listAll();
    assertEquals(performance.length, 1);
    assertEquals(performance[0]?.upstream, 'up_moderations');
    assertEquals(performance[0]?.operation, 'moderation');
    assertEquals(performance[0]?.errorsNoOutput, 1);
  } finally {
    errorSpy.mockRestore();
  }
});

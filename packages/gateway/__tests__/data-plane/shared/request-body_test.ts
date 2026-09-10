import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { createJsonRequestBody, readRequestBody, takeRequestBody } from '../../../src/data-plane/shared/request-body.ts';
import type { AuthedContext, AuthVars } from '../../../src/middleware/auth.ts';
import { assertEquals } from '@floway-dev/test-utils';

const context = async (request: Request, dumpRetentionSeconds: number | null): Promise<AuthedContext> => {
  const app = new Hono<{ Variables: AuthVars }>();
  let captured: AuthedContext | undefined;
  app.all('*', c => {
    c.set('apiKey', {
      id: 'key_request_body',
      userId: 1,
      name: 'request body test',
      key: 'sk-test',
      serverSecret: '00'.repeat(32),
      createdAt: '2026-01-01T00:00:00.000Z',
      upstreamIds: null,
      deletedAt: null,
      dumpRetentionSeconds,
      openaiResponsesRetentionSeconds: 0,
    });
    captured = c;
    return c.body(null, 204);
  });
  await app.fetch(request);
  if (captured === undefined) throw new Error('test route did not receive its request');
  return captured;
};

const streamRequest = (stream: ReadableStream<Uint8Array>): Request =>
  new Request('http://localhost/v1/responses', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);

test('takeRequestBody transfers bytes and clears the source owner', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const source = { bytes, streamError: 'partial upload' };

  const owned = takeRequestBody(source);

  expect(owned.bytes).toBe(bytes);
  assertEquals(owned.streamError, 'partial upload');
  assertEquals(source.bytes.byteLength, 0);
});

test.each([null, 3600])('createJsonRequestBody leaves reading inside the caller error boundary (dump=%s)', async (retention) => {
  const request = new Request('http://localhost/v1/responses', { method: 'POST', body: '{invalid' });
  const body = createJsonRequestBody(await context(request, retention));
  expect(request.bodyUsed).toBe(false);
  expect(body.bytes.byteLength).toBe(0);
  await expect(body.json()).rejects.toThrow();
  expect(request.bodyUsed).toBe(true);
});

test('createJsonRequestBody parses streamed JSON without retaining wire bytes when Dump is disabled', async () => {
  const chunks = ['{"model":"test","input":[', '{"type":"input_image","image_url":"data:image/png;base64,AAAA"}', ']}'];
  let reads = 0;
  const request = streamRequest(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads === chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunks[reads++]));
    },
  }, { highWaterMark: 0 }));
  const arrayBuffer = vi.spyOn(request, 'arrayBuffer');
  const text = vi.spyOn(request, 'text');
  const json = vi.spyOn(request, 'json');
  const body = createJsonRequestBody(await context(request, null));
  expect(reads).toBe(0);
  expect(await body.json()).toEqual(JSON.parse(chunks.join('')));
  expect(reads).toBe(chunks.length);
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(text).not.toHaveBeenCalled();
  expect(json).not.toHaveBeenCalled();
  expect(body.bytes.byteLength).toBe(0);
  expect(body.streamError).toBeNull();
  expect(request.body?.locked).toBe(false);
});

test('createJsonRequestBody retains exact original JSON bytes for Dump and transfers their ownership', async () => {
  const wire = '\ufeff { "model" : "test", "input" : "你好", "same": 1, "same": 2 }\r\n';
  const bytes = new TextEncoder().encode(wire);
  const request = new Request('http://localhost/v1/responses', { method: 'POST', body: bytes });
  const arrayBuffer = vi.spyOn(request, 'arrayBuffer');
  const body = createJsonRequestBody(await context(request, 3600));
  expect(await body.json()).toEqual({ model: 'test', input: '你好', same: 2 });
  expect(arrayBuffer).toHaveBeenCalledTimes(1);
  expect(body.bytes).toEqual(bytes);
  expect(body.streamError).toBeNull();
  const captured = body.bytes;
  expect(takeRequestBody(body).bytes).toBe(captured);
  expect(body.bytes.byteLength).toBe(0);
});

test('createJsonRequestBody retains malformed JSON bytes for the error Dump', async () => {
  const bytes = new TextEncoder().encode(' {"input": [} ');
  const request = new Request('http://localhost/v1/responses', { method: 'POST', body: bytes });
  const body = createJsonRequestBody(await context(request, 3600));
  await expect(body.json()).rejects.toThrow();
  expect(body.bytes).toEqual(bytes);
  expect(body.streamError).toBeNull();
});

test('createJsonRequestBody preserves source failure without Dump', async () => {
  const failure = new Error('client upload interrupted');
  const request = streamRequest(new ReadableStream({
    pull(controller) { controller.error(failure); },
  }));
  const body = createJsonRequestBody(await context(request, null));
  await expect(body.json()).rejects.toBe(failure);
  expect(body.bytes.byteLength).toBe(0);
});

test('createJsonRequestBody keeps the existing failed-upload Dump metadata', async () => {
  const failure = new Error('client\n upload interrupted');
  const request = streamRequest(new ReadableStream({
    pull(controller) { controller.error(failure); },
  }));
  const body = createJsonRequestBody(await context(request, 3600));
  await expect(body.json()).rejects.toThrow();
  expect(body.bytes.byteLength).toBe(0);
  expect(body.streamError).toBe('client upload interrupted');
  expect(takeRequestBody(body).streamError).toBe('client upload interrupted');
});

test('readRequestBody continues to retain binary bodies independently of Dump policy', async () => {
  const bytes = new Uint8Array([0, 255, 1, 254]);
  const request = new Request('http://localhost/v1/images/edits', { method: 'POST', body: bytes });
  const body = await readRequestBody(await context(request, null));
  expect(body.bytes).toEqual(bytes);
  expect(body.streamError).toBeNull();
});

import { test } from 'vitest';

import { prepareJsonModelRequest } from '../../../src/data-plane/shared/passthrough-request.ts';
import { assertEquals } from '@floway-dev/test-utils';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

test('prepareJsonModelRequest preserves an explicit model when a default is available', () => {
  const request = prepareJsonModelRequest(
    encode(JSON.stringify({ model: 'explicit-model', input: 'hello', extension: true })),
    'Test API',
    { defaultModel: 'default-model' },
  );

  assertEquals(request, {
    type: 'ok',
    model: 'explicit-model',
    body: { model: 'explicit-model', input: 'hello', extension: true },
  });
});

test('prepareJsonModelRequest routes an omitted model through the default without mutating the body', () => {
  const request = prepareJsonModelRequest(
    encode(JSON.stringify({ input: ['one', 'two'], extension: { mode: 'future' } })),
    'Test API',
    { defaultModel: 'default-model' },
  );

  assertEquals(request, {
    type: 'ok',
    model: 'default-model',
    body: { input: ['one', 'two'], extension: { mode: 'future' } },
  });
});

test('prepareJsonModelRequest still rejects an omitted model when no default is configured', () => {
  assertEquals(
    prepareJsonModelRequest(encode(JSON.stringify({ input: 'hello' })), 'Test API'),
    {
      type: 'invalid',
      message: 'Test API request body must include a model string.',
    },
  );
});

test('prepareJsonModelRequest does not replace an invalid explicit model with the default', () => {
  for (const model of ['', null, 42, false, {}]) {
    assertEquals(
      prepareJsonModelRequest(
        encode(JSON.stringify({ model, input: 'hello' })),
        'Test API',
        { defaultModel: 'default-model' },
      ),
      {
        type: 'invalid',
        message: 'Test API request body must include a model string.',
      },
    );
  }
});

test('prepareJsonModelRequest rejects invalid JSON roots before applying a default', () => {
  assertEquals(
    prepareJsonModelRequest(encode('{not-json'), 'Test API', { defaultModel: 'default-model' }),
    {
      type: 'invalid',
      message: 'Test API request body must be valid JSON.',
    },
  );

  for (const value of [null, [], 'text', 1, true]) {
    assertEquals(
      prepareJsonModelRequest(encode(JSON.stringify(value)), 'Test API', { defaultModel: 'default-model' }),
      {
        type: 'invalid',
        message: 'Test API request body must be an object.',
      },
    );
  }
});

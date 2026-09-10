import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { cloneStoredOpenAIResponsesItem } from '../../src/repo/openai-responses-clone.ts';

test('isolates stored image item containers and preserves private structured values', () => {
  const item = {
    type: 'message', role: 'user',
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
    metadata: JSON.parse('{"__proto__":{"value":1},"future_field":[null,1]}') as Record<string, unknown>,
  };
  const privatePayload = { bytes: new Uint8Array([1, 2]), date: new Date(0) };
  const source = {
    id: 'msg_images', apiKeyId: 'key_images', itemHash: 'hash', refreshedAt: 0,
    payload: { item, private: privatePayload },
  };
  const cloned = cloneStoredOpenAIResponsesItem(source);
  expect(cloned).toEqual(source);
  expect(Object.hasOwn((cloned.payload.item as typeof item).metadata, '__proto__')).toBe(true);
  (cloned.payload.item as typeof item).content[0].image_url = 'changed';
  ((cloned.payload.item as typeof item).metadata.__proto__ as { value: number }).value = 2;
  (cloned.payload.private as typeof privatePayload).bytes[0] = 9;
  expect(item.content[0].image_url).toBe('data:image/png;base64,AAAA');
  expect(item.metadata.__proto__).toEqual({ value: 1 });
  expect(privatePayload.bytes[0]).toBe(1);
});

test('retaining stored image history copies does not allocate more image strings', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--experimental-strip-types', '--expose-gc',
    fileURLToPath(new URL('./openai-responses-clone-memory.ts', import.meta.url)),
  ]);
  const sample = JSON.parse(stdout) as { retainedBytes: number; lengths: number[]; imageBytes: number };
  expect(sample.lengths).toEqual(Array.from({ length: 4 }, () => sample.imageBytes + 4 * 'data:image/png;base64,'.length));
  // Allow generous container/runtime overhead, but less than one extra copy of
  // the 16 MiB image history. structuredClone retains three complete copies.
  expect(sample.retainedBytes).toBeLessThan(sample.imageBytes / 2);
});

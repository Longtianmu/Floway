import { expect, test, vi } from 'vitest';

import {
  parseStoredOpenAIResponsesPayload,
  prepareStoredOpenAIResponsesPayload,
  writePreparedStoredOpenAIResponsesPayload,
} from '../../src/repo/openai-responses-payload.ts';
import * as gzip from '../../src/shared/gzip.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';
import * as base64 from '@floway-dev/protocols/common';

const payload = (content: string) => ({
  item: { type: 'message', id: 'msg_payload', role: 'assistant', content },
  private: { search: ['one', 'two'] },
});

const largeContent = (): string => Array.from({ length: 4_096 }, () => crypto.randomUUID()).join('');

test('small OpenAI Responses payloads stay inline without a file relation', async () => {
  initFileStore(new MemoryFileStore());
  const expected = payload('small');
  const prepared = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);

  expect(prepared.file).toBeNull();
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, null)).resolves.toEqual(expected);
});

test('reads a fixed inline OpenAI Responses payload in the persisted format', async () => {
  initFileStore(new MemoryFileStore());
  const expected = {
    item: { type: 'message', id: 'msg_persisted', role: 'assistant', content: 'persisted' },
  };
  const descriptor = JSON.stringify({
    version: 1,
    storage: 'inline',
    encoding: 'gzip',
    payload: 'H4sIAAAAAAAAE0XKOwrAMAwE0btsrRPoMsHEizHEHyw1wfjuQVXKGd5GdTbohr+TUDSapUIIao60ck0uq+bMEKzxhEoWJ3WH4B7d2R2KH57zAX61IIJZAAAA',
  });
  await expect(parseStoredOpenAIResponsesPayload('msg_persisted', descriptor, null)).resolves.toEqual(expected);
});

test('OpenAI Responses persistence preserves Date and custom JSON values without cloning or measuring them first', async () => {
  const toJSON = vi.fn((key: string) => ({ preserved: 'Floway', key }));
  const input = {
    ...payload('custom JSON'),
    private: { date: new Date('2026-09-11T00:00:00.000Z'), custom: { toJSON } },
  };
  const prepared = await prepareStoredOpenAIResponsesPayload('msg_custom', 'key-a', input);
  expect(toJSON).toHaveBeenCalledTimes(1);
  expect(toJSON).toHaveBeenCalledWith('custom');
  await expect(parseStoredOpenAIResponsesPayload('msg_custom', prepared.payloadJson, null)).resolves.toStrictEqual({
    ...payload('custom JSON'),
    private: { date: '2026-09-11T00:00:00.000Z', custom: { preserved: 'Floway', key: 'custom' } },
  });
});

test('OpenAI Responses persistence rejects a boxed BigInt in cloned private state', async () => {
  const input = { ...payload('boxed BigInt'), private: structuredClone(Object(1n)) as object };
  await expect(prepareStoredOpenAIResponsesPayload('msg_bigint', 'key-a', input)).rejects.toThrow(TypeError);
});

test('large OpenAI Responses payloads use an external file whose key is not embedded in payload JSON', async () => {
  const files = new MemoryFileStore();
  initFileStore(files);
  const expected = payload(largeContent());
  const prepared = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);
  if (prepared.file === null) throw new Error('expected payload to spill');

  expect(prepared.payloadJson).not.toContain(prepared.file.key);
  await writePreparedStoredOpenAIResponsesPayload(prepared);
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, prepared.file.key)).resolves.toEqual(expected);
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, null))
    .rejects.toThrow('file key missing');
});

test('each prepared spill uses a unique object key', async () => {
  initFileStore(new MemoryFileStore());
  const expected = payload(largeContent());
  const first = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);
  const second = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);
  if (first.file === null || second.file === null) throw new Error('expected payloads to spill');

  expect(first.file.key).not.toBe(second.file.key);
});

test('spilled payload reads verify file integrity', async () => {
  const files = new MemoryFileStore();
  initFileStore(files);
  const prepared = await prepareStoredOpenAIResponsesPayload(
    'msg_payload',
    'key-a',
    payload(largeContent()),
  );
  if (prepared.file === null) throw new Error('expected payload to spill');

  await files.put(prepared.file.key, new Uint8Array([1, 2, 3]));
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, prepared.file.key))
    .rejects.toThrow(/size mismatch|hash mismatch/u);
});

test('OpenAI Responses persistence streams large image JSON without a complete UTF-8 or decoded text buffer', async () => {
  initFileStore(new MemoryFileStore());
  const expected = {
    item: {
      type: 'message',
      role: 'user',
      content: Array.from({ length: 10 }, (_, index) => ({
        type: 'input_image',
        image_url: `data:image/png;base64,${String(index).repeat(256 * 1024)}`,
      })),
    },
    private: { text: '你好 😀\ud800'.repeat(10_000), exponent: 1e21 },
  };
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    const prepared = await prepareStoredOpenAIResponsesPayload('msg_images', 'key-a', expected);
    await writePreparedStoredOpenAIResponsesPayload(prepared);
    const restored = await parseStoredOpenAIResponsesPayload('msg_images', prepared.payloadJson, prepared.file?.key ?? null);
    expect(restored).toStrictEqual(expected);
    expect(encode.mock.calls.length).toBeGreaterThan(10);
    for (const [text] of encode.mock.calls) expect(text?.length ?? 0).toBeLessThanOrEqual(16 * 1024);
    expect(decode.mock.calls.length).toBeGreaterThan(10);
    for (const [bytes] of decode.mock.calls) expect(bytes?.byteLength ?? 0).toBeLessThanOrEqual(64 * 1024);
  } finally {
    encode.mockRestore();
    decode.mockRestore();
  }
});

test('OpenAI Responses spill selection accounts for padded Base64 before encoding it', async () => {
  const overhead = JSON.stringify({ version: 1, storage: 'inline', encoding: 'gzip', payload: '' }).length;
  const largestInlineGzipLength = Math.floor((64 * 1024 - overhead) / 4) * 3;
  const compress = vi.spyOn(gzip, 'gzipStream');
  const encode = vi.spyOn(base64, 'encodeBase64');
  try {
    for (const length of [largestInlineGzipLength - 1, largestInlineGzipLength, largestInlineGzipLength + 1, 128 * 1024]) {
      compress.mockResolvedValueOnce(new Uint8Array(length));
      encode.mockClear();
      const prepared = await prepareStoredOpenAIResponsesPayload('msg_boundary', 'key-a', payload('boundary'));
      const descriptor: unknown = JSON.parse(prepared.payloadJson);
      const fitsInline = overhead + 4 * Math.ceil(length / 3) <= 64 * 1024;
      expect(descriptor).toMatchObject({ storage: fitsInline ? 'inline' : 'file' });
      expect(encode).toHaveBeenCalledTimes(fitsInline ? 1 : 0);
      expect(new TextEncoder().encode(prepared.payloadJson).byteLength).toBeLessThanOrEqual(64 * 1024);
    }
  } finally {
    compress.mockRestore();
    encode.mockRestore();
  }
});

test.each(['{"item":', '{"item":{}} null'])('stored OpenAI Responses rejects malformed streamed JSON and preserves its cause: %s', async json => {
  const compressed = await gzip.gzipBytes(new TextEncoder().encode(json));
  const descriptor = JSON.stringify({ version: 1, storage: 'inline', encoding: 'gzip', payload: base64.encodeBase64(compressed) });
  await expect(parseStoredOpenAIResponsesPayload('msg_invalid', descriptor, null)).rejects.toMatchObject({
    message: expect.stringContaining('Malformed stored OpenAI Responses payload JSON for id=msg_invalid'),
    cause: expect.any(Error),
  });
});

test('stored OpenAI Responses rejects a corrupt gzip trailer after a complete JSON object', async () => {
  const compressed = await gzip.gzipBytes(new TextEncoder().encode(JSON.stringify(payload('complete'))));
  compressed[compressed.length - 8] ^= 0x80;
  const descriptor = JSON.stringify({ version: 1, storage: 'inline', encoding: 'gzip', payload: base64.encodeBase64(compressed) });
  await expect(parseStoredOpenAIResponsesPayload('msg_corrupt', descriptor, null)).rejects.toMatchObject({
    message: expect.stringContaining('Malformed stored OpenAI Responses payload JSON for id=msg_corrupt'),
    cause: expect.any(Error),
  });
});

import { expect, test, vi } from 'vitest';

import { parseJsonStream } from '../../src/shared/json-stream.ts';

const byteStream = (chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
  });
};

const fixtures = [
  'null', 'true', 'false', '-0', '1e999', '-0.125e-2', '[]', '{}',
  '{"z":0,"2":2,"a":1,"1":1,"a":3,"__proto__":{"marker":true},"constructor":{"prototype":7}}',
  '{"__proto__":null,"a":1,"__proto__":[1,2]}',
  '["你好 😀", "\\ud800", "\\udc00", "\\ud800x", "\\ud800\\udc00", "\\ud800\\n"]',
  '["\\\"", "\\\\", "\\/", "\\b", "\\f", "\\n", "\\r", "\\t", "\\u0000", "\ufeff"]',
  '{"nested":[{},[],[true,false,null],{"text":"Floway"}]} \r\n\t',
];

test.each(fixtures)('streamed JSON preserves native JSON values across every byte split: %s', async (text) => {
  const bytes = new TextEncoder().encode(text);
  const expected: unknown = JSON.parse(text);
  for (let split = 0; split <= bytes.length; split++) {
    const stream = byteStream([bytes.subarray(0, split), bytes.subarray(split)]);
    const result = await parseJsonStream(stream);
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    if (result !== null && typeof result === 'object') {
      expect(Object.getPrototypeOf(result)).toBe(Object.getPrototypeOf(expected));
    }
    expect(stream.locked).toBe(false);
  }
});

test('streamed JSON preserves Request.json UTF-8 replacement and BOM behavior', async () => {
  const cases = [
    new Uint8Array([0xef, 0xbb, 0xbf, 0x22, 0xef, 0xbb, 0xbf, 0x22]),
    new Uint8Array([0x22, 0xff, 0x22]),
    new Uint8Array([0x22, 0xc0, 0xaf, 0x22]),
    new Uint8Array([0x22, 0xe0, 0xa0, 0x22]),
    new Uint8Array([0x22, 0xf0, 0x90, 0x80, 0x22]),
  ];
  for (const bytes of cases) {
    const expected: unknown = await new Response(bytes).json();
    const chunks = Array.from(bytes, byte => new Uint8Array([byte]));
    expect(await parseJsonStream(byteStream(chunks))).toStrictEqual(expected);
  }
});

test.each([
  '', ' ', '{', '[', '{"a":1', '[1,]', '{"a":1,}', '{"a":}', '01', '-01', '1.', '1e', '1e-', '-',
  'NaN', 'Infinity', 'undefined', '"\\x00"', '"\n"', '"a', '"\\u01"', '{}null', '{} {}', '1 2',
  'truex', '{}x', '\ufeff\ufeff{}', ' \ufeff{}', '[\ufeff{}]',
])('streamed JSON rejects malformed or trailing input: %s', async (text) => {
  const bytes = new TextEncoder().encode(text);
  const chunks = Array.from(bytes, byte => new Uint8Array([byte]));
  await expect(parseJsonStream(byteStream(chunks))).rejects.toThrow();
});

test('streamed JSON rejects a missing body', async () => {
  await expect(parseJsonStream(null)).rejects.toThrow();
});

test('streamed JSON propagates a source failure after a complete root and releases its reader', async () => {
  const failure = new Error('client disconnected');
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{}'));
      else controller.error(failure);
    },
  });
  await expect(parseJsonStream(stream)).rejects.toBe(failure);
  expect(reads).toBe(2);
  expect(stream.locked).toBe(false);
});

test('streamed JSON cancels invalid input and preserves its error when cancellation fails', async () => {
  let cancelReason: unknown;
  let reads = 0;
  const cancellationFailure = new Error('cancellation failed');
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode('[true x'));
    },
    cancel(reason: unknown) {
      cancelReason = reason;
      throw cancellationFailure;
    },
  }, { highWaterMark: 0 });
  let failure: unknown;
  try {
    await parseJsonStream(stream);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBe(cancellationFailure);
  expect(cancelReason).toBe(failure);
  expect(reads).toBe(1);
  expect(stream.locked).toBe(false);
});

test('streamed JSON decodes a large transport chunk in bounded pieces while preserving all images', async () => {
  const images = Array.from({ length: 10 }, (_, index) => ({
    type: 'input_image',
    image_url: `data:image/png;base64,${String(index).repeat(256 * 1024)}`,
  }));
  const expected = { input: [{ role: 'user', content: images }] };
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    expect(await parseJsonStream(byteStream([bytes]))).toStrictEqual(expected);
    expect(decode.mock.calls.length).toBeGreaterThan(10);
    for (const [input] of decode.mock.calls) {
      expect(input?.byteLength ?? 0).toBeLessThanOrEqual(64 * 1024);
    }
  } finally {
    decode.mockRestore();
  }
});

import { expect, test, vi } from 'vitest';

import { jsonBodyStream, jsonRequestBody } from '../src/json-request.ts';

const readChunks = async (body: ReturnType<typeof jsonRequestBody>): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body.open()) chunks.push(chunk);
  return chunks;
};

test.each([
  { plain: 'text', escaped: '\b\f\n\r\t"\\', unicode: '中文😀', lone: '\ud800' },
  { array: [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -0] },
  { exponent: 1e21, negativeExponent: -1e21, largeInteger: 1e20 },
  { omitted: undefined, retained: true, order: { second: 2, first: 1 } },
])('matches JSON.stringify bytes for JSON request values', async value => {
  const expected = JSON.stringify(value);
  const body = jsonRequestBody(value);

  expect(body.contentLength).toBe(new TextEncoder().encode(expected).byteLength);
  expect(await new Response(body.open()).text()).toBe(expected);
  expect(await new Response(body.open()).text()).toBe(expected);
});

test('streams a multi-image document without coalescing the complete payload', async () => {
  const image = 'A'.repeat(1024 * 1024);
  const value = { input: Array.from({ length: 4 }, (_, index) => ({ index, image })) };
  const body = jsonRequestBody(value);

  const chunks = await readChunks(body);
  const decoder = new TextDecoder();
  const output = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();

  expect(output).toBe(JSON.stringify(value));
  expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBeLessThan(body.contentLength / 2);
});

test('bounds encoded chunks for a single large image string', async () => {
  const value = { image: `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}` };
  const body = jsonRequestBody(value);
  const chunks = await readChunks(body);

  expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBeLessThanOrEqual(48 * 1024);
  expect(chunks.reduce((length, chunk) => length + chunk.byteLength, 0)).toBe(body.contentLength);
  expect(await new Response(body.open()).text()).toBe(JSON.stringify(value));
});

test('measures large request bodies using one reusable encoding buffer', () => {
  const value = {
    image: `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`,
    unicode: `${'中文😀'.repeat(20 * 1024)}\ud800`,
    exponent: 1e21,
  };
  const expectedLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  const encodeInto = vi.spyOn(TextEncoder.prototype, 'encodeInto');
  try {
    const body = jsonRequestBody(value);
    const buffers = new Set(encodeInto.mock.calls.map(([, buffer]) => buffer));

    expect(body.contentLength).toBe(expectedLength);
    expect(encode.mock.calls.length).toBe(0);
    expect(encodeInto.mock.calls.length).toBeGreaterThan(1);
    expect(buffers.size).toBe(1);
    expect([...buffers][0]?.byteLength).toBeLessThanOrEqual(48 * 1024);
  } finally {
    encode.mockRestore();
    encodeInto.mockRestore();
  }
});

test.each([-1, 0, 1])('preserves Unicode at an encoding boundary with offset %s', async offset => {
  const value = {
    image: `${'中'.repeat(16 * 1024 - '{"image":"'.length - 1 + offset)}😀${'中'.repeat(32 * 1024)}\ud800`,
  };
  const expected = JSON.stringify(value);
  const body = jsonRequestBody(value);
  const chunks = await readChunks(body);
  const decoder = new TextDecoder('utf-8', { fatal: true });

  expect(chunks.map(chunk => decoder.decode(chunk)).join('')).toBe(expected);
  expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBeLessThanOrEqual(48 * 1024);
  expect(body.contentLength).toBe(new TextEncoder().encode(expected).byteLength);
  expect(chunks.reduce((length, chunk) => length + chunk.byteLength, 0)).toBe(body.contentLength);
});

test('rejects circular request values before dispatch', () => {
  const value: { self?: unknown } = {};
  value.self = value;

  expect(() => jsonRequestBody(value)).toThrow();
});

test('replays the bytes captured when the body is created', async () => {
  const value = {
    nested: { text: 'before' },
  };
  const body = jsonRequestBody(value);
  value.nested.text = 'after';

  expect(await new Response(body.open()).text()).toBe('{"nested":{"text":"before"}}');
  expect(await new Response(body.open()).text()).toBe('{"nested":{"text":"before"}}');
  expect(body.contentLength).toBe(28);
});

test('JSON body streams preserve Date and the root, object, and array toJSON keys', async () => {
  const calls: string[] = [];
  const keyedValue = {
    toJSON(key: string) {
      calls.push(key);
      return { key };
    },
  };
  for (const value of [keyedValue, { named: keyedValue }, [keyedValue], new Date('2026-09-11T00:00:00.000Z')]) {
    const expected = JSON.stringify(value);
    const expectedCalls = calls.splice(0);
    expect(await new Response(jsonBodyStream(value)).text()).toBe(expected);
    expect(calls.splice(0)).toEqual(expectedCalls);
  }
});

test('JSON body streams preserve boxed primitives and subclass coercion', async () => {
  class NumberSubclass extends Number {
    override valueOf(): number { return 23; }
  }
  class StringSubclass extends String {
    override toString(): string { return 'Floway'; }
  }
  class BooleanSubclass extends Boolean {
    override valueOf(): boolean { return true; }
  }
  const values: object[] = [
    Object(7) as object, Object('text') as object, Object(false) as object,
    new NumberSubclass(7), new StringSubclass('text'), new BooleanSubclass(false),
  ];
  for (const value of values) {
    expect(await new Response(jsonBodyStream({ value })).text()).toBe(JSON.stringify({ value }));
  }
});

test('JSON body streams reject boxed BigInt and Number coercion to BigInt', async () => {
  class BigIntCoercingNumber extends Number {
    [Symbol.toPrimitive](): bigint { return 1n; }
  }
  const values: object[] = [structuredClone(Object(1n)) as object, new BigIntCoercingNumber(1)];
  for (const value of values) {
    expect(() => JSON.stringify({ value })).toThrow(TypeError);
    await expect(new Response(jsonBodyStream({ value })).text()).rejects.toThrow(TypeError);
  }
});

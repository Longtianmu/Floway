import { stringifyChunked } from '@discoveryjs/json-ext';
import { expect, test } from 'vitest';

import { jsonBodyStream } from '../src/json-request.ts';

test.each(['root', 'object', 'array'] as const)('bounds temporary JSON text for a long image string in %s position', location => {
  const image = `data:image/png;base64,${'QUJD'.repeat(256 * 1024)}`;
  const value = location === 'root' ? image : location === 'array' ? [image, 'after'] : { image, after: true };
  const chunks = [...stringifyChunked(value)];

  expect(chunks.join('')).toBe(JSON.stringify(value));
  expect(chunks.length).toBeGreaterThan(10);
  // This checks the text produced before UTF-8 encoding: bounding byte chunks
  // alone still allows the serializer to allocate one complete image copy.
  expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(128 * 1024);
});

test.each([-1, 0, 1])('preserves escapes and surrogate pairs at a JSON string boundary with offset %s', async offset => {
  const value = {
    image: `${'A'.repeat(16 * 1024 - 1 + offset)}😀${'"\\\n\u0000中文😀'.repeat(20 * 1024)}\ud800`,
    after: ['retained', null],
  };
  const chunks = [...stringifyChunked(value)];

  expect(chunks.join('')).toBe(JSON.stringify(value));
  expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(128 * 1024);
  expect(await new Response(jsonBodyStream(value)).text()).toBe(JSON.stringify(value));
});

test('resumes the parent container after a long string produced by toJSON or a replacer', () => {
  const longValue = 'Floway 😀'.repeat(20 * 1024);
  const value = { before: 1, nested: [{ toJSON: (key: string) => `${key}:${longValue}` }], replace: 'placeholder', after: 2 };
  const replacer = (key: string, entry: unknown): unknown => key === 'replace' ? longValue : entry;

  expect([...stringifyChunked(value, replacer, 2)].join('')).toBe(JSON.stringify(value, replacer, 2));
  expect([...stringifyChunked(value, ['before', 'nested', 'after'], 2)].join(''))
    .toBe(JSON.stringify(value, ['before', 'nested', 'after'], 2));
});

test('finishes long root strings before advancing JSONL records', () => {
  const values = ['A'.repeat(40 * 1024), { image: '中😀'.repeat(20 * 1024), after: true }, 'B'.repeat(50 * 1024)];

  expect([...stringifyChunked(values, { mode: 'jsonl', space: 2 })].join(''))
    .toBe(values.map(value => JSON.stringify(value, null, 2)).join('\n'));
});

test('retains circular-value errors after a long string', () => {
  const value: { image: string; self?: unknown } = { image: 'A'.repeat(40 * 1024) };
  value.self = value;

  expect(() => [...stringifyChunked(value)]).toThrow(TypeError);
});

test('cancelling a long JSON string stops before reading subsequent properties', async () => {
  let readAfter = false;
  const value = {
    image: 'A'.repeat(1024 * 1024),
    get after() {
      readAfter = true;
      return 'after';
    },
  };
  const reader = jsonBodyStream(value).getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  await reader.cancel('client disconnected');
  reader.releaseLock();

  expect(readAfter).toBe(false);
});

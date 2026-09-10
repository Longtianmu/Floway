import { expect, test } from 'vitest';

import { analyzeGeminiGenerateContentAffinity } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstreamId: upstream },
    model: { id: 'model' },
  });
};

const targetFor = (value: ModelCandidate): AffinityTarget => ({
  upstreamId: value.provider.upstreamId,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
});

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

test('keeps image history intact and nested candidate edits isolated', async () => {
  const payload: GeminiGenerateContentPayload = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }],
  };
  const prepared = await analyzeGeminiGenerateContentAffinity(payload, codec);
  const projection = acceptedAffinityEvaluation(prepared, candidateA);
  const first = projection.materialize();
  expect(first).toEqual(payload);
  const image = first.contents?.[0].parts[0].inlineData;
  if (image === undefined) throw new Error('Expected the original image block');
  image.data = 'BBBB';

  expect(acceptedAffinityEvaluation(prepared, candidateB).materialize()).toEqual(payload);
  expect(payload.contents?.[0].parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]);
});

test('removes originless affinity by protocol shape and preserves visible content and foreign signatures', async () => {
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const prepared = await analyzeGeminiGenerateContentAffinity({
    contents: [{
      role: 'model',
      parts: [
        { text: 'answer' },
        { thoughtSignature: synthetic },
        { text: 'synthetic on content', thoughtSignature: synthetic },
        { text: 'foreign', thoughtSignature: 'not-floway' },
      ],
    }],
  }, codec);

  expect(acceptedAffinityEvaluation(prepared, candidateA).materialize().contents?.[0].parts).toEqual([
    { text: 'answer' },
    { text: 'synthetic on content' },
    { text: 'foreign', thoughtSignature: 'not-floway' },
  ]);
});

test.each([
  { text: '' },
  { thought: true },
])('removes metadata-only remnants after stripping an incompatible owned signature', async metadata => {
  const owned = await codec.wrap('natural', targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const prepared = await analyzeGeminiGenerateContentAffinity({
    contents: [{ role: 'model', parts: [{ ...metadata, thoughtSignature: owned }] }],
  }, codec);

  expect(acceptedAffinityEvaluation(prepared, candidateB).materialize().contents).toEqual([]);
});

test('preserves unrelated empty model contents', async () => {
  const prepared = await analyzeGeminiGenerateContentAffinity({
    contents: [{ role: 'model', parts: [] }],
  }, codec);

  expect(acceptedAffinityEvaluation(prepared, candidateA).materialize().contents).toEqual([{ role: 'model', parts: [] }]);
});

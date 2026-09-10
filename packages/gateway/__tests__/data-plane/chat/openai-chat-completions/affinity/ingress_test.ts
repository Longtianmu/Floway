import { expect, test } from 'vitest';

import { analyzeOpenAIChatCompletionsAffinity } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
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

test('restores owned opaque state only for its exact candidate', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const carrier = await codec.wrap('upstream-signature', targetFor(candidateA), 'openai-chat-completions.reasoning_opaque');
  const prepared = await analyzeOpenAIChatCompletionsAffinity({
    model: 'model',
    messages: [{ role: 'assistant', content: 'answer', reasoning_opaque: carrier }],
  }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionA.materialize().messages[0]).toMatchObject({ reasoning_opaque: 'upstream-signature' });
  expect(projectionB.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
});

test('keeps image history intact and nested candidate edits isolated', async () => {
  const payload: OpenAIChatCompletionsPayload = {
    model: 'model',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
  };
  const prepared = await analyzeOpenAIChatCompletionsAffinity(payload, codec);
  const projection = acceptedAffinityEvaluation(prepared, candidate('upstream-a'));
  const first = projection.materialize();
  expect(first).toEqual(payload);
  const content = first.messages[0].content;
  if (!Array.isArray(content) || content[0].type !== 'image_url') throw new Error('Expected the original image block');
  content[0].image_url.url = 'data:image/png;base64,BBBB';

  expect(acceptedAffinityEvaluation(prepared, candidate('upstream-b')).materialize()).toEqual(payload);
  expect(payload.messages[0].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
});

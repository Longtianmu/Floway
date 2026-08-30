import { describe, expect, it } from 'vitest';

import { discoveredModelsFromResponse } from '../../../src/components/upstream-editor/data';
import { ENDPOINT_PATHS, PATH_OVERRIDE_PATHS } from '../../../src/components/upstream-editor/endpoints';
import { modelsAreValid } from '../../../src/components/upstream-editor/model-validation';
import type { UpstreamModelConfig } from '@floway-dev/provider/model-config';

describe('custom discovered model projection', () => {
  it('maps fixed kinds to their own endpoint families', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'moderator', kind: 'moderation', endpoints: { openaiModerations: {} } },
        { id: 'speech', kind: 'transcription', endpoints: { openaiAudioTranscriptions: {} } },
        { id: 'ranker', kind: 'rerank', endpoints: { rerank: {} } },
      ],
    });

    expect(models[0]?.endpoints).toEqual({ openaiModerations: {} });
    expect(models[1]?.endpoints).toEqual({ openaiAudioTranscriptions: {} });
    expect(models[2]?.endpoints).toEqual({ rerank: {} });
  });

  it('uses the native moderation path in endpoint labels and Custom overrides', () => {
    expect(ENDPOINT_PATHS.openaiModerations).toBe('/moderations');
    expect(PATH_OVERRIDE_PATHS).toContain('/moderations');
  });

  it('uses the owning provider projection, including server-side id inference', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'omni-moderation-latest', kind: 'moderation', endpoints: { openaiModerations: {} } },
        { id: 'talker', kind: 'chat', endpoints: { openaiResponses: {} } },
      ],
    });

    expect(models[0]).toMatchObject({
      upstreamModelId: 'omni-moderation-latest',
      kind: 'moderation',
      endpoints: { openaiModerations: {} },
    });
    expect(models[1]?.endpoints).toEqual({ openaiResponses: {} });
  });

  it('preserves chat metadata exactly when the configured endpoints resolve to chat', () => {
    const chat = {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['none', 'high'], default: 'high' } },
    } satisfies NonNullable<UpstreamModelConfig['chat']>;

    const chatModel = discoveredModelsFromResponse({
      kind: 'custom',
      data: [{ id: 'vision', kind: 'chat', endpoints: { openaiResponses: {} }, chat }],
    });
    const embeddingModel = discoveredModelsFromResponse({
      kind: 'custom',
      data: [{ id: 'vision', kind: 'embedding', endpoints: { openaiEmbeddings: {} }, chat }],
    });

    expect(chatModel[0]?.chat).toEqual(chat);
    expect(embeddingModel[0]?.chat).toBeUndefined();
  });

  it('projects every discovered row into a shape the gateway accepts', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'talker', kind: 'chat', endpoints: { openaiChatCompletions: {} } },
        { id: 'painter', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } },
        { id: 'moderator', kind: 'moderation', endpoints: { openaiModerations: {} } },
        { id: 'speech', kind: 'transcription', endpoints: { openaiAudioTranscriptions: {} } },
        { id: 'ranker', kind: 'rerank', endpoints: { rerank: {} } },
      ],
    });

    expect(modelsAreValid(models)).toBe(true);
  });
});

describe('manual model validation', () => {
  it('rejects the same incomplete identities and endpoint contracts as the gateway', () => {
    expect(modelsAreValid([{ upstreamModelId: '', kind: 'chat', endpoints: { openaiChatCompletions: {} } }])).toBe(false);
    expect(modelsAreValid([{ upstreamModelId: 'ranker', kind: 'rerank', endpoints: { rerank: {} } }])).toBe(false);
    expect(modelsAreValid([{
      upstreamModelId: 'ranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }])).toBe(true);
  });
});

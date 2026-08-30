import { test } from 'vitest';

import { inferEndpointsFromModelId } from '../src/infer-endpoints.ts';
import { createCustomProvider, projectEffectiveCustomRawModel } from '../src/provider.ts';
import { directFetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const OPENAI_EMBEDDINGS = { openaiEmbeddings: {} };
const OPENAI_IMAGES = { openaiImagesGenerations: {}, openaiImagesEdits: {} };
const OPENAI_AUDIO = { openaiAudioTranscriptions: {} };
const OPENAI_MODERATIONS = { openaiModerations: {} };

test('inferEndpointsFromModelId returns OpenAI Embeddings for known OpenAI / Voyage / Cohere / Mistral families', () => {
  for (const id of [
    'text-embedding-3-small',
    'text-embedding-3-large',
    'text-embedding-ada-002',
    'voyage-3',
    'voyage-multilingual-2',
    'voyage-code-3',
    'embed-english-v3.0',
    'embed-multilingual-light-v3.0',
    'mistral-embed',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), OPENAI_EMBEDDINGS);
  }
});

test('inferEndpointsFromModelId returns OpenAI Embeddings for common local / open-weight embedding families', () => {
  for (const id of [
    'bge-large-en-v1.5',
    'BAAI/bge-large-en',
    'gte-large-en-v1.5',
    'e5-large-v2',
    'intfloat/multilingual-e5-large',
    'nomic-embed-text-v1',
    'mxbai-embed-large-v1',
    'WhereIsAI/UAE-Large-V1',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), OPENAI_EMBEDDINGS);
  }
});

test('inferEndpointsFromModelId returns null (chat fallback) for typical chat model ids', () => {
  for (const id of [
    'gpt-4o',
    'gpt-5.4-pro',
    'o1-preview',
    'claude-opus-4-7',
    'claude-haiku-4-5',
    'deepseek-v3',
    'llama-3.1-70b-instruct',
    'gemini-2.0-flash',
    'mistral-large-latest',
    'command-r-plus',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), null);
  }
});

test('inferEndpointsFromModelId returns both image endpoints for the gpt-image-* family', () => {
  for (const id of [
    'gpt-image-1',
    'gpt-image-1-mini',
    'gpt-image-1.5',
    'gpt-image-2',
    'gpt-image-2-2026-04-21',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), OPENAI_IMAGES);
  }
});

test('inferEndpointsFromModelId returns null for non-OpenAI image families and gpt-4o-image variants', () => {
  for (const id of [
    'dall-e-3',
    'dall-e-2',
    'flux-pro',
    'flux.1-schnell',
    'stable-diffusion-3.5',
    'sdxl-turbo',
    'imagen-4.0-generate-001',
    'gpt-4o-image-experimental',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), null);
  }
});

test('inferEndpointsFromModelId returns audio transcription for standard transcribe and whisper families', () => {
  for (const id of [
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe-2025-12-15',
    'gpt-4o-transcribe-diarize',
    'whisper-1',
    'openai/whisper-large-v3',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), OPENAI_AUDIO);
  }
});

test('inferEndpointsFromModelId recognizes only published OpenAI moderation model families', () => {
  for (const id of [
    'omni-moderation-latest',
    'omni-moderation-2024-09-26',
    'text-moderation-latest',
    'text-moderation-stable',
    'text-moderation-007',
    'openai/OMNI-MODERATION-LATEST',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), OPENAI_MODERATIONS);
  }

  for (const id of [
    'moderation-helper',
    'my-omni-moderation-model',
    'omni-moderation-experimental',
    'text-moderation-chat',
    'text-moderation-008',
  ]) {
    assertEquals(inferEndpointsFromModelId(id), null);
  }
});

test('projectEffectiveCustomRawModel exposes the same moderation projection to control and data planes', () => {
  assertEquals(
    projectEffectiveCustomRawModel(
      { id: 'openai/omni-moderation-latest', display_name: 'Moderation' },
      { openaiChatCompletions: {} },
    ),
    {
      id: 'openai/omni-moderation-latest',
      display_name: 'Moderation',
      kind: 'moderation',
      endpoints: OPENAI_MODERATIONS,
    },
  );
  assertEquals(
    projectEffectiveCustomRawModel(
      { id: 'vendor-model', kind: 'moderation' },
      { openaiChatCompletions: {} },
    ),
    { id: 'vendor-model', kind: 'moderation', endpoints: OPENAI_MODERATIONS },
  );
});

test('Custom provider projects gpt-image-* models with kind=image and both image endpoints', async () => {
  const record: UpstreamRecord = {
    id: 'up_custom_image',
    kind: 'custom',
    name: 'Custom Image',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  };
  await withMockedFetch(
    request => {
      if (new URL(request.url).pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2-2026-04-21' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await createCustomProvider(record).instance.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'gpt-image-2-2026-04-21');
      assertEquals(models[0].kind, 'image');
      assertEquals(models[0].endpoints, OPENAI_IMAGES);
    },
  );
});

test('Custom provider projects only identified moderation catalog rows as moderation', async () => {
  const record: UpstreamRecord = {
    id: 'up_custom_moderation',
    kind: 'custom',
    name: 'Custom Moderation',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  };
  await withMockedFetch(
    request => {
      if (new URL(request.url).pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'omni-moderation-latest' }, { id: 'moderation-helper' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await createCustomProvider(record).instance.getProvidedModels(directFetcher);
      assertEquals(models.map(({ id, kind, endpoints }) => ({ id, kind, endpoints })), [
        { id: 'omni-moderation-latest', kind: 'moderation', endpoints: OPENAI_MODERATIONS },
        { id: 'moderation-helper', kind: 'chat', endpoints: { openaiChatCompletions: {} } },
      ]);
    },
  );
});

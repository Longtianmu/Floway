import { describe, expect, it } from 'vitest';

import { parseModels, serializeModels } from '../../../src/components/upstream-editor/models-yaml';
import { i18n } from '../../../src/i18n';

const CHAT_MODEL = { upstreamModelId: 'gpt-5', kind: 'chat', endpoints: { openaiChatCompletions: {} } } as const;
const MODERATION_MODEL = { upstreamModelId: 'omni-moderation-latest', kind: 'moderation', endpoints: { openaiModerations: {} } } as const;
const RERANK_MODEL = { upstreamModelId: 'rerank-v2', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } } as const;
const NON_CUSTOM_OPTIONS = { allowModeration: false, allowRerank: false } as const;

describe('models YAML round trip', () => {
  it('parses back what it serialized', () => {
    const parsed = parseModels(serializeModels([{ ...CHAT_MODEL }]), NON_CUSTOM_OPTIONS);
    expect(parsed).toEqual({ ok: true, models: [CHAT_MODEL] });
  });

  it('accepts a hand-written YAML list', () => {
    const parsed = parseModels('- upstreamModelId: gpt-5\n  kind: chat\n  endpoints:\n    openaiChatCompletions: {}\n', NON_CUSTOM_OPTIONS);
    expect(parsed.ok).toBe(true);
  });
});

describe('models YAML rejection', () => {
  it('reports a syntax error rather than throwing', () => {
    const parsed = parseModels('- upstreamModelId: [', NON_CUSTOM_OPTIONS);
    expect(parsed.ok).toBe(false);
  });

  it('rejects a payload that is not an array', () => {
    const parsed = parseModels('upstreamModelId: gpt-5\n', NON_CUSTOM_OPTIONS);
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.ok === false && parsed.message).toContain('must be an array');
  });

  it('applies the same validation the gateway does', () => {
    const parsed = parseModels('- upstreamModelId: gpt-5\n  kind: telepathy\n  endpoints: {}\n', NON_CUSTOM_OPTIONS);
    expect(parsed.ok).toBe(false);
  });

  it('rejects a rerank model on an upstream that cannot host one', () => {
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), NON_CUSTOM_OPTIONS))
      .toEqual({ ok: false, message: i18n.t('dashboard.upstreamEditor.models.yamlRerankRequiresCustom') });
    expect(parseModels(serializeModels([{ ...RERANK_MODEL }]), { allowModeration: false, allowRerank: true }).ok).toBe(true);
  });

  it('rejects a rerank model with no target, which the gateway would refuse', () => {
    const parsed = parseModels('- upstreamModelId: r\n  kind: rerank\n  endpoints:\n    rerank: {}\n', { allowModeration: false, allowRerank: true });
    expect(parsed.ok).toBe(false);
  });

  it('rejects moderation models outside Custom and accepts them for Custom', () => {
    expect(parseModels(serializeModels([{ ...MODERATION_MODEL }]), NON_CUSTOM_OPTIONS))
      .toEqual({ ok: false, message: i18n.t('dashboard.upstreamEditor.models.yamlModerationRequiresCustom') });
    expect(parseModels(serializeModels([{ ...MODERATION_MODEL }]), { allowModeration: true, allowRerank: true }).ok).toBe(true);
  });

  it('does not let another declared kind hide a moderation endpoint', () => {
    const model = {
      ...CHAT_MODEL,
      endpoints: { openaiChatCompletions: {}, openaiModerations: {} },
    };
    expect(parseModels(serializeModels([model]), NON_CUSTOM_OPTIONS).ok).toBe(false);
  });
});

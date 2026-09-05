import { describe, expect, test } from 'vitest';

import {
  OPENAI_RESPONSES_LITE_HEADER,
  OPENAI_RESPONSES_LITE_REMOTE_IMAGE_MESSAGE,
  OPENAI_RESPONSES_LITE_WS_METADATA_KEY,
  convertOpenAIResponsesTransport,
  openAIResponsesTransportForRequest,
  toLiteOpenAIResponsesPayload,
  toStandardOpenAIResponsesPayload,
  type CanonicalOpenAIResponsesPayload,
} from '../../src/openai-responses/index.ts';

const standard = (): CanonicalOpenAIResponsesPayload => ({
  model: 'gpt-test',
  instructions: 'Be concise.',
  tools: [{ type: 'function', name: 'lookup', description: 'Look up data', parameters: { type: 'object' } }],
  input: [{ type: 'message', role: 'user', content: 'Hello' }],
  parallel_tool_calls: true,
  reasoning: { effort: 'high' },
});

describe('Responses Lite transport', () => {
  test('moves instructions and tools into stable leading input items', () => {
    const first = toLiteOpenAIResponsesPayload({ ...standard(), prompt_cache_key: 'thread-42' });
    expect(first.instructions).toBeUndefined();
    expect(first.tools).toBeUndefined();
    expect(first.parallel_tool_calls).toBe(false);
    expect(first.reasoning).toEqual({ effort: 'high', context: 'all_turns' });
    expect(first.input[0]).toMatchObject({ type: 'additional_tools', role: 'developer' });
    expect(first.input[1]).toMatchObject({
      type: 'message', role: 'developer',
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    });
    expect((first.input[0] as { id?: string }).id).toBe('at_17fa34f8-3490-5b00-b57e-0ced35add3b0');
    expect((first.input[1] as { id?: string }).id).toBe('msg_9904dc4f-4f34-54f2-bf6c-b171457ae84a');
    expect((first.input[0] as { tools?: unknown }).tools).toEqual([{
      type: 'namespace', name: 'functions', description: '', tools: standard().tools,
    }]);
    expect(first).toEqual(toLiteOpenAIResponsesPayload({ ...standard(), prompt_cache_key: 'thread-42' }));
  });

  test('restores a Lite request to the standard wire shape', () => {
    const restored = toStandardOpenAIResponsesPayload(toLiteOpenAIResponsesPayload(standard()));
    expect(restored.instructions).toBe('Be concise.');
    expect(restored.tools).toEqual(standard().tools);
    expect(restored.input).toEqual(standard().input);
  });

  test('rejects conflicting Lite top-level instructions', () => {
    const lite = toLiteOpenAIResponsesPayload(standard());
    expect(() => toStandardOpenAIResponsesPayload({ ...lite, instructions: 'conflict' })).toThrow(/must not declare/);
  });

  test('detects HTTP and per-message WebSocket markers', () => {
    const headers = new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'true' });
    expect(openAIResponsesTransportForRequest(standard(), headers)).toBe('lite');
    expect(openAIResponsesTransportForRequest({
      ...standard(), client_metadata: { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'false' },
    }, headers)).toBe('standard');
  });

  test('prepares inline images and replaces unsupported remote images', () => {
    const converted = toLiteOpenAIResponsesPayload({
      ...standard(),
      input: [{
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: 'Describe both images.' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'original' },
          { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' },
        ],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: [null, 'custom.inline_image', 'user.image'],
        },
      }],
    });
    const message = converted.input.at(-1);
    expect(message).toMatchObject({
      type: 'message',
      content: [
        { type: 'input_text', text: 'Describe both images.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
        { type: 'input_text', text: OPENAI_RESPONSES_LITE_REMOTE_IMAGE_MESSAGE },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['unknown', 'custom.inline_image', 'images.preparation_error'],
      },
    });
    expect(JSON.stringify(message)).not.toContain('detail');
    expect(JSON.stringify(message)).not.toContain('example.com');
  });

  test('accepts only Lite client tools and client-executed tool search', () => {
    const accepted = toLiteOpenAIResponsesPayload({
      ...standard(),
      tools: [
        { type: 'custom', name: 'shell', format: { type: 'grammar' } },
        { type: 'tool_search', execution: 'client', description: 'Find a tool', parameters: { type: 'object' } },
      ],
    });
    expect((accepted.input[0] as { tools: unknown[] }).tools).toHaveLength(2);

    expect(() => toLiteOpenAIResponsesPayload({
      ...standard(), tools: [{ type: 'web_search' }],
    })).toThrow(/does not support.*web_search/);
    expect(() => toLiteOpenAIResponsesPayload({
      ...standard(), tools: [{ type: 'tool_search', execution: 'server' }],
    })).toThrow(/client-executed tool_search/);
  });

  test('normalizes Lite-to-Lite requests through the standard shape', () => {
    const lite = toLiteOpenAIResponsesPayload(standard());
    const normalized = convertOpenAIResponsesTransport(lite, 'lite', 'lite');
    expect(normalized.input.filter(item => item.type === 'additional_tools')).toHaveLength(1);
    expect(normalized.input[0]).toMatchObject({ type: 'additional_tools', role: 'developer' });
  });
});

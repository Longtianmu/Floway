import { describe, expect, test } from 'vitest';

import {
  OPENAI_RESPONSES_LITE_HEADER,
  OPENAI_RESPONSES_LITE_REMOTE_IMAGE_MESSAGE,
  OPENAI_RESPONSES_LITE_WS_METADATA_KEY,
  OpenAIResponsesLiteInputError,
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
    expect((first.input[1] as { id?: string }).id).toBe('msg_9904dc4f-4f34-54f2-bf6c-b171457ae84a');
    expect((first.input[0] as { tools?: unknown }).tools).toEqual(standard().tools);
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

  test('preserves tool capabilities without a transport-owned allowlist', () => {
    const accepted = toLiteOpenAIResponsesPayload({
      ...standard(),
      tools: [
        { type: 'custom', name: 'shell', format: { type: 'grammar' } },
        { type: 'tool_search', execution: 'server' },
        { type: 'web_search' },
        { type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'lookup' }] },
      ],
    });
    expect((accepted.input[0] as { tools: unknown[] }).tools).toHaveLength(4);
    expect(toStandardOpenAIResponsesPayload(accepted).tools).toEqual((accepted.input[0] as { tools: unknown[] }).tools);
  });

  test('preserves native Lite prefix identities, chronological controls and open values', () => {
    const lite = toLiteOpenAIResponsesPayload(standard());
    lite.input[0] = { ...lite.input[0], id: 'at_client_owned' };
    lite.reasoning = { effort: 'ultra', context: 'future_context' };
    lite.input.push({ type: 'additional_tools', role: 'developer', id: 'at_later', tools: [] });
    lite.client_metadata = { [OPENAI_RESPONSES_LITE_WS_METADATA_KEY]: 'true', thread_id: 'client-thread' };
    const normalized = convertOpenAIResponsesTransport(lite, 'lite', 'lite');
    expect(normalized).toEqual({ ...lite, client_metadata: { thread_id: 'client-thread' } });
  });

  test('does not rename forced tools or replayed tool calls', () => {
    const payload: CanonicalOpenAIResponsesPayload = {
      ...standard(),
      tool_choice: { type: 'function', name: 'lookup' },
      input: [{ type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{}', status: 'completed' }],
    };
    const lite = toLiteOpenAIResponsesPayload(payload);
    expect((lite.input[0] as { tools: unknown[] }).tools).toEqual(payload.tools);
    expect(lite.tool_choice).toEqual(payload.tool_choice);
    expect(lite.input.at(-1)).toEqual(payload.input[0]);
  });

  test('keeps mixed instruction provenance in the original message', () => {
    const message: CanonicalOpenAIResponsesPayload['input'][number] = {
      type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: 'Base' }, { type: 'input_text', text: 'Update' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions', 'user.instructions'] },
    };
    const result = toStandardOpenAIResponsesPayload({ model: 'gpt-test', input: [message] });
    expect(result.input).toEqual([message]);
    expect(result.instructions).toBeUndefined();
  });

  test('preserves non-remote image references and case-insensitive data schemes', () => {
    const lite = toLiteOpenAIResponsesPayload({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'DATA:image/png;base64,AQID', detail: 'original' },
        { type: 'input_image', file_id: 'file_image', detail: 'high' },
      ] }],
    });
    expect(lite.input.at(-1)).toMatchObject({ content: [
      { type: 'input_image', image_url: 'DATA:image/png;base64,AQID' },
      { type: 'input_image', file_id: 'file_image' },
    ] });
    expect(JSON.stringify(lite)).not.toContain('detail');
  });

  test('reports invalid client transport markers as input errors', () => {
    expect(() => openAIResponsesTransportForRequest(standard(), new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'invalid' })))
      .toThrow(OpenAIResponsesLiteInputError);
  });
});

import type { Context } from 'hono';

import { apiKeyFromContext, type AuthedContext } from '../../middleware/auth.ts';
import { parseJsonStream } from '../../shared/json-stream.ts';

// Inbound body bytes the handler reads once and forwards into the dump
// accumulator (so the handler's payload parser AND the dump see the same
// bytes without a second read). `streamError` surfaces a client mid-upload
// abort as a non-null message; the dump records it as `meta.error`.
export interface RequestBody {
  bytes: Uint8Array;
  readonly streamError: string | null;
}

export interface JsonRequestBody extends RequestBody {
  json(): Promise<unknown>;
}

// Chat handlers need the parsed payload, while only Dump needs the original
// wire bytes. Keep parsing lazy so failures stay inside each protocol's existing
// error handler and captured bytes remain available to its dump accumulator.
export const createJsonRequestBody = (c: AuthedContext): JsonRequestBody => {
  const capture = apiKeyFromContext(c).dumpRetentionSeconds !== null;
  let streamError: string | null = null;
  const body: JsonRequestBody = {
    bytes: new Uint8Array(),
    get streamError() { return streamError; },
    async json() {
      if (!capture) return await parseJsonStream(c.req.raw.body);
      const captured = await readRequestBody(c);
      body.bytes = captured.bytes;
      streamError = captured.streamError;
      return await parseJsonStream(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.bytes);
          controller.close();
        },
      }));
    },
  };
  return body;
};

// Transfers the byte buffer into the request context after payload parsing.
// Async HTTP handlers keep their local RequestBody across the upstream wait;
// clearing that slot prevents it from retaining the full wire body after the
// dump pipeline (when enabled) has started preparing its own representation.
export const takeRequestBody = (source: RequestBody): RequestBody => {
  const owned = { bytes: source.bytes, streamError: source.streamError };
  source.bytes = new Uint8Array();
  return owned;
};

// Reads the inbound body in full into a Uint8Array; the handler parses its
// payload off the same buffer so the wire body is consumed exactly once. A
// read failure (client aborted upload) surfaces as a non-null `streamError`
// instead of throwing — the dump captures the partial payload + the cause,
// the handler still sees a parse error of its own.
export const readRequestBody = async (c: Context): Promise<RequestBody> => {
  if (c.req.raw.body === null) return { bytes: new Uint8Array(), streamError: null };
  try {
    return { bytes: new Uint8Array(await c.req.raw.arrayBuffer()), streamError: null };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    return { bytes: new Uint8Array(), streamError: msg.length > 500 ? `${msg.slice(0, 497)}…` : msg };
  }
};

import { parse } from 'jsonriver';

// Bound the temporary text/UTF-8 representations even when a transport delivers
// the entire request as one chunk. The parsed object still owns its string values.
const JSON_CHUNK_SIZE = 64 * 1024;

const parseChunks = async (chunks: AsyncIterable<string>): Promise<unknown> => {
  let result: unknown;
  // jsonriver reuses the partially built object. Continue through EOF: a complete
  // root can be followed by invalid trailing input or a source read failure.
  // https://github.com/rictic/jsonriver/blob/d736560d72719af4f8fcbde09e50074875124cec/src/parse.ts
  for await (const value of parse(chunks)) result = value;
  return result;
};

const decodeChunks = async function* (reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<string> {
  // Match Request.json(): replace malformed UTF-8 and strip only the leading BOM.
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let offset = 0; offset < value.byteLength; offset += JSON_CHUNK_SIZE) {
      yield decoder.decode(value.subarray(offset, offset + JSON_CHUNK_SIZE), { stream: true });
    }
  }
  yield decoder.decode();
};

export const parseJsonStream = async (stream: ReadableStream<Uint8Array> | null): Promise<unknown> => {
  if (stream === null) throw new SyntaxError('Unexpected end of JSON input');
  const reader = stream.getReader();
  try {
    return await parseChunks(decodeChunks(reader));
  } catch (error) {
    // The parser may reject before EOF. Stop the upload, but a cleanup failure
    // must not replace the original parse error or client disconnect cause.
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
};

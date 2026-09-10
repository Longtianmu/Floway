import { stringifyChunked } from '@discoveryjs/json-ext';
import { klona } from 'klona/json';

import type { ReplayableBody } from './options.ts';

const encodeChunks = function* (chunks: Iterable<string>): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  // stringifyChunked's highWaterMark does not split an individual string.
  // Bound each encoded allocation to 48 KiB even for large inline images.
  // https://github.com/discoveryjs/json-ext/blob/457d4d9d4e55bb1e14fde192715114b80e20c4c9/src/stringify-chunked.js
  for (const chunk of chunks) {
    for (let start = 0; start < chunk.length;) {
      let end = Math.min(start + 16 * 1024, chunk.length);
      const last = chunk.charCodeAt(end - 1);
      const next = chunk.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      yield encoder.encode(chunk.slice(start, end));
      start = end;
    }
  }
};

export function* jsonByteChunks(value: unknown): Generator<Uint8Array> {
  yield* encodeChunks(stringifyChunked(value));
}

// json-ext's stringifyInfo() counts integer digits without generating the
// serialized output, but it does not apply JSON's exponent formatting: it
// reports 24 bytes for {x: 1e21}, while stringifyChunked() and JSON.stringify()
// emit the 11-byte {"x":1e+21}. Framing must therefore measure the exact chunks.
// https://github.com/discoveryjs/json-ext/blob/457d4d9d4e55bb1e14fde192715114b80e20c4c9/src/stringify-info.js#L70-L118
const serializedLength = (value: object): number => {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(16 * 1024);
  let length = 0;
  // Measuring needs no retained bytes. Reuse the buffer instead of allocating
  // the complete request's worth of byte chunks before opening its stream.
  for (const chunk of stringifyChunked(value)) {
    for (let start = 0; start < chunk.length;) {
      const { read, written } = encoder.encodeInto(chunk.slice(start), buffer);
      start += read;
      length += written;
      if (!Number.isSafeInteger(length)) throw new RangeError('Serialized JSON body exceeds the supported content length');
    }
  }
  return length;
};

export const jsonRequestBody = (value: object): ReplayableBody => {
  const snapshot = klona(value);
  return {
    contentLength: serializedLength(snapshot),
    open: () => {
      const bytes = jsonByteChunks(snapshot);
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = bytes.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          bytes.return(undefined);
        },
      });
    },
  };
};

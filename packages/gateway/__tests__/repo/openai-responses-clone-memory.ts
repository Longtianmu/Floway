import { cloneStoredOpenAIResponsesItem } from '../../src/repo/openai-responses-clone.ts';
import type { StoredOpenAIResponsesItem } from '../../src/repo/types.ts';

// Run in a fresh process so unrelated Vitest workers cannot affect the sample.
// Decode distinct buffers to materialize the strings before the baseline; repeat()
// alone can leave ropes whose later flattening would distort the measurement.
const imageBytes = 4 * 1024 * 1024;
const prefix = new TextEncoder().encode('data:image/png;base64,');
const source: StoredOpenAIResponsesItem = {
  id: 'msg_images',
  apiKeyId: 'key_images',
  itemHash: 'image-history',
  refreshedAt: 0,
  payload: {
    item: {
      type: 'message',
      role: 'user',
      content: Array.from({ length: 4 }, (_, index) => {
        const bytes = new Uint8Array(prefix.byteLength + imageBytes).fill(65 + index);
        bytes.set(prefix);
        return { type: 'input_image', image_url: new TextDecoder().decode(bytes) };
      }),
    },
  },
};

if (globalThis.gc === undefined) throw new Error('Memory regression requires --expose-gc');
globalThis.gc();
const before = process.memoryUsage().heapUsed;
// The session backing, request-local cache and hydrated input must own separate
// containers, but retaining them together must not multiply the image strings.
const copies = Array.from({ length: 3 }, () => cloneStoredOpenAIResponsesItem(source));
globalThis.gc();
const retainedBytes = process.memoryUsage().heapUsed - before;
// Read after measuring to ensure all copies and the original stay live.
const lengths = [source, ...copies].map(row => {
  const item = row.payload.item as { content: { image_url: string }[] };
  return item.content.reduce((sum, part) => sum + part.image_url.length, 0);
});
process.stdout.write(JSON.stringify({ retainedBytes, lengths, imageBytes: imageBytes * 4 }));

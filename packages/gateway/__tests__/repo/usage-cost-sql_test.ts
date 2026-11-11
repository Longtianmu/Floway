import { describe, expect, it } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo, UsageRecord } from '../../src/repo/types.ts';

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'key', model: 'model', modelKey: 'model', upstream: 'selected', hour: '2026-11-12T10',
  requests: 1, pricingSelector: {}, metrics: [{ metric: 'input_tokens', quantity: '3', unitPrice: '0.1' }], ...overrides,
});

for (const [name, create] of [
  ['SQL', async (): Promise<Repo> => new SqlRepo(await createSqliteTestDb())],
  ['memory', async (): Promise<Repo> => new InMemoryRepo()],
] as const) {
  describe(`${name} upstream usage cost`, () => {
    const query = (repo: Repo) => repo.usage.queryCost({ upstreamId: 'selected', start: '2026-11-12T10', end: '2026-11-12T12' });

    it('sums exact price snapshots across keys and selectors within the selected upstream and hours', async () => {
      const repo = await create();
      await repo.usage.set(record());
      await repo.usage.set(record({ keyId: 'another', pricingSelector: { serviceTier: 'priority' } }));
      await repo.usage.set(record({ hour: '2026-11-12T11', metrics: [{ metric: 'output_tokens', quantity: '7', unitPrice: '0.01' }] }));
      await repo.usage.set(record({ upstream: 'other' }));
      await repo.usage.set(record({ hour: '2026-11-12T09' }));
      await repo.usage.set(record({ hour: '2026-11-12T12' }));
      expect(await query(repo)).toBe('0.67');
    });

    it('withholds a partial cost when any consumed metric is unpriced', async () => {
      const repo = await create();
      await repo.usage.set(record());
      await repo.usage.set(record({ keyId: 'unpriced', metrics: [{ metric: 'output_tokens', quantity: '1', unitPrice: null }] }));
      expect(await query(repo)).toBeNull();
    });

    it('does not treat missing billing metrics as zero spend', async () => {
      const repo = await create();
      expect(await query(repo)).toBeNull();
      await repo.usage.set(record());
      await repo.usage.set(record({ keyId: 'unreported', metrics: [] }));
      expect(await query(repo)).toBeNull();
    });

    it('keeps a known zero price and ignores unpriced zero quantities', async () => {
      const repo = await create();
      await repo.usage.set(record({
        metrics: [
          { metric: 'input_tokens', quantity: '4', unitPrice: '0' },
          { metric: 'output_tokens', quantity: '0', unitPrice: null },
        ],
      }));
      expect(await query(repo)).toBe('0');
    });
  });
}

import type { QuotaRevision, UserQuotasRepo, UsersRepo } from '../../src/repo/types.ts';
import type { QuotaRecord } from '../../src/user-quotas/schema.ts';

export class MemoryUserQuotasRepo implements UserQuotasRepo {
  private records = new Map<string, QuotaRevision>();

  constructor(private readonly users: UsersRepo) {}

  async list(userId?: number, upstreamId?: string | null): Promise<QuotaRevision[]> {
    return [...this.records.values()].filter(row => (userId === undefined || row.userId === userId)
      && (upstreamId === undefined || row.upstreamId === null || row.upstreamId === upstreamId))
      .sort((a, b) => a.userId - b.userId || (a.upstreamId ?? '').localeCompare(b.upstreamId ?? ''))
      .map(row => structuredClone(row));
  }

  async get(id: string): Promise<QuotaRevision | null> {
    return structuredClone(this.records.get(id) ?? null);
  }

  async insert(record: QuotaRecord): Promise<boolean> {
    if (await this.users.getById(record.userId) === null || this.records.has(record.id)
      || [...this.records.values()].some(row => row.userId === record.userId && row.upstreamId === record.upstreamId)) return false;
    this.records.set(record.id, { ...structuredClone(record), revision: crypto.randomUUID() });
    return true;
  }

  async replaceIfCurrent(records: readonly QuotaRevision[]): Promise<boolean> {
    if (!records.every(row => this.records.get(row.id)?.revision === row.revision)) return false;
    for (const row of records) this.records.set(row.id, { ...structuredClone(row), revision: crypto.randomUUID() });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async deleteByUserId(userId: number): Promise<void> {
    for (const [id, record] of this.records) if (record.userId === userId) this.records.delete(id);
  }

  async deleteAll(): Promise<void> {
    this.records.clear();
  }
}

import type { QuotaRevision, UserQuotasRepo } from './types.ts';
import { quotaRecordSchema, type QuotaRecord } from '../user-quotas/schema.ts';
import type { SqlBindValue, SqlDatabase } from '@floway-dev/platform';

const columns = `id, user_id AS userId, upstream_id AS upstreamId, limit_usd AS limitUsd, enforce,
  reset_json AS resetJson, starts_at AS startsAt, spent_usd AS spentUsd, unpriced, revision`;
type QuotaRow = Omit<QuotaRevision, 'enforce' | 'reset' | 'unpriced'> & {
  enforce: number;
  resetJson: string;
  unpriced: number;
};

const decode = ({ resetJson, revision, enforce, unpriced, ...row }: QuotaRow): QuotaRevision => ({
  ...quotaRecordSchema.parse({ ...row, reset: JSON.parse(resetJson), enforce: enforce === 1, unpriced: unpriced === 1 }),
  revision,
});

export class SqlUserQuotasRepo implements UserQuotasRepo {
  constructor(private readonly db: SqlDatabase) {}

  async list(userId?: number, upstreamId?: string | null): Promise<QuotaRevision[]> {
    const filters: string[] = [];
    const params: SqlBindValue[] = [];
    if (userId !== undefined) {
      filters.push('user_id = ?');
      params.push(userId);
    }
    if (upstreamId !== undefined) {
      filters.push("(COALESCE(upstream_id, '') = '' OR COALESCE(upstream_id, '') = ?)");
      params.push(upstreamId ?? '');
    }
    const { results } = await this.db.prepare(`
      SELECT ${columns} FROM user_quotas
      ${filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`}
      ORDER BY user_id, upstream_id, id
    `).bind(...params).all<QuotaRow>();
    return results.map(decode);
  }

  async get(id: string): Promise<QuotaRevision | null> {
    const row = await this.db.prepare(`SELECT ${columns} FROM user_quotas WHERE id = ?`).bind(id).first<QuotaRow>();
    return row === null ? null : decode(row);
  }

  async insert(record: QuotaRecord): Promise<boolean> {
    const row = await this.db.prepare(`
      INSERT INTO user_quotas (id, user_id, upstream_id, limit_usd, enforce, reset_json, starts_at, spent_usd, unpriced, revision)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL)
      ON CONFLICT DO NOTHING RETURNING id
    `).bind(record.id, record.userId, record.upstreamId, record.limitUsd, +record.enforce, JSON.stringify(record.reset),
      record.startsAt, record.spentUsd, +record.unpriced, crypto.randomUUID(), record.userId).first<{ id: string }>();
    return row !== null;
  }

  // A charge can affect both the total and an upstream allowance. Neither
  // moves unless both revisions still match; retrying cannot double-charge one.
  async replaceIfCurrent(records: readonly QuotaRevision[]): Promise<boolean> {
    const rows = records.map(record => ({
      id: record.id,
      revision: record.revision,
      limitUsd: record.limitUsd,
      enforce: +record.enforce,
      reset: JSON.stringify(record.reset),
      startsAt: record.startsAt,
      spentUsd: record.spentUsd,
      unpriced: +record.unpriced,
    }));
    if (rows.length === 0) return true;
    const { results } = await this.db.prepare(`
      WITH updates AS MATERIALIZED (
        SELECT value->>'id' AS id, value->>'revision' AS revision, value->>'limitUsd' AS limit_usd,
          value->>'enforce' AS enforce, value->>'reset' AS reset_json, value->>'startsAt' AS starts_at,
          value->>'spentUsd' AS spent_usd, value->>'unpriced' AS unpriced
        FROM json_each(?)
      ), valid AS MATERIALIZED (
        SELECT COUNT(*) = (SELECT COUNT(*) FROM updates) AS matches
        FROM updates JOIN user_quotas USING (id, revision)
      )
      UPDATE user_quotas AS quota
      SET limit_usd = updates.limit_usd, enforce = updates.enforce, reset_json = updates.reset_json,
          starts_at = updates.starts_at, spent_usd = updates.spent_usd, unpriced = updates.unpriced, revision = ?
      FROM updates
      WHERE quota.id = updates.id AND (SELECT matches FROM valid)
      RETURNING id
    `).bind(JSON.stringify(rows), crypto.randomUUID()).all<{ id: string }>();
    if (results.length !== 0 && results.length !== rows.length) throw new Error('Floway: partial quota update');
    return results.length === rows.length;
  }

  async delete(id: string): Promise<boolean> {
    const row = await this.db.prepare('DELETE FROM user_quotas WHERE id = ? RETURNING id').bind(id).first<{ id: string }>();
    return row !== null;
  }

  async deleteByUserId(userId: number): Promise<void> {
    await this.db.prepare('DELETE FROM user_quotas WHERE user_id = ?').bind(userId).run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM user_quotas').run();
  }
}

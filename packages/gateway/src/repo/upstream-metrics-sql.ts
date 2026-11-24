import type { UpstreamMetricRecord, UpstreamMetricsRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { normalizeUpstreamMetricIdentity, type UpstreamMetricIdentity, type UpstreamMetricLabels, type UpstreamMetricResetThreshold } from '@floway-dev/provider';

export const UPSTREAM_METRICS_INTERVAL_MS = 60_000;
const columns = 'upstream_id AS upstreamId, metric_name AS name, metric_labels AS labelsJson, timestamp, value';
type SqlUpstreamMetricRecord = Omit<UpstreamMetricRecord, 'labels'> & { labelsJson: string };

const encodeIdentity = ({ name, labels }: UpstreamMetricIdentity) => {
  const normalized = normalizeUpstreamMetricIdentity(name, labels);
  return { name: normalized.name, labelsJson: JSON.stringify(normalized.labels) };
};

const decodeRecords = (records: SqlUpstreamMetricRecord[]): UpstreamMetricRecord[] => records.map(({ labelsJson, ...record }) => ({
  ...record,
  ...normalizeUpstreamMetricIdentity(record.name, JSON.parse(labelsJson) as UpstreamMetricLabels),
}));

export class SqlUpstreamMetricsRepo implements UpstreamMetricsRepo {
  constructor(private db: SqlDatabase) {}

  async record(record: UpstreamMetricRecord): Promise<void> {
    const identity = encodeIdentity(record);
    // Every observation is a gauge sample, unchanged values included: a sample
    // records that the value was observed, which a change log cannot express.
    // Each bucket keeps its latest sample, so a delayed observation can still
    // fill an older minute without replacing a newer sample from that minute.
    await this.db.prepare(`
      INSERT INTO upstream_metrics (upstream_id, metric_name, metric_labels, bucket, timestamp, value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE SET
        timestamp = excluded.timestamp, value = excluded.value
      WHERE excluded.timestamp >= upstream_metrics.timestamp
    `).bind(record.upstreamId, identity.name, identity.labelsJson, Math.floor(record.timestamp / UPSTREAM_METRICS_INTERVAL_MS), record.timestamp, record.value).run();
  }

  async listAll(): Promise<UpstreamMetricRecord[]> {
    const { results } = await this.db.prepare(`SELECT ${columns} FROM upstream_metrics ORDER BY timestamp, upstreamId, name, labelsJson`).all<SqlUpstreamMetricRecord>();
    return decodeRecords(results);
  }

  async set(record: UpstreamMetricRecord): Promise<void> {
    const identity = encodeIdentity(record);
    await this.db.prepare(`
      INSERT INTO upstream_metrics (upstream_id, metric_name, metric_labels, bucket, timestamp, value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (upstream_id, metric_name, metric_labels, bucket) DO UPDATE SET
        timestamp = excluded.timestamp, value = excluded.value
    `).bind(record.upstreamId, identity.name, identity.labelsJson, Math.floor(record.timestamp / UPSTREAM_METRICS_INTERVAL_MS), record.timestamp, record.value).run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM upstream_metrics').run();
  }

  async query(upstreamId: string, start: number, end: number, step: number): Promise<UpstreamMetricRecord[]> {
    const { results } = await this.db.prepare(`
      SELECT upstreamId, name, labelsJson, timestamp, value FROM (
        SELECT ${columns}, ROW_NUMBER() OVER (
          PARTITION BY metric_name, metric_labels, CAST((timestamp - ?) / ? AS INTEGER) ORDER BY timestamp DESC
        ) AS recency
        FROM upstream_metrics
        WHERE timestamp >= ? AND timestamp < ? AND upstream_id = ?
      )
      WHERE recency = 1
      ORDER BY timestamp, upstreamId, name, labelsJson
    `).bind(start, step, start, end, upstreamId).all<SqlUpstreamMetricRecord>();
    return decodeRecords(results);
  }

  async listIdentities(upstreamId: string): Promise<UpstreamMetricIdentity[]> {
    const { results } = await this.db.prepare(`
      SELECT DISTINCT metric_name AS name, metric_labels AS labelsJson
      FROM upstream_metrics WHERE upstream_id = ? ORDER BY metric_name, metric_labels
    `).bind(upstreamId).all<{ name: string; labelsJson: string }>();
    return results.map(({ name, labelsJson }) => normalizeUpstreamMetricIdentity(name, JSON.parse(labelsJson)));
  }

  async latestReset(upstreamId: string, identity: UpstreamMetricIdentity, threshold: UpstreamMetricResetThreshold, after: number, through: number): Promise<number | null> {
    const metric = encodeIdentity(identity);
    const series = [upstreamId, metric.name, metric.labelsJson];
    const full = threshold.full;
    const allowance = typeof full === 'number' ? null : encodeIdentity(full);
    // Include the last sample before the search window to recognise a
    // transition in its first sample. An allowance change alone is not a refill.
    const fullValue = allowance === null ? '?' : `(SELECT value FROM upstream_metrics
      WHERE upstream_id = ? AND metric_name = ? AND metric_labels = ?
        AND bucket = sample.bucket AND timestamp = sample.timestamp AND value > 0)`;
    const row = await this.db.prepare(`
      WITH prior AS (
        SELECT timestamp, bucket, value FROM upstream_metrics
        WHERE upstream_id = ? AND metric_name = ? AND metric_labels = ? AND timestamp <= ?
        ORDER BY timestamp DESC LIMIT 1
      ), samples AS (
        SELECT * FROM prior
        UNION ALL
        SELECT timestamp, bucket, value FROM upstream_metrics
        WHERE upstream_id = ? AND metric_name = ? AND metric_labels = ? AND timestamp > ? AND timestamp <= ?
      ), observations AS (
        SELECT timestamp, value, ${fullValue} AS full_value FROM samples sample
      ), transitions AS (
        SELECT timestamp, value, full_value, LAG(value) OVER cycle AS previous_value,
          LAG(full_value) OVER cycle AS previous_full
        FROM observations WINDOW cycle AS (ORDER BY timestamp)
      )
      SELECT timestamp FROM transitions
      WHERE timestamp > ? AND value = full_value AND previous_value ${threshold.direction === 'used' ? '>' : '<'} previous_full
        ${allowance === null ? '' : 'AND value > previous_value'}
      ORDER BY timestamp DESC LIMIT 1
    `).bind(...series, after, ...series, after, through,
      ...(allowance === null ? [full as number] : [upstreamId, allowance.name, allowance.labelsJson]), after).first<{ timestamp: number }>();
    return row?.timestamp ?? null;
  }
}

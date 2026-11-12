import { expect, it } from 'vitest';

import { parseCodexQuotaHeaders } from '../src/quota.ts';
import { codexMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';
import { upstreamMetricAxisPriority } from '@floway-dev/provider/browser';

it('uses actual durations and active limits to identify reordered Codex windows', () => {
  const snapshot = { observed_at: '2026-10-01T00:00:00Z', active_limit: 'codex', primary_used_percent: 25, primary_window_minutes: 300, secondary_used_percent: 50, secondary_window_minutes: 10080, credits_balance: 0 };
  const reordered = { ...snapshot, primary_used_percent: 50, primary_window_minutes: 10080, secondary_used_percent: 25, secondary_window_minutes: 300 };
  expect(codexMetrics(snapshot).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
    .toEqual(codexMetrics(reordered).toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  const identity = { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } };
  expect(resolveUpstreamMetricDisplay(identity, { quotaDisplay: 'remaining' })).toMatchObject({ name: '', unit: 'percent', axisPriority: upstreamMetricAxisPriority.subscriptionQuota, windowSeconds: 18_000, emptyValue: null, form: 'area' });
  expect(codexMetrics(snapshot).find(metric => metric.name === 'credits.balance')?.value).toBe(0);
  expect(codexMetrics({ observed_at: snapshot.observed_at, primary_used_percent: 50 })).toHaveLength(0);
});

it('displays the direction the preference names while preserving credit balances', () => {
  const identity = { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } };
  const remaining = resolveUpstreamMetricDisplay(identity, { quotaDisplay: 'remaining' })!;
  expect(remaining.labelKey).toBe('dashboard.upstreamMetrics.metrics.remaining');
  expect([0, 25, 100].map(remaining.toDisplayValue)).toEqual([100, 75, 0]);
  const used = resolveUpstreamMetricDisplay(identity, { quotaDisplay: 'used' })!;
  expect(used.labelKey).toBe('dashboard.upstreamMetrics.metrics.usage');
  expect([0, 25, 100].map(used.toDisplayValue)).toEqual([0, 25, 100]);
  const credits = resolveUpstreamMetricDisplay({ name: 'credits.balance', labels: {} }, { quotaDisplay: 'used' })!;
  expect(credits.axisPriority).toBe(upstreamMetricAxisPriority.purchasedBalance);
  expect(credits.toDisplayValue(200)).toBe(200);
});

it('retains cost eligibility for the default header window under the premium active limit', () => {
  const snapshot = parseCodexQuotaHeaders(new Headers({
    'x-codex-active-limit': 'premium',
    'x-codex-primary-used-percent': '25',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-secondary-window-minutes': '0',
  }), { now: new Date('2026-11-12T12:00:00Z'), isRateLimited: false });
  const metrics = codexMetrics(snapshot);
  expect(metrics).toHaveLength(1);
  const display = resolveUpstreamMetricDisplay(metrics[0]!, { quotaDisplay: 'used' })!;
  expect(display).toMatchObject({ costScope: 'upstream', windowSeconds: 604_800 });
  expect(display.toDisplayValue(metrics[0]!.value)).toBe(25);
  for (const limit of ['codex_bengalfox', 'imagegen_premium']) {
    expect(resolveUpstreamMetricDisplay({ ...metrics[0]!, labels: { limit, window_seconds: 604_800 } }, { quotaDisplay: 'used' })?.costScope).toBeUndefined();
  }
});

import { screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { QuotaEstimates } from '../../../src/components/upstreams/quota-estimates';
import { renderInApp } from '../../render';

afterEach(() => vi.unstubAllGlobals());

const estimates = {
  upstreamId: 'selected', available: true, estimates: [
    { window: 'five-hour', spentUsd: '10', fullQuotaUsd: '40', reason: null },
    { window: 'week', spentUsd: '20', fullQuotaUsd: '80', reason: null },
  ],
};

it('shows both current window estimates without depending on chart filters', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(estimates));
  vi.stubGlobal('fetch', fetch);
  renderInApp(<QuotaEstimates upstreamId="selected" loadedAt={123} />);
  expect(await screen.findByText('Current 5-hour cycle · est. spent $10.00 / est. full quota $40.00')).toBeTruthy();
  expect(screen.getByText('Current weekly cycle · est. spent $20.00 / est. full quota $80.00')).toBeTruthy();
  const url = new URL(String(fetch.mock.calls[0]![0]), 'http://localhost');
  expect(url.pathname).toBe('/api/upstream-quota-estimates');
  expect([...url.searchParams]).toEqual([['upstream_id', 'selected'], ['end', '123']]);
});

it('hides the note without telemetry access and does not present a failure as zero', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ upstreamId: 'selected', available: false, estimates: [] })));
  renderInApp(<QuotaEstimates upstreamId="selected" loadedAt={123} />);
  await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
});

it('makes unavailable estimates explicit and preserves a known spend', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    ...estimates, estimates: [
      { window: 'five-hour', spentUsd: '10', fullQuotaUsd: null, reason: 'no-consumption' },
    ],
  })));
  renderInApp(<QuotaEstimates upstreamId="selected" loadedAt={123} />);
  expect(await screen.findByText('Current 5-hour cycle · est. spent $10.00 / est. full quota Cannot estimate')).toBeTruthy();
});

it('reports a failed request and aborts pending work when the panel unmounts', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return Promise.reject(new Error('offline'));
  }));
  const { unmount } = renderInApp(<QuotaEstimates upstreamId="selected" loadedAt={123} />);
  expect(await screen.findByText('Could not load quota estimates.')).toBeTruthy();
  unmount();
  expect(signal?.aborted).toBe(true);
});

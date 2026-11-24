import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { Quota } from '../../../src/components/user-quotas/data';
import { QuotaTable } from '../../../src/components/user-quotas/table';
import { stubMatchMedia } from '../../match-media-stub';
import { renderInApp } from '../../render';

const rule = (id: string, userId: number, username: string, extra?: Partial<Quota>): Quota => ({
  id, userId, username, upstreamId: null, upstreamName: null, reset: { kind: 'manual' },
  resetSourceName: null, resetDisplay: null, startsAt: 0, renewsAt: null, resetAvailable: true,
  waitingForReset: false, partialHistory: false, enforce: true, limitUsd: '10', spentUsd: '3',
  ratio: '0.3', severity: 'brand', unpriced: false,
  ...extra,
});
const first = rule('alice-total', 1, 'Alice');
const second = rule('alice-chat', 1, 'Alice', { upstreamId: 'chat', upstreamName: 'ChatGPT', enforce: false });
const third = rule('bob-total', 2, 'Bob');
const actions = { edit: vi.fn(), confirm: vi.fn() };

const setMatch = stubMatchMedia(() => false);

afterEach(() => vi.useRealTimers());

test.each([false, true])('groups admin quotas by user on a narrow viewport: %s', narrow => {
  setMatch(query => narrow && query === '(max-width: 1050px)');
  renderInApp(<QuotaTable quotas={[first, second, third]} actions={actions} disabled={false} />);
  const alice = screen.getByRole('button', { name: 'Alice 2 quotas' });
  const bob = screen.getByRole('button', { name: 'Bob 1 quota' });
  expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  expect(alice.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(alice);
  expect(alice.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('ChatGPT')).toBeTruthy();
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.getAllByText('Requests are blocked when the limit is reached')).toHaveLength(1);
  expect(screen.queryByText('Monitoring only')).toBeNull();
  fireEvent.click(bob);
  expect(screen.getAllByRole('progressbar')).toHaveLength(3);
  fireEvent.click(alice);
  expect(screen.queryByText('ChatGPT')).toBeNull();
  expect(screen.getAllByRole('progressbar')).toHaveLength(1);
});

test('shows a member their own rules without an administrator disclosure', () => {
  renderInApp(<QuotaTable quotas={[{ ...first, partialHistory: true }, second]} disabled={false} />);
  expect(screen.queryByRole('button', { name: /Alice/ })).toBeNull();
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(screen.getAllByText('Requests are blocked when the limit is reached')).toHaveLength(1);
  expect(screen.queryByText('Monitoring only')).toBeNull();
  expect(screen.getByText('Some historical usage in the first hour could not be attributed to this period')).toBeTruthy();
});

test('shows only relative reset times and updates them while the quotas are open', () => {
  const now = Date.parse('2026-11-24T21:45:00Z');
  vi.useFakeTimers({ now, toFake: ['Date', 'setInterval', 'clearInterval'] });
  const reset = { kind: 'upstream', upstreamId: 'chat', metric: { name: 'quota', labels: {} } } as const;
  const calendar = { ...first, reset: { kind: 'day' } as const, renewsAt: Date.parse('2026-11-25T00:00:00Z') };
  const timed = { ...second, reset, renewsAt: now + 120_000 };
  const manual = rule('manual', 1, 'Alice');
  const unavailable = rule('unavailable', 1, 'Alice', { reset, resetAvailable: false });
  const waiting = rule('waiting', 1, 'Alice', { reset, waitingForReset: true });
  renderInApp(<QuotaTable quotas={[calendar, timed, manual, unavailable, waiting]} disabled={false} />);
  expect(screen.getByText('Resets in 2h 15m')).toBeTruthy();
  expect(screen.getByText('Resets in 0h 2m')).toBeTruthy();
  expect(screen.getByText('Manual')).toBeTruthy();
  expect(screen.getByText('Reset upstream unavailable')).toBeTruthy();
  expect(screen.getByText('No upstream reset observed yet')).toBeTruthy();
  expect(screen.queryByText(/^Started /)).toBeNull();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByText('Resets in 0h 1m')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.queryByText(/^Resets in 0h /)).toBeNull();
  expect(screen.getByText('Reset time unavailable')).toBeTruthy();
});

test.each([
  ['2026-11-27T07:45:00Z', '2d 7h'],
  ['2026-11-26T00:00:00.001Z', '1d 0h'],
  ['2026-11-26T00:00:00Z', '24h 0m'],
  ['2026-11-25T23:59:00Z', '23h 59m'],
  ['2026-11-25T00:00:01Z', '0h 1m'],
])('formats the reset countdown ending %s as %s', (timestamp, duration) => {
  vi.useFakeTimers({ now: Date.parse('2026-11-25T00:00:00Z'), toFake: ['Date', 'setInterval', 'clearInterval'] });
  const quota = rule('scheduled', 1, 'Alice', { reset: { kind: 'month' }, renewsAt: Date.parse(timestamp) });
  renderInApp(<QuotaTable quotas={[quota]} disabled={false} />);
  expect(screen.getByText(`Resets in ${duration}`)).toBeTruthy();
});

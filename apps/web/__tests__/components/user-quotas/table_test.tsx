import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

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
const second = rule('alice-chat', 1, 'Alice', { upstreamId: 'chat', upstreamName: 'ChatGPT' });
const third = rule('bob-total', 2, 'Bob');
const actions = { edit: vi.fn(), confirm: vi.fn() };

const setMatch = stubMatchMedia(() => false);

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
  expect(screen.getByText('Some historical usage in the first hour could not be attributed to this period')).toBeTruthy();
});

import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import type { Quota } from '../../../src/components/user-quotas/data';
import { QuotaProgress } from '../../../src/components/user-quotas/progress';
import { renderInApp } from '../../render';

const quota: Quota = {
  id: 'quota-id',
  userId: 2,
  upstreamId: null,
  username: 'tester',
  upstreamName: null,
  reset: { kind: 'manual' },
  resetSourceName: null,
  resetDisplay: null,
  startsAt: 0,
  renewsAt: null,
  resetAvailable: true,
  enforce: false,
  limitUsd: '2',
  spentUsd: '2.5',
  ratio: '1.25',
  severity: 'error',
  unpriced: true,
};

test('keeps the full percentage available after the bar reaches its maximum', () => {
  const { container } = renderInApp(<QuotaProgress quota={quota} />);
  const bar = screen.getByRole('progressbar', { name: 'Quota used' });
  expect(bar.getAttribute('aria-valuenow')).toBe('100');
  expect(bar.getAttribute('aria-valuetext')).toBe('125%');
  expect(container.querySelector('[data-quota-level="error"]')).not.toBeNull();
  expect(screen.getByText('Some usage has no pricing')).toBeTruthy();
});

test('distinguishes a just-exceeded allowance from 100%', () => {
  renderInApp(<QuotaProgress quota={{ ...quota, ratio: '1.000001', spentUsd: '2.000002' }} />);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('>100%');
});

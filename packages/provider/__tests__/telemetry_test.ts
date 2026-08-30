import { test } from 'vitest';

import { parsePerformanceOperation } from '../src/telemetry.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('parsePerformanceOperation accepts moderation as a concrete gateway operation', () => {
  assertEquals(parsePerformanceOperation('moderation'), 'moderation');
});

test('parsePerformanceOperation keeps rejecting unregistered operations', () => {
  assertThrows(
    () => parsePerformanceOperation('moderations'),
    Error,
    'Invalid performance operation',
  );
});

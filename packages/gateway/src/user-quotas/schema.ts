import { z } from 'zod';

import { decimalStringIsZero, parseNonNegativeDecimalString } from '@floway-dev/protocols/common';
import { normalizeUpstreamMetricIdentity } from '@floway-dev/provider';

const upstreamId = z.string().min(1);
const userId = z.number().int().positive();
export const quotaIdSchema = z.uuid();

const metricIdentity = z.object({
  name: z.string().min(1),
  labels: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).transform(({ name, labels }) => normalizeUpstreamMetricIdentity(name, labels));

export const quotaResetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['day', 'week', 'month', 'manual']) }),
  z.object({ kind: z.literal('upstream'), upstreamId, metric: metricIdentity }),
]);

export const quotaPolicySchema = z.object({
  limitUsd: z.string().regex(/^\d{1,18}(?:\.\d{1,12})?$/)
    .transform(value => parseNonNegativeDecimalString(value))
    .refine(value => !decimalStringIsZero(value), 'The limit must be greater than zero'),
  enforce: z.boolean(),
  reset: quotaResetSchema,
});

export const createQuotaSchema = quotaPolicySchema.extend({ userId, upstreamId: upstreamId.nullable() });

export const quotaRecordSchema = createQuotaSchema.extend({
  id: quotaIdSchema,
  startsAt: z.number().int().nonnegative(),
  observedCycleStart: z.number().int().nonnegative().optional(),
  spentUsd: z.string().max(2048).regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/),
  unpriced: z.boolean(),
});

export type QuotaPolicy = z.infer<typeof quotaPolicySchema>;
export type QuotaRecord = z.infer<typeof quotaRecordSchema>;
export type QuotaReset = z.infer<typeof quotaResetSchema>;

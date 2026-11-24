import type { Context } from 'hono';

import { USER_QUOTA_CODE, USER_QUOTA_MESSAGE, UserQuotaExceededError } from '../../user-quotas/accounting.ts';

export const quotaExceededResponse = (c: Context): Response =>
  c.json({ error: { message: USER_QUOTA_MESSAGE, type: 'insufficient_quota', code: USER_QUOTA_CODE } }, 429);

export const userQuotaErrorResponse = (c: Context, error: unknown): Response | null =>
  error instanceof UserQuotaExceededError ? quotaExceededResponse(c) : null;

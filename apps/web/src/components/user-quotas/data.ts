import type { InferRequestType, InferResponseType } from 'hono/client';

import { api, callApi } from '../../api/client';

const rules = api.api['user-quotas'];
const resetOptions = api.api['user-quota-reset-options'][':id'];

export type QuotaPageData = InferResponseType<typeof rules.$get, 200>;
export type Quota = QuotaPageData['quotas'][number];
export type QuotaOptions = NonNullable<QuotaPageData['options']>;
export type ResetOption = InferResponseType<typeof resetOptions.$get, 200>['metrics'][number];
export type QuotaPolicy = InferRequestType<typeof rules[':id']['$put']>['json'];
export type QuotaResetKind = QuotaPolicy['reset']['kind'];

export const loadQuotas = (signal?: AbortSignal) => callApi(() => rules.$get(undefined, { init: { signal } }));
export const loadResetOptions = (id: string, signal: AbortSignal) => callApi(() => resetOptions.$get({ param: { id } }, { init: { signal } }));

export const saveQuota = (quota: Quota | null, userId: number, upstreamId: string | null, json: QuotaPolicy) =>
  quota === null
    ? callApi(() => rules.$post({ json: { ...json, userId, upstreamId } }))
    : callApi(() => rules[':id'].$put({ param: { id: quota.id }, json }));

export const changeQuota = (quota: Quota, action: 'reset' | 'delete') => {
  const param = { id: quota.id };
  return action === 'reset'
    ? callApi(() => rules[':id'].reset.$post({ param }))
    : callApi(() => rules[':id'].$delete({ param }));
};

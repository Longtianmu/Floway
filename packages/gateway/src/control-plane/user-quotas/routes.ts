import { metricDisplayResolverForKind, readUpstreamMetricResetAt } from '../../data-plane/providers/registry.ts';
import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { QuotaRevision, Repo } from '../../repo/types.ts';
import { quotaProgress } from '../../user-quotas/accounting.ts';
import { quotaResetDisplay, readQuotaPeriod } from '../../user-quotas/period.ts';
import { type createQuotaSchema, quotaIdSchema, type quotaPolicySchema, type QuotaReset } from '../../user-quotas/schema.ts';

const resetDisplay = (kind: Parameters<typeof quotaResetDisplay>[0], metric: Parameters<typeof quotaResetDisplay>[1]) => {
  const display = quotaResetDisplay(kind, metric);
  if (display === null) return null;
  const { resetThreshold: _resetThreshold, ...label } = display;
  return label;
};

export const listUserQuotas = async (c: AuthedContext) => {
  const repo = getRepo();
  const actor = userFromContext(c);
  const [records, users, upstreamRecords] = await Promise.all([
    repo.userQuotas.list(actor.isAdmin ? undefined : actor.id),
    actor.isAdmin ? repo.users.list() : [actor],
    repo.upstreams.list(),
  ]);
  const usersById = new Map(users.map(user => [user.id, user.username]));
  const upstreamsById = new Map(upstreamRecords.map(upstream => [upstream.id, upstream]));
  const now = Date.now();
  const quotas = await Promise.all(records.filter(record => usersById.has(record.userId)).map(async record => {
    const current = await readQuotaPeriod(repo, record, now);
    if (current === null) return null;
    const { revision: _revision, observedCycleStart: _observedCycleStart, ...quota } = current;
    const reset = quota.reset.kind === 'upstream' ? quota.reset : null;
    const source = reset === null ? undefined : upstreamsById.get(reset.upstreamId);
    const display = source && reset !== null ? resetDisplay(source.kind, reset.metric) : null;
    const reportedReset = source?.enabled && reset !== null && display !== null && quota.resetAvailable
      ? readUpstreamMetricResetAt(source, reset.metric) : null;
    return {
      ...quota,
      // Upstream deadlines are for display; only an observed refill starts a new quota period.
      renewsAt: reportedReset !== null && reportedReset > now ? reportedReset : quota.renewsAt,
      ...quotaProgress(quota),
      username: usersById.get(quota.userId)!,
      upstreamName: quota.upstreamId === null ? null : upstreamsById.get(quota.upstreamId)?.name ?? null,
      resetSourceName: source?.name ?? null,
      resetDisplay: display,
    };
  }));
  return c.json({
    quotas: quotas.filter(quota => quota !== null),
    options: actor.isAdmin ? {
      users: users.map(({ id, username }) => ({ id, username })),
      upstreams: upstreamRecords.map(({ id, name, kind, enabled }) => ({
        id, name, canReset: enabled && metricDisplayResolverForKind(kind) !== undefined,
      })),
    } : null,
  });
};

export const listQuotaResetOptions = async (c: AuthedContext<'/user-quota-reset-options/:id'>) => {
  const id = c.req.param('id');
  const repo = getRepo();
  const upstream = await repo.upstreams.getById(id);
  if (upstream === null) return c.json({ error: 'Upstream not found' }, 404);
  if (!upstream.enabled || metricDisplayResolverForKind(upstream.kind) === undefined) return c.json({ metrics: [] });
  const metrics = (await repo.upstreamMetrics.listIdentities(id)).flatMap(metric => {
    const display = resetDisplay(upstream.kind, metric);
    return display === null ? [] : [{ metric, display }];
  });
  return c.json({ metrics });
};

const validateReset = async (repo: Repo, reset: QuotaReset): Promise<boolean> => {
  if (reset.kind !== 'upstream') return true;
  const upstream = await repo.upstreams.getById(reset.upstreamId);
  return upstream !== null && quotaResetDisplay(upstream.kind, reset.metric) !== null;
};

const clearUsage = (now: number) => ({ startsAt: now, observedCycleStart: undefined, spentUsd: '0', unpriced: false });

export const createUserQuota = async (c: CtxWithJson<typeof createQuotaSchema>) => {
  const repo = getRepo();
  const body = c.req.valid('json');
  if (await repo.users.getById(body.userId) === null) return c.json({ error: 'User not found' }, 404);
  if (body.upstreamId !== null && await repo.upstreams.getById(body.upstreamId) === null) return c.json({ error: 'Upstream not found' }, 404);
  if (!await validateReset(repo, body.reset)) return c.json({ error: 'Unsupported upstream reset metric' }, 400);
  const id = crypto.randomUUID();
  if (!await repo.userQuotas.insert({ ...body, id, ...clearUsage(Date.now()) })) {
    return c.json({ error: 'A quota for this user and scope already exists' }, 409);
  }
  return c.json({ id }, 201);
};

const changeQuota = async (id: string, change: (record: QuotaRevision) => QuotaRevision | null) => {
  const repo = getRepo();
  for (let attempt = 0; attempt < 100; attempt++) {
    const quota = await repo.userQuotas.get(id);
    if (quota === null) return 'missing' as const;
    const updated = change(quota);
    if (updated === null) return 'invalid' as const;
    if (await repo.userQuotas.replaceIfCurrent([updated])) return 'changed' as const;
  }
  throw new Error('Floway: quota update could not be committed after 100 concurrent updates');
};

export const updateUserQuota = async (c: CtxWithJson<typeof quotaPolicySchema, '/user-quotas/:id'>) => {
  const id = quotaIdSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'Quota not found' }, 404);
  const body = c.req.valid('json');
  // An existing source may have been deleted. Operators can still change the
  // limit or enforcement without discarding usage or choosing a new source.
  const requestedReset = JSON.stringify(body.reset);
  const valid = await validateReset(getRepo(), body.reset);
  const result = await changeQuota(id.data, quota => {
    const sameReset = JSON.stringify(quota.reset) === requestedReset;
    if (!sameReset && !valid) return null;
    return { ...quota, ...body, ...(sameReset ? {} : clearUsage(Date.now())) };
  });
  if (result === 'missing') return c.json({ error: 'Quota not found' }, 404);
  if (result === 'invalid') return c.json({ error: 'Unsupported upstream reset metric' }, 400);
  return c.json({ id: id.data });
};

export const resetUserQuota = async (c: AuthedContext<'/user-quotas/:id/reset'>) => {
  const id = quotaIdSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'Quota not found' }, 404);
  const result = await changeQuota(id.data, quota => quota.reset.kind === 'manual' ? { ...quota, ...clearUsage(Date.now()) } : null);
  if (result === 'missing') return c.json({ error: 'Quota not found' }, 404);
  if (result === 'invalid') return c.json({ error: 'This quota does not use manual resets' }, 409);
  return c.json({ id: id.data });
};

export const deleteUserQuota = async (c: AuthedContext<'/user-quotas/:id'>) => {
  const id = quotaIdSchema.safeParse(c.req.param('id'));
  if (!id.success || !await getRepo().userQuotas.delete(id.data)) return c.json({ error: 'Quota not found' }, 404);
  return c.json({ ok: true });
};

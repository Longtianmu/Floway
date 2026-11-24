import { useEffect, useState } from 'react';

import { loadResetOptions, saveQuota, type Quota, type QuotaOptions, type QuotaPolicy, type QuotaResetKind, type ResetOption } from './data';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { Dropdown, Input, Switch } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useDiscardGuard } from '../ui/use-discard-guard';
import { upstreamMetricDisplayName } from '../upstream-metrics/display-name';
import { upstreamMetricIdentityKey } from '@floway-dev/provider/browser';

const { Button, DialogActions, DialogTitle, Field, Option, Text } = fluentComponents;
const resetKinds: QuotaResetKind[] = ['day', 'week', 'month', 'manual', 'upstream'];

interface Draft {
  userId: string;
  upstreamId: string;
  limitUsd: string;
  enforce: boolean;
  reset: QuotaResetKind;
  source: string;
  metric: string;
}

export function QuotaDialog({ quota, options, open, onClose, onSaved }: {
  quota: Quota | null;
  options: QuotaOptions;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const previousSource = quota?.reset.kind === 'upstream' ? quota.reset : null;
  const initialMetric = previousSource ? upstreamMetricIdentityKey(previousSource.metric) : '';
  const [draft, setDraft] = useState<Draft>(() => ({
    userId: quota ? String(quota.userId) : '',
    upstreamId: quota?.upstreamId ?? '',
    limitUsd: quota?.limitUsd ?? '',
    enforce: quota?.enforce ?? true,
    reset: quota?.reset.kind ?? 'month',
    source: previousSource?.upstreamId ?? '',
    metric: initialMetric,
  }));
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<'saveFailed' | 'duplicate' | null>(null);
  const [metricsResponse, setMetricsResponse] = useState<{ source: string; metrics: ResetOption[] | null } | null>(null);
  const [retry, setRetry] = useState(0);
  const { requestClose, discardConfirmation } = useDiscardGuard({ onClose, values: draft });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const { source } = draft;

  useEffect(() => {
    if (!open || !source || draft.reset !== 'upstream') return;
    const abort = new AbortController();
    void loadResetOptions(source, abort.signal).then(response => {
      if (!abort.signal.aborted) setMetricsResponse({ source, metrics: response.data?.metrics ?? null });
    });
    return () => abort.abort();
  }, [draft.reset, open, retry, source]);

  const metrics = metricsResponse?.source === source ? metricsResponse.metrics : undefined;
  const retainedMetric = previousSource?.upstreamId === source ? previousSource.metric : null;
  const matching = metrics?.find(item => upstreamMetricIdentityKey(item.metric) === draft.metric);
  const selectedMetric = matching?.metric ?? (draft.metric === initialMetric ? retainedMetric : null);
  const missingRetained = retainedMetric !== null && !metrics?.some(item => upstreamMetricIdentityKey(item.metric) === initialMetric);
  const metricLabel = selectedMetric === null ? undefined : matching ? upstreamMetricDisplayName(matching.display, t)
    : quota?.resetDisplay ? upstreamMetricDisplayName(quota.resetDisplay, t) : selectedMetric.name;
  const sourceName = options.upstreams.find(upstream => upstream.id === source)?.name;
  const sources = options.upstreams.filter(upstream => upstream.canReset);
  const isValidLimit = /^\d{1,18}(?:\.\d{1,12})?$/.test(draft.limitUsd.trim()) && Number(draft.limitUsd) > 0;
  const sameReset = draft.reset === quota?.reset.kind && (draft.reset !== 'upstream' || (source === previousSource?.upstreamId && draft.metric === initialMetric));

  const save = async () => {
    if (saving) return;
    setSubmitted(true);
    if (!draft.userId || !isValidLimit) return;
    let reset: QuotaPolicy['reset'];
    if (draft.reset === 'upstream') {
      if (source === '' || selectedMetric === null) return;
      reset = { kind: 'upstream', upstreamId: source, metric: selectedMetric };
    } else reset = { kind: draft.reset };
    setSaving(true);
    setFailure(null);
    try {
      const response = await saveQuota(quota, Number(draft.userId), draft.upstreamId || null, { limitUsd: draft.limitUsd.trim(), enforce: draft.enforce, reset });
      if (response.error) {
        setFailure(response.error.status === 409 && quota === null ? 'duplicate' : 'saveFailed');
        return;
      }
      onClose();
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  const owner = quota?.username ?? options.users.find(user => String(user.id) === draft.userId)?.username;
  const scope = !draft.upstreamId ? t('quotas.scope.total')
    : options.upstreams.find(upstream => upstream.id === draft.upstreamId)?.name ?? t('quotas.scope.missing');

  return <>{discardConfirmation}<DialogShell
    open={open}
    onOpenChange={(_, event) => { if (!event.open && !saving) requestClose(); }}
    onSubmit={() => void save()}
    title={<DialogTitle>{t(quota ? 'quotas.dialog.edit' : 'quotas.dialog.add')}</DialogTitle>}
    actions={<DialogActions>
      <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t('quotas.actions.save')}</Button>
    </DialogActions>}
  >
    {failure && <OutcomeMessageBar onDismiss={() => setFailure(null)}>{t(`quotas.errors.${failure}`)}</OutcomeMessageBar>}
    <Field label={t('quotas.fields.user')} required={quota === null} validationMessage={submitted && !draft.userId ? t('quotas.errors.user') : undefined} validationState={submitted && !draft.userId ? 'error' : undefined}>
      {quota
        ? <Input readOnly value={owner} />
        : <Dropdown disabled={saving} placeholder={t('quotas.fields.selectUser')} selectedOptions={draft.userId ? [draft.userId] : []}
            value={owner ?? ''} onOptionSelect={(_, data) => set('userId', data.optionValue ?? '')}>
            {options.users.map(user => <Option key={user.id} value={String(user.id)}>{user.username}</Option>)}
          </Dropdown>}
    </Field>
    <Field label={t('quotas.fields.scope')}>
      {quota
        ? <Input readOnly value={scope} />
        : <Dropdown disabled={saving} value={scope} selectedOptions={[draft.upstreamId]}
            onOptionSelect={(_, data) => set('upstreamId', data.optionValue ?? '')}>
            <Option value="">{t('quotas.scope.total')}</Option>
            {options.upstreams.map(upstream => <Option key={upstream.id} value={upstream.id}>{upstream.name}</Option>)}
          </Dropdown>}
    </Field>
    <Field label={t('quotas.fields.limit')} required validationMessage={submitted && !isValidLimit ? t('quotas.errors.limit') : undefined} validationState={submitted && !isValidLimit ? 'error' : undefined}>
      <Input disabled={saving} inputMode="decimal" autoComplete="off" value={draft.limitUsd} onChange={(_, data) => set('limitUsd', data.value)} />
    </Field>
    <Field label={t('quotas.fields.reset')}>
      <Dropdown disabled={saving} value={t(`quotas.period.${draft.reset}`)} selectedOptions={[draft.reset]} onOptionSelect={(_, data) => {
        const kind = resetKinds.find(value => value === data.optionValue);
        if (kind === undefined) return;
        setDraft(current => ({ ...current, reset: kind, source: current.source || (sources.some(upstream => upstream.id === current.upstreamId) ? current.upstreamId : '') }));
      }}>
        {resetKinds.filter(kind => kind !== 'upstream' || sources.length > 0 || previousSource !== null).map(kind =>
          <Option key={kind} value={kind}>{t(`quotas.period.${kind}`)}</Option>)}
      </Dropdown>
    </Field>
    {draft.reset === 'upstream' && <>
      <Field label={t('quotas.fields.source')} required validationMessage={submitted && !source ? t('quotas.errors.source') : undefined} validationState={submitted && !source ? 'error' : undefined}>
        <Dropdown disabled={saving} placeholder={t('quotas.fields.selectSource')} value={sourceName ?? (source ? t('quotas.scope.missing') : '')}
          selectedOptions={source ? [source] : []} onOptionSelect={(_, data) => {
            const next = data.optionValue ?? '';
            if (next !== source) setDraft(current => ({ ...current, source: next, metric: next === previousSource?.upstreamId ? initialMetric : '' }));
          }}>
          {previousSource && !sources.some(upstream => upstream.id === previousSource.upstreamId) && <Option value={previousSource.upstreamId}>{quota?.resetSourceName ?? t('quotas.scope.missing')}</Option>}
          {sources.map(upstream => <Option key={upstream.id} value={upstream.id}>{upstream.name}</Option>)}
        </Dropdown>
      </Field>
      <Field label={t('quotas.fields.metric')} required validationMessage={submitted && selectedMetric === null ? t('quotas.errors.metric') : undefined} validationState={submitted && selectedMetric === null ? 'error' : undefined}>
        <Dropdown disabled={saving || source === '' || (metrics === undefined && retainedMetric === null)} placeholder={source && metrics === undefined ? t('common.loading') : t('quotas.fields.selectMetric')}
          emptyMessage={t('quotas.period.noMetrics')} value={metricLabel ?? ''} selectedOptions={draft.metric ? [draft.metric] : []}
          onOptionSelect={(_, data) => set('metric', data.optionValue ?? '')}>
          {missingRetained && <Option value={initialMetric}>{quota?.resetDisplay ? upstreamMetricDisplayName(quota.resetDisplay, t) : retainedMetric.name}</Option>}
          {metrics?.map(item => {
            const key = upstreamMetricIdentityKey(item.metric);
            return <Option key={key} value={key}>{upstreamMetricDisplayName(item.display, t)}</Option>;
          })}
        </Dropdown>
      </Field>
      {metrics === null && <div className="flex flex-wrap items-center gap-2">
        <Text size={200} className="text-fui-fg2">{t('quotas.errors.metricsLoad')}</Text>
        <Button onClick={() => { setMetricsResponse(null); setRetry(value => value + 1); }}>{t('quotas.actions.retry')}</Button>
      </div>}
    </>}
    {quota && !sameReset && <Text size={200} className="text-fui-fg2">{t(draft.reset === 'manual' ? 'quotas.period.changedManual' : 'quotas.period.changed')}</Text>}
    <Switch checked={draft.enforce} disabled={saving} label={t('quotas.enforcement.toggle')} onChange={(_, data) => set('enforce', data.checked)} />
  </DialogShell></>;
}

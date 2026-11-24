import { useCallback, useState } from 'react';

import type { Route } from './+types/dashboard-admin-quotas';
import { requireDashboardSession } from './guards';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { ResourceListActions } from '../components/ui/resource-list';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefresh } from '../components/ui/use-refresh';
import { changeQuota, loadQuotas, type Quota } from '../components/user-quotas/data';
import { QuotaDialog } from '../components/user-quotas/dialog';
import { QuotaTable } from '../components/user-quotas/table';
import { useTranslation } from '../i18n/translation';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  requireDashboardSession();
  return await loadQuotas(request.signal);
}

export default function DashboardAdminQuotas({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [data, setData] = useState(loaderData.data);
  const [pageError, setPageError] = useState(Boolean(loaderData.error));
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(false);
  const editor = useDialogInvocation<Quota | null>();
  const confirm = useDialogInvocation<{ action: 'delete' | 'reset'; quota: Quota }>();
  const reload = useCallback(async (signal: AbortSignal) => {
    const result = await loadQuotas(signal);
    if (signal.aborted) return;
    if (result.data !== undefined) setData(result.data);
    setPageError(Boolean(result.error));
  }, []);
  const { poll, refresh, refreshing } = useRefresh(reload);
  usePollWhileVisible(poll);

  const mutate = async (action: 'delete' | 'reset', quota: Quota) => {
    if (saving) return;
    setSaving(true);
    setActionError(false);
    try {
      const result = await changeQuota(quota, action);
      if (result.error !== undefined) {
        setActionError(true);
        return;
      }
      confirm.close();
      toasts.succeed(t(action === 'delete' ? 'quotas.outcome.deleted' : 'quotas.outcome.reset'));
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const options = data?.options ?? null;
  const pending = confirm.invocation?.value;
  const listActions = {
    disabled: saving,
    refreshing,
    refreshLabel: t('quotas.actions.refresh'),
    onRefresh: () => void refresh(),
  };
  return <section aria-busy={refreshing || saving} className="dashboard-page">
    <DashboardPageHeader
      title={t('quotas.title')}
      actions={options === null ? <ResourceListActions {...listActions} />
        : <ResourceListActions {...listActions} createLabel={t('quotas.actions.add')} onCreate={() => editor.open(null)} />}
    />
    {pageError && <OutcomeMessageBar onDismiss={() => setPageError(false)}>{t('quotas.errors.load')}</OutcomeMessageBar>}
    {data !== undefined && <QuotaTable
      quotas={data.quotas}
      disabled={refreshing || saving}
      actions={options === null ? undefined : {
        edit: quota => editor.open(quota),
        confirm: (action, quota) => { setActionError(false); confirm.open({ action, quota }); },
      }}
    />}
    {options !== null && editor.invocation && <QuotaDialog
      key={editor.invocation.key}
      quota={editor.invocation.value}
      options={options}
      open={editor.isOpen}
      onClose={editor.close}
      onSaved={async () => { toasts.succeed(t('quotas.outcome.saved')); await refresh(); }}
    />}
    {pending && <ConfirmDialog
      key={confirm.invocation!.key}
      open={confirm.isOpen}
      title={t(pending.action === 'delete' ? 'quotas.dialog.delete' : 'quotas.dialog.reset')}
      message={t(pending.action === 'delete' ? 'quotas.dialog.deleteMessage' : 'quotas.dialog.resetMessage', { user: pending.quota.username })}
      actionLabel={t(pending.action === 'delete' ? 'quotas.actions.delete' : 'quotas.actions.reset')}
      busy={saving}
      error={actionError ? t('quotas.errors.changeFailed') : null}
      onDismissError={() => setActionError(false)}
      onConfirm={() => void mutate(pending.action, pending.quota)}
      onOpenChange={open => { if (!open) confirm.close(); }}
    />}
  </section>;
}

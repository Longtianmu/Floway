import { useEffect, useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatUsd } from '../../lib/decimal-display';
import { loadUpstreamQuotaEstimates } from '../upstream-metrics/data';

const { Text, Tooltip } = fluentComponents;
type EstimatesResult = Awaited<ReturnType<typeof loadUpstreamQuotaEstimates>>;
const reasonKeys = {
  unsupported: 'dashboard.upstreamTelemetry.estimates.unsupported',
  'no-reset': 'dashboard.upstreamTelemetry.estimates.noReset',
  'no-consumption': 'dashboard.upstreamTelemetry.estimates.noConsumption',
  unpriced: 'dashboard.upstreamTelemetry.estimates.unpriced',
  stale: 'dashboard.upstreamTelemetry.estimates.stale',
} as const;

export function QuotaEstimates({ upstreamId, loadedAt }: { upstreamId: string; loadedAt: number }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ upstreamId: string; result: EstimatesResult } | null>(null);
  const [unexpected, setUnexpected] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadUpstreamQuotaEstimates(upstreamId, loadedAt, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ upstreamId, result });
    }, error => {
      if (!controller.signal.aborted) setUnexpected({ error });
    });
    return () => controller.abort();
  }, [loadedAt, upstreamId]);
  if (unexpected !== null) throw unexpected.error;
  const result = state?.upstreamId === upstreamId ? state.result : null;
  if (result?.data?.available === false) return null;
  return <div aria-label={t('dashboard.upstreamTelemetry.estimates.label')} className="flex flex-col items-end gap-1" role="note">
    {result === null ? <Text className="text-fui-fg2" size={200}>{t('dashboard.upstreamTelemetry.estimates.loading')}</Text>
      : result.error ? <Text className="text-fui-fg2" size={200}>{t('dashboard.upstreamTelemetry.estimates.loadFailed')}</Text>
        : result.data.estimates.map(estimate => <Tooltip key={estimate.window} relationship="description" content={<>
            {t('dashboard.upstreamTelemetry.estimates.hint')}
            {estimate.reason !== null && <> {t(reasonKeys[estimate.reason])}</>}
          </>}>
            <Text className="text-fui-fg2 tabular-nums winui-focus-rect" size={200} tabIndex={0}>
              {t('dashboard.upstreamTelemetry.estimates.line', {
                window: t(estimate.window === 'five-hour' ? 'dashboard.upstreamTelemetry.estimates.fiveHour' : 'dashboard.upstreamTelemetry.estimates.week'),
                spent: estimate.spentUsd === null ? t('dashboard.upstreamTelemetry.estimates.unavailable') : formatUsd(estimate.spentUsd),
                total: estimate.fullQuotaUsd === null ? t('dashboard.upstreamTelemetry.estimates.unavailable') : formatUsd(estimate.fullQuotaUsd),
              })}
            </Text>
          </Tooltip>)}
  </div>;
}

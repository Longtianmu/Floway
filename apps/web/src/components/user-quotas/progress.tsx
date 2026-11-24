import type { Quota } from './data';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';

const { ProgressBar, Text, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // Use Fluent's fixed blue palette, not the operator's custom accent.
  // https://cdn.jsdelivr.net/npm/@fluentui/tokens@1.0.0-alpha.23/lib/global/colors.js#L505-L511
  brand: {
    color: 'var(--colorPaletteBlueForeground2)',
    '& .fui-ProgressBar__bar.fui-ProgressBar__bar': { backgroundColor: 'var(--colorPaletteBlueBorderActive)' },
  },
  success: { color: 'var(--winui-system-fill-success)' },
  // The bar uses yellow in both themes; the label keeps WinUI's text contrast.
  // https://cdn.jsdelivr.net/npm/@fluentui/tokens@1.0.0-alpha.23/lib/global/colors.js#L267-L274
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280-L291
  warning: {
    color: 'var(--winui-system-fill-caution)',
    '& .fui-ProgressBar__bar.fui-ProgressBar__bar': { backgroundColor: 'var(--colorPaletteYellowBackground3)' },
  },
  error: { color: 'var(--winui-system-fill-critical)' },
});

export function QuotaProgress({ quota }: { quota: Quota }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = useStyles();
  const ratio = Number(quota.ratio);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });
  const shownPercent = percent.format(quota.ratio as `${number}`);
  const label = quota.severity === 'error' && shownPercent === percent.format(1) ? t('quotas.progress.overLimit') : shownPercent;
  const usd = new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 12,
  });

  return <div className="grid gap-1 min-w-0" data-quota-level={quota.severity}>
    <div className="flex flex-wrap justify-between items-baseline gap-x-3 min-w-0 tabular-nums [overflow-wrap:anywhere]">
      <Text size={200} className="text-fui-fg2">{t('quotas.progress.cost', {
        spent: usd.format(quota.spentUsd as `${number}`),
        limit: usd.format(quota.limitUsd as `${number}`),
      })}</Text>
      <Text size={300} weight="semibold" className={mergeClasses('ml-auto', styles[quota.severity])}>{label}</Text>
    </div>
    <ProgressBar
      aria-label={t('quotas.progress.label')}
      aria-valuetext={label}
      className={styles[quota.severity]}
      color={quota.severity}
      max={100}
      thickness="large"
      value={Math.min(100, ratio * 100)}
    />
    {quota.unpriced && <Text size={200} className="text-fui-fg2">{t('quotas.progress.unpriced')}</Text>}
  </div>;
}

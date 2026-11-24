import { ArrowClockwiseRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';

import type { Quota } from './data';
import { QuotaProgress } from './progress';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useMediaQuery } from '../../lib/use-media-query';
import { ResourceListEmptyState, ResourceListPanel } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableActionsHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { upstreamMetricDisplayName } from '../upstream-metrics/display-name';

const { List, ListItem, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  // Use the same separator as ResourceListPanel's table rows.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250
  item: { borderBottom: '1px solid var(--winui-divider-stroke-default)', paddingInline: 'var(--floway-panel-inset)' },
});

interface Actions {
  edit: (quota: Quota) => void;
  confirm: (action: 'reset' | 'delete', quota: Quota) => void;
}

export function QuotaTable({ quotas, actions, disabled }: { quotas: readonly Quota[]; actions?: Actions; disabled: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const narrow = useMediaQuery('(max-width: 1050px)');
  const styles = useStyles();
  const target = (quota: Quota) => quota.upstreamId === null ? t('quotas.scope.total') : quota.upstreamName ?? t('quotas.scope.missing');
  const subject = (quota: Quota) => <div className="grid gap-0.5 min-w-0 [overflow-wrap:anywhere]">
    <Text size={300} weight="semibold">{actions ? quota.username : target(quota)}</Text>
    {actions && <Text size={200} className="text-fui-fg2">{target(quota)}</Text>}
  </div>;
  const period = (quota: Quota) => <div className="grid gap-0.5 min-w-0 [overflow-wrap:anywhere]">
    <Text size={300}>
      {quota.reset.kind === 'upstream' && quota.resetSourceName && quota.resetDisplay
        ? t('quotas.period.source', { upstream: quota.resetSourceName, metric: upstreamMetricDisplayName(quota.resetDisplay, t) })
        : t(`quotas.period.${quota.reset.kind}`)}
    </Text>
    <Text size={200} className="text-fui-fg2">
      {quota.renewsAt === null
        ? t('quotas.period.started', { time: dateTime(quota.startsAt, locale) })
        : t('quotas.period.renews', { time: dateTime(quota.renewsAt, locale) })}
    </Text>
    {!quota.resetAvailable && <Text size={200} className="text-fui-fg2">{t('quotas.period.unavailable')}</Text>}
    <Text size={200} className="text-fui-fg2">{t(quota.enforce ? 'quotas.enforcement.block' : 'quotas.enforcement.observe')}</Text>
  </div>;
  const controls = (quota: Quota) => actions && <TableActions>
    <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('quotas.actions.edit')} onClick={() => actions.edit(quota)} />
    {quota.reset.kind === 'manual' && <TooltipIconButton
      disabled={disabled} icon={<ArrowClockwiseRegular />} label={t('quotas.actions.reset')} onClick={() => actions.confirm('reset', quota)}
    />}
    <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('quotas.actions.delete')} onClick={() => actions.confirm('delete', quota)} />
  </TableActions>;

  return <ResourceListPanel>
    {quotas.length === 0
      ? <ResourceListEmptyState>{t('quotas.empty')}</ResourceListEmptyState>
      : narrow
        ? <List aria-label={t('quotas.title')}>
            {quotas.map(quota => <ListItem key={quota.id} className={styles.item}>
              <div className="w-full min-w-0 grid gap-2 py-3">
                <div className="flex justify-between items-start gap-2 min-w-0">{subject(quota)}{controls(quota)}</div>
                <QuotaProgress quota={quota} />
                {period(quota)}
              </div>
            </ListItem>)}
          </List>
        : <ScrollArea axes="horizontal" className="min-w-0">
            <Table aria-label={t('quotas.title')} className="min-w-[680px]">
              <TableColumns widths={[actions ? '21%' : '25%', '35%', null, ...(actions ? [TABLE_ACTIONS_WIDTH] : [])]} />
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t(actions ? 'quotas.fields.user' : 'quotas.fields.scope')}</TableHeaderCell>
                  <TableHeaderCell>{t('quotas.progress.label')}</TableHeaderCell>
                  <TableHeaderCell>{t('quotas.fields.reset')}</TableHeaderCell>
                  {actions && <TableActionsHeader />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {quotas.map(quota => <TableRow key={quota.id}>
                  <TableCell className="py-2">{subject(quota)}</TableCell>
                  <TableCell className="py-2"><QuotaProgress quota={quota} /></TableCell>
                  <TableCell className="py-2">{period(quota)}</TableCell>
                  {actions && <TableCell>{controls(quota)}</TableCell>}
                </TableRow>)}
              </TableBody>
            </Table>
          </ScrollArea>}
  </ResourceListPanel>;
}

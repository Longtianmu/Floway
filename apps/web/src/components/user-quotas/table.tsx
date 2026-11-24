import { ArrowClockwiseRegular, ChevronDownRegular, ChevronRightRegular, DeleteRegular, EditRegular } from '@fluentui/react-icons';
import { useId, useState } from 'react';

import type { Quota } from './data';
import { QuotaProgress } from './progress';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatRemaining } from '../../lib/format-duration';
import { useLocale } from '../../lib/use-locale';
import { useMediaQuery } from '../../lib/use-media-query';
import { useNow } from '../../lib/use-now';
import { ResourceListEmptyState, ResourceListPanel } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableActionsHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { upstreamMetricDisplayName } from '../upstream-metrics/display-name';

const { Button, List, ListItem, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles } = fluentComponents;

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
  const now = useNow(60_000);
  const narrow = useMediaQuery('(max-width: 1050px)');
  const styles = useStyles();
  const groupId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const users = actions === undefined ? [] : [...Map.groupBy(quotas, quota => quota.userId).entries()];
  const target = (quota: Quota) => quota.upstreamId === null ? t('quotas.scope.total') : quota.upstreamName ?? t('quotas.scope.missing');
  const subject = (quota: Quota) => <Text size={300} weight="semibold" className="min-w-0 [overflow-wrap:anywhere]">{target(quota)}</Text>;
  const userHeading = (userId: number, rules: readonly Quota[]) => {
    const open = expanded.has(userId);
    const nameId = `${groupId}-user-${userId}`;
    const countId = `${nameId}-count`;
    return <Button appearance="subtle" aria-expanded={open} aria-labelledby={`${nameId} ${countId}`}
      className="!w-full !justify-start" icon={open ? <ChevronDownRegular /> : <ChevronRightRegular />}
      onClick={() => setExpanded(current => {
        const next = new Set(current);
        if (next.has(userId)) next.delete(userId); else next.add(userId);
        return next;
      })}>
      <span className="flex flex-wrap items-baseline gap-x-3 min-w-0 [overflow-wrap:anywhere]">
        <Text id={nameId} size={300} weight="semibold">{rules[0]!.username}</Text>
        <Text id={countId} size={200} className="text-fui-fg2">{t('quotas.group.rules', { count: rules.length })}</Text>
      </span>
    </Button>;
  };
  const period = (quota: Quota) => {
    const remaining = (quota.renewsAt ?? now) - now;
    const timing = !quota.resetAvailable ? t('quotas.period.unavailable')
      : remaining > 0 ? t('quotas.period.renews', { time: formatRemaining(remaining, locale) })
        : quota.reset.kind !== 'manual' && !quota.waitingForReset ? t('quotas.period.unknown') : null;
    return <div className="grid gap-0.5 min-w-0 [overflow-wrap:anywhere]">
      <Text size={300}>
        {quota.reset.kind === 'upstream' && quota.resetSourceName && quota.resetDisplay
          ? t('quotas.period.source', { upstream: quota.resetSourceName, metric: upstreamMetricDisplayName(quota.resetDisplay, t) })
          : t(`quotas.period.${quota.reset.kind}`)}
      </Text>
      {timing !== null && <Text size={200} className="text-fui-fg2">{timing}</Text>}
      {quota.resetAvailable && quota.waitingForReset && <Text size={200} className="text-fui-fg2">{t('quotas.period.waiting')}</Text>}
      <Text size={200} className="text-fui-fg2">{t(quota.enforce ? 'quotas.enforcement.block' : 'quotas.enforcement.observe')}</Text>
    </div>;
  };
  const controls = (quota: Quota) => actions && <TableActions>
    <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('quotas.actions.edit')} onClick={() => actions.edit(quota)} />
    {quota.reset.kind === 'manual' && <TooltipIconButton
      disabled={disabled} icon={<ArrowClockwiseRegular />} label={t('quotas.actions.reset')} onClick={() => actions.confirm('reset', quota)}
    />}
    <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('quotas.actions.delete')} onClick={() => actions.confirm('delete', quota)} />
  </TableActions>;
  const listItem = (quota: Quota) => <ListItem key={quota.id} className={styles.item}>
    <div className="w-full min-w-0 grid gap-2 py-3">
      <div className="flex justify-between items-start gap-2 min-w-0">{subject(quota)}{controls(quota)}</div>
      <QuotaProgress quota={quota} />
      {period(quota)}
    </div>
  </ListItem>;
  const tableRow = (quota: Quota) => <TableRow key={quota.id}>
    <TableCell className="py-2">{subject(quota)}</TableCell>
    <TableCell className="py-2"><QuotaProgress quota={quota} /></TableCell>
    <TableCell className="py-2">{period(quota)}</TableCell>
    {actions && <TableCell>{controls(quota)}</TableCell>}
  </TableRow>;

  return <ResourceListPanel>
    {quotas.length === 0
      ? <ResourceListEmptyState>{t('quotas.empty')}</ResourceListEmptyState>
      : narrow
        ? <List aria-label={t('quotas.title')}>
            {actions === undefined ? quotas.map(listItem) : users.map(([userId, rules]) => <ListItem key={userId} className={styles.item}>
              <div className="w-full min-w-0">
                {userHeading(userId, rules)}
                {expanded.has(userId) && <List>{rules.map(listItem)}</List>}
              </div>
            </ListItem>)}
          </List>
        : <ScrollArea axes="horizontal" className="min-w-0">
            <Table aria-label={t('quotas.title')} className="min-w-[680px]">
              <TableColumns widths={[actions ? '21%' : '25%', '35%', null, ...(actions ? [TABLE_ACTIONS_WIDTH] : [])]} />
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('quotas.fields.scope')}</TableHeaderCell>
                  <TableHeaderCell>{t('quotas.progress.label')}</TableHeaderCell>
                  <TableHeaderCell>{t('quotas.fields.reset')}</TableHeaderCell>
                  {actions && <TableActionsHeader />}
                </TableRow>
              </TableHeader>
              {actions === undefined ? <TableBody>{quotas.map(tableRow)}</TableBody> : users.map(([userId, rules]) => <TableBody key={userId}>
                <TableRow><TableCell colSpan={4}>{userHeading(userId, rules)}</TableCell></TableRow>
                {expanded.has(userId) && rules.map(tableRow)}
              </TableBody>)}
            </Table>
          </ScrollArea>}
  </ResourceListPanel>;
}

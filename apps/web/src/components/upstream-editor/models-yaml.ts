import { parse, stringify } from 'yaml';

import { i18n } from '../../i18n';
import { errorMessage } from '../../lib/error-message';
import { modelsField, type UpstreamModelConfig } from '@floway-dev/provider/model-config';

export const serializeModels = (models: UpstreamModelConfig[]): string => stringify(models, {
  indent: 2,
  lineWidth: 0,
});

export type ParsedModels =
  | { ok: true; models: UpstreamModelConfig[] }
  | { ok: false; message: string };

export const parseModels = (text: string, { allowModeration, allowRerank }: { allowModeration: boolean; allowRerank: boolean }): ParsedModels => {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  let models: UpstreamModelConfig[];
  try {
    models = modelsField(raw, 'dashboard');
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  if (!allowModeration && models.some(model => model.kind === 'moderation' || model.endpoints.openaiModerations !== undefined)) {
    return { ok: false, message: i18n.t('dashboard.upstreamEditor.models.yamlModerationRequiresCustom') };
  }
  if (!allowRerank && models.some(model => model.kind === 'rerank')) {
    return { ok: false, message: i18n.t('dashboard.upstreamEditor.models.yamlRerankRequiresCustom') };
  }
  return { ok: true, models };
};

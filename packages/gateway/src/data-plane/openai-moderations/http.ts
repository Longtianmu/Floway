// POST /v1/moderations and /moderations — OpenAI Moderations passthrough.
// The body and response stay upstream-owned; Floway only selects the model
// and provider. OpenAI defines the omitted-model default used for routing:
// https://developers.openai.com/api/reference/resources/moderations/methods/create

import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';

const DEFAULT_MODERATION_MODEL = 'omni-moderation-latest';

export const openaiModerations = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Moderations', {
    defaultModel: DEFAULT_MODERATION_MODEL,
  });
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/moderations',
    operation: 'moderation',
    model: request.model,
    kind: 'moderation',
    modelServesEndpoint: model => model.endpoints.openaiModerations !== undefined,
    call: async (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return await provider.instance.callOpenAIModerations(model, body, ctx.abortSignal, opts);
    },
    response: { format: 'json', extractBilling: () => null },
  });
  return finalizeGatewayResponse(ctx, response);
};

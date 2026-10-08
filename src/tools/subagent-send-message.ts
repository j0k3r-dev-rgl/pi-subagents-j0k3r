import { Type } from 'typebox';
import { resolveRuntimeManager } from '../runtime-registry.js';
import type { RuntimeManagerSourceV1 } from '../runtime-registry.js';
import { renderSubagentSendMessageCall, renderSubagentSendMessageResult } from '../render/tools/subagent-send-message.js';
import { sessionIdFromToolContext } from './result-details.js';
import { ok, fail } from './tool-response.js';

export function createSubagentSendMessageTool(source: RuntimeManagerSourceV1) {
  return {
    name: 'subagent_send_message',
    label: 'Subagent Send Message',
    description: 'Queue a live steering message for a running background subagent owned by the current Pi session.',
    parameters: Type.Object({
      task_id: Type.String(),
      message: Type.String(),
    }),
    renderShell: 'self',
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const { manager } = resolveRuntimeManager(source, ctx);
        const result = manager.sendMessage({
          task_id: params.task_id,
          message: params.message,
          session_id: sessionIdFromToolContext(ctx),
        });
        const text = result.status === 'queued'
          ? `queued: ${result.message}`
          : `rejected: ${result.message}`;
        return ok(text, result);
      } catch (error) {
        return fail(error);
      }
    },
    renderCall: renderSubagentSendMessageCall,
    renderResult: renderSubagentSendMessageResult,
  };
}

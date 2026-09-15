export { createSubagentsPanelKeyMatcher } from './src/ui/panel-input.js';
export { resolveRegisteredToolDefinition } from './src/ui/panel-overlay.js';
export { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState, moveClaudeBackgroundWidgetSelection, renderClaudeBackgroundWidgetLines } from './src/ui/background-widget.js';
export { completionMessage, renderSubagentCompletionMessage, sendSubagentCompletionMessage } from './src/render/completion-message.js';
export { default } from './src/extension/subagents-extension.js';
export {
  SUBAGENTS_SERVICE_API_VERSION,
  createSubagentsService,
  getSubagentsService,
  publishSubagentsService,
  toTaskSnapshotV1,
  unpublishSubagentsService,
} from './src/service.js';
export type {
  SubagentAgentDescriptorV1,
  SubagentTaskSnapshotV1,
  SubagentsServiceRunInputV1,
  SubagentsServiceRunOptionsV1,
  SubagentsServiceV1,
} from './src/service.js';

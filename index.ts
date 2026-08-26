export { createSubagentsPanelKeyMatcher } from './src/ui/panel-input.js';
export { resolveRegisteredToolDefinition } from './src/ui/panel-overlay.js';
export { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState, moveClaudeBackgroundWidgetSelection, renderClaudeBackgroundWidgetLines } from './src/ui/background-widget.js';
export { completionMessage, renderSubagentCompletionMessage, sendSubagentCompletionMessage } from './src/render/completion-message.js';
export { getSubagentActivityProvider, SUBAGENT_ACTIVITY_PROVIDER_VERSION, watchSubagentActivityProvider } from './src/activity-provider.js';
export type { SubagentActivity, SubagentActivityEffort, SubagentActivityKind, SubagentActivityMode, SubagentActivityProfileSource, SubagentActivityProvider, SubagentActivitySnapshot, SubagentActivityStatus, SubagentActivityTask, SubagentActivityUsage } from './src/activity-provider.js';
export { default } from './src/extension/subagents-extension.js';

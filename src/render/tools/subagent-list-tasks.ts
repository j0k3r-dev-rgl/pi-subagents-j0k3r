import type { SubagentTask } from '../types.js';
import { textComponent } from './components.js';
import { formatTaskListRender } from './formatting.js';

export function renderSubagentListTasksResult(result: any, { expanded }: any, theme: any) {
  const tasks = Array.isArray(result?.details?.tasks) ? result.details.tasks : [];
  const text = formatTaskListRender(tasks as SubagentTask[], Boolean(expanded));
  return textComponent(expanded ? text : (theme.fg?.('dim', text) ?? text));
}

import { textComponent } from './components.js';
import { clip } from './formatting.js';
import { renderSubagentRunResult } from './subagent-run.js';

export function renderSubagentContinueCall(args: any, theme: any) {
  const title = `${theme.fg?.('toolTitle', theme.bold?.('subagent continue') ?? 'subagent continue') ?? 'subagent continue'} ${theme.fg?.('dim', `(${args.task_id ?? 'unknown'})`) ?? `(${args.task_id ?? 'unknown'})`}`;
  const prompt = clip(args.prompt, 120);
  return textComponent(`${title}\n${theme.fg?.('dim', 'continuation prompt:') ?? 'continuation prompt:'} ${prompt}`);
}

export function renderSubagentContinueResult(result: any, options: any, theme: any) {
  return renderSubagentRunResult(result, options, theme);
}

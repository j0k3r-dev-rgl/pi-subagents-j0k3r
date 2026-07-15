import { describe, expect, it, vi } from 'vitest';
import extension, {
  ClaudeBackgroundWidget,
  ClaudeBackgroundWidgetState,
  completionMessage,
  createSubagentsPanelKeyMatcher,
  moveClaudeBackgroundWidgetSelection,
  renderClaudeBackgroundWidgetLines,
  renderSubagentCompletionMessage,
  resolveRegisteredToolDefinition,
  sendSubagentCompletionMessage,
} from '../index.js';
import * as configModule from '../src/config.js';
import * as errorMetadataModule from '../src/error-metadata.js';
import * as modelProfilesUiModule from '../src/model-profiles-ui.js';
import * as runnerModule from '../src/runner.js';
import * as threadViewModule from '../src/thread-view.js';
import * as toolsModule from '../src/tools.js';
import * as typesModule from '../src/types.js';
import * as uiModule from '../src/ui.js';

describe('compatibility smoke', () => {
  it('preserves the root default export and named root exports', () => {
    expect(typeof extension).toBe('function');
    expect(typeof createSubagentsPanelKeyMatcher).toBe('function');
    expect(typeof resolveRegisteredToolDefinition).toBe('function');
    expect(typeof moveClaudeBackgroundWidgetSelection).toBe('function');
    expect(typeof renderClaudeBackgroundWidgetLines).toBe('function');
    expect(typeof ClaudeBackgroundWidgetState).toBe('function');
    expect(typeof ClaudeBackgroundWidget).toBe('function');
    expect(typeof completionMessage).toBe('function');
    expect(typeof sendSubagentCompletionMessage).toBe('function');
    expect(typeof renderSubagentCompletionMessage).toBe('function');
  });

  it('preserves extension registration order and contract names', () => {
    const calls: string[] = [];
    const shortcuts: string[] = [];
    const commands: string[] = [];
    const tools: string[] = [];
    const events: string[] = [];
    const pi = {
      registerMessageRenderer: vi.fn((name: string) => { calls.push(`renderer:${name}`); }),
      registerTool: vi.fn((tool: { name: string }) => { calls.push(`tool:${tool.name}`); tools.push(tool.name); }),
      on: vi.fn((name: string) => { calls.push(`event:${name}`); events.push(name); }),
      registerShortcut: vi.fn((name: string) => { calls.push(`shortcut:${name}`); shortcuts.push(name); }),
      registerCommand: vi.fn((name: string) => { calls.push(`command:${name}`); commands.push(name); }),
    };

    extension(pi);

    expect(calls[0]).toBe('renderer:subagent-completion');
    expect(tools).toEqual([
      'subagent_list_agents',
      'subagent_run',
      'subagent_continue',
      'subagent_status',
      'subagent_result',
      'subagent_list_tasks',
      'subagent_cancel',
    ]);
    expect(events).toEqual(['session_start', 'session_shutdown']);
    expect(shortcuts).toEqual(expect.arrayContaining(['ctrl+,', 'ctrl+h']));
    expect(commands).toEqual(['subagents', 'subagent-models']);
  });
});

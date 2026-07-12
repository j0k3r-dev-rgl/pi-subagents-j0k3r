import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import extension, { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState, completionMessage, createSubagentsPanelKeyMatcher, moveClaudeBackgroundWidgetSelection, renderClaudeBackgroundWidgetLines, resolveRegisteredToolDefinition, sendSubagentCompletionMessage } from '../index.js';
import { loadSubagents, parseFrontmatter, readSubagentsConfig, resetGlobalSubagentModelProfileField, saveGlobalSubagentModelProfile, subagentSourceWarnings } from '../src/config.js';
import { resolveEffectiveSubagentProfile } from '../src/profile-resolver.js';
import { buildPrompt, ThreadSnapshotBuilder } from '../src/runner.js';
import { SubagentStructuredError, deriveErrorString, normalizeErrorMetadata, parseErrorMetadata, safeErrorMetadataDetails, serializeErrorMetadata } from '../src/error-metadata.js';
import { applyDirtyProfileEdit, buildModelProfileRows, buildNoChangesModelProfilesMessage, buildNonTuiModelProfilesMessage, commitStagedModelProfiles, createSubagentModelProfilesModal, globalSubagentsConfigPath, groupAvailableModelsByProvider, runSubagentModelsCommand, stageModelProfileEdit } from '../src/model-profiles-ui.js';
import { resolveSubagentHistoryDbPath, resolveSubagentsHistoryHome, SubagentHistoryStore } from '../src/history.js';
import { isSubagentsDebugEnabled, writeSubagentsDebugLog } from '../src/debug.js';
import { createSubagentsRenderLogger, DEFAULT_RENDER_DEBUG_LOG_PATH } from '../src/render-debug.js';
import { SubagentManager } from '../src/manager.js';
import { registerSubagentTools } from '../src/tools.js';
import { SubagentsHistoryPanel } from '../src/ui.js';
import { boundThreadSnapshot, isValidThreadSnapshot, registerSubagentRuntimeToolDefinition, renderThreadBody, resetPiComponentCacheForTests } from '../src/thread-view.js';
import type { EffectiveSubagentProfile, SubagentErrorMetadata, SubagentModelProfiles, SubagentRunner, SubagentTask } from '../src/types.js';

const require = createRequire(import.meta.url);

let tmp: string;
let oldAgentDir: string | undefined;
let oldHistoryDbPath: string | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagents-test-'));
  oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  oldHistoryDbPath = process.env.PI_SUBAGENTS_HISTORY_DB_PATH;
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'isolated-agent');
  process.env.PI_SUBAGENTS_HISTORY_DB_PATH = path.join(tmp, 'global-agent', 'subagents-history.sqlite');
  fs.mkdirSync(path.join(tmp, '.pi', 'subagents'), { recursive: true });
});
afterEach(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldHistoryDbPath === undefined) delete process.env.PI_SUBAGENTS_HISTORY_DB_PATH;
  else process.env.PI_SUBAGENTS_HISTORY_DB_PATH = oldHistoryDbPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeAgent(name: string, body = '# Agent\nhello') {
  fs.writeFileSync(path.join(tmp, '.pi', 'subagents', `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\ntools:\n  - read\n  - memory_search\n---\n${body}`);
}

function mockRunner(delay = 0): SubagentRunner {
  return async ({ definition, task }) => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return { result: `${definition.name} handled ${task}`, model: 'mock/model', fallback_used: false };
  };
}

function statusSnapshot(text: string) {
  return { version: 1 as const, source: 'events' as const, items: [{ type: 'status' as const, text }] };
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\][^\u001b]*(?:\u001b\\|\u0007)/g, '');
}

function renderText(snapshot: unknown, overrides: Partial<Parameters<typeof renderThreadBody>[1]> = {}): string {
  const context = {
    cwd: tmp,
    visibleWidth: (text: string) => stripAnsi(text).length,
    truncateToWidth: (text: string, width: number) => text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text,
    ...overrides,
  };
  return stripAnsi(renderThreadBody(snapshot, context).join('\n')).replace(/\s+/g, ' ').trim();
}

function withAgentDir<T>(agentDir: string, run: () => T): T {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return run();
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

function readJsonl(file: string): any[] {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

describe('structured error metadata public compatibility', () => {
  it('exposes compatible public task types while keeping error string optional', () => {
    const task: SubagentTask = {
      id: 'task-error-metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'render error',
      created_at: new Date().toISOString(),
      error: 'timed out after 123ms',
      error_metadata: normalizeErrorMetadata({
        category: 'total_timeout',
        message: 'timed out after 123ms',
        retryable: false,
        partial_result_available: true,
        details: { timeout_ms: '123', prompt: 'SYSTEM: hidden prompt text' },
        last_activity: `Working in /tmp/fake-private.txt ${'x'.repeat(700)}`,
      }),
    };

    expect(task.error).toBe('timed out after 123ms');
    expect(task.error_metadata?.version).toBe(1);
    expect(task.error_metadata?.last_activity?.length ?? 0).toBeLessThanOrEqual(512);
    expect(task.error_metadata?.last_activity).not.toContain('/tmp/fake-private.txt');
    expect(deriveErrorString(task.error_metadata!)).toBe(task.error);
  });

  it('serializes, parses, and exposes safe bounded metadata details without leaking secrets', () => {
    const metadata: SubagentErrorMetadata = normalizeErrorMetadata({
      category: 'provider_api_error',
      message: 'Authorization: Bearer sk-fake-secret-token fake.user@example.com /tmp/fake-private.txt',
      partial_result_available: false,
      details: {
        provider_code: '500',
        auth_header: 'Authorization: Bearer sk-fake-secret-token',
        prompt: 'USER: fake prompt body',
        file_path: '/tmp/fake-private.txt',
      },
    });

    const json = serializeErrorMetadata(metadata);
    expect(json).toBeTruthy();
    expect(json).not.toContain('sk-fake-secret-token');
    expect(json).not.toContain('fake.user@example.com');
    expect(json).not.toContain('/tmp/fake-private.txt');

    const parsed = parseErrorMetadata(json);
    expect(parsed).toBeDefined();
    expect(parsed?.version).toBe(1);

    const details = safeErrorMetadataDetails(parsed!);
    expect(JSON.stringify(details)).not.toContain('sk-fake-secret-token');
    expect(JSON.stringify(details)).not.toContain('fake.user@example.com');
    expect(JSON.stringify(details)).not.toContain('/tmp/fake-private.txt');
  });
});

describe('subagents extension', () => {
  it('does not statically depend on sibling extension internals', () => {
    const srcDir = path.join(process.cwd(), 'src');
    const files = fs.readdirSync(srcDir, { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.ts')) as string[];
    const source = files.map((file) => fs.readFileSync(path.join(srcDir, file), 'utf8')).join('\n');

    expect(source).not.toContain('../..');
    expect(source).not.toContain('/extensions/');
  });

  it('validates and bounds v1 subagent thread snapshots safely', () => {
    const snapshot = {
      version: 1,
      source: 'events',
      items: [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello from assistant' }] } },
        { type: 'tool', name: 'read', status: 'completed', arguments: { path: 'README.md' }, result: { content: [{ type: 'text', text: 'file body' }], isError: false } },
        { type: 'bash', command: 'npm test', output: 'passed', status: 'completed', exitCode: 0 },
        { type: 'error', text: 'safe error row' },
      ],
    };

    expect(isValidThreadSnapshot(snapshot)).toBe(true);
    expect(renderThreadBody(snapshot as any, { visibleWidth: (text) => text.length, truncateToWidth: (text, width) => text.slice(0, width), cwd: tmp }).join('\n')).toContain('hello from assistant');
    expect(renderThreadBody(snapshot as any, { visibleWidth: (text) => text.length, truncateToWidth: (text, width) => text.slice(0, width), cwd: tmp }).join('\n')).toContain('read completed');

    const bounded = boundThreadSnapshot({ version: 1, source: 'events', items: [{ type: 'status', text: 'x'.repeat(5000) }] } as any, { textLimit: 32 });
    expect(bounded?.items[0]).toMatchObject({ type: 'status', text: expect.stringMatching(/…$/) });
    expect((bounded?.items[0] as any).text.length).toBeLessThanOrEqual(32);
  });

  it('rejects malformed, missing, and future subagent thread snapshots', () => {
    expect(isValidThreadSnapshot(undefined)).toBe(false);
    expect(isValidThreadSnapshot(null)).toBe(false);
    expect(isValidThreadSnapshot({ version: 2, source: 'events', items: [] })).toBe(false);
    expect(isValidThreadSnapshot({ version: 1, source: 'events', items: [{ type: 'future', text: 'nope' }] })).toBe(false);
    expect(isValidThreadSnapshot({ version: 1, source: 'events', items: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text' }] } }] })).toBe(false);
  });

  it('loads Pi message components from the running Pi package and renders them at the requested width', () => {
    const packageRoot = path.join(tmp, 'fake-pi-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-message');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.getMarkdownTheme = () => ({ fakeMarkdownTheme: true });
      exports.AssistantMessageComponent = class {
        constructor(message, hideThinkingBlock, markdownTheme) { this.message = message; this.markdownTheme = markdownTheme; }
        render(width) { return ['pi-assistant:' + width + ':' + this.markdownTheme.fakeMarkdownTheme + ':' + this.message.content[0].text]; }
      };
      exports.UserMessageComponent = class {
        constructor(text, markdownTheme) { this.text = text; this.markdownTheme = markdownTheme; }
        render(width) { return ['pi-user:' + width + ':' + this.markdownTheme.fakeMarkdownTheme + ':' + this.text]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const lines = renderThreadBody({
        version: 1,
        source: 'events',
        items: [
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'from pi component' }] } },
          { type: 'user', text: 'user component text', label: 'user' },
        ],
      } as any, {
        cwd: tmp,
        renderWidth: 42,
        visibleWidth: (text: string) => text.length,
        truncateToWidth: (text: string, width: number) => text.length > width ? text.slice(0, width) : text,
      } as any);

      expect(lines.join('\n')).toContain('pi-assistant:42:true:from pi component');
      expect(lines.join('\n')).toContain('pi-user:42:true:user component text');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('includes the delegated orchestrator prompt and context as first user rows in thread snapshots', () => {
    const builder = new ThreadSnapshotBuilder('delegated prompt body', 'orchestrator context body');
    const snapshot = builder.snapshot();

    expect(snapshot?.items[0]).toMatchObject({ type: 'user', label: 'delegated_task', text: 'delegated prompt body' });
    expect(snapshot?.items[1]).toMatchObject({ type: 'user', label: 'context', text: 'orchestrator context body' });
  });

  it('resolves registered extension tool definitions from pi/context arrays and maps', () => {
    const memoryTool = { name: 'memory_search', label: 'Memory Search' };
    const readTool = { name: 'read', label: 'Read' };

    expect(resolveRegisteredToolDefinition({}, { tools: [memoryTool] }, 'memory_search')).toBe(memoryTool);
    expect(resolveRegisteredToolDefinition({ tools: new Map([['memory_search', memoryTool]]) }, {}, 'memory_search')).toBe(memoryTool);
    expect(resolveRegisteredToolDefinition({ pi: { getToolDefinition: (name: string) => name === 'read' ? readTool : undefined } }, { tools: [memoryTool] }, 'read')).toBe(readTool);
  });

  it('renders extension tool rows with Pi ToolExecutionComponent when the context supplies a tool definition', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-extension-tools-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-extension-tools');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.ToolExecutionComponent = class {
        constructor(name, id, args, options, definition) { this.name = name; this.args = args; this.definition = definition; }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult(result) { this.result = result; }
        setExpanded() {}
        render(width) { return ['pi-extension-tool:' + width + ':' + this.name + ':' + this.definition.label + ':' + this.args.query + ':' + this.result.content[0].text]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const lines = renderThreadBody({
        version: 1,
        source: 'events',
        items: [{ type: 'tool', name: 'memory_search', status: 'completed', arguments: { query: 'thread view' }, result: { content: [{ type: 'text', text: 'Found 1 memory result(s).' }], isError: false } }],
      } as any, {
        cwd: tmp,
        tui: { requestRender() {} },
        getToolDefinition: (name: string) => name === 'memory_search' ? { name, label: 'Memory Search' } : undefined,
        renderWidth: 180,
        visibleWidth: (text: string) => text.length,
        truncateToWidth: (text: string, width: number) => text.length > width ? text.slice(0, width) : text,
      } as any);

      expect(lines.join('\n')).toContain('pi-extension-tool:180:memory_search:Memory Search:thread view:Found 1 memory result(s).');
      expect(lines.join('\n')).not.toContain('memory_search completed ·');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('renders runtime subagent tool rows with Pi ToolExecutionComponent using the captured real tool definition', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-runtime-tool-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-runtime-tool');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.ToolExecutionComponent = class {
        constructor(name, id, args, options, definition) { this.name = name; this.args = args; this.definition = definition; }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult(result) { this.result = result; }
        setExpanded() {}
        render(width) { return ['pi-runtime-tool:' + width + ':' + this.name + ':' + this.definition.label + ':' + this.args.symbol + ':' + this.result.content[0].text]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      registerSubagentRuntimeToolDefinition('task-runtime-tools', 'find_symbol', { name: 'find_symbol', label: 'Find Symbol' });
      const lines = renderThreadBody({
        version: 1,
        source: 'events',
        items: [{ type: 'tool', name: 'find_symbol', status: 'completed', arguments: { symbol: 'registerSubagentTools' }, result: { content: [{ type: 'text', text: 'Found 1 match.' }], isError: false } }],
      } as any, {
        cwd: tmp,
        taskId: 'task-runtime-tools',
        tui: { requestRender() {} },
        renderWidth: 180,
        visibleWidth: (text: string) => text.length,
        truncateToWidth: (text: string, width: number) => text.length > width ? text.slice(0, width) : text,
      } as any);

      expect(lines.join('\n')).toContain('pi-runtime-tool:180:find_symbol:Find Symbol:registerSubagentTools:Found 1 match.');
      expect(lines.join('\n')).not.toContain('find_symbol completed ·');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('renders built-in tool rows with Pi ToolExecutionComponent from exported per-tool definitions', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-tools-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-tools');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      let readDefinitionCalls = 0;
      exports.createReadToolDefinition = (cwd) => { readDefinitionCalls += 1; return { name: 'read', cwd, readDefinitionCalls }; };
      exports.__readDefinitionCalls = () => readDefinitionCalls;
      exports.ToolExecutionComponent = class {
        constructor(name, id, args, options, definition, tui, cwd) { this.name = name; this.args = args; this.definition = definition; this.cwd = cwd; }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult(result) { this.result = result; }
        setExpanded() {}
        render(width) { return ['pi-tool:' + width + ':' + this.name + ':' + this.definition.cwd + ':' + this.args.path + ':' + this.result.content[0].text]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const lines = renderThreadBody({
        version: 1,
        source: 'events',
        items: [{ type: 'tool', name: 'read', status: 'completed', arguments: { path: 'AGENTS.md' }, result: { content: [{ type: 'text', text: 'file result' }], isError: false } }],
      } as any, {
        cwd: tmp,
        tui: { requestRender() {} },
        renderWidth: 200,
        visibleWidth: (text: string) => text.length,
        truncateToWidth: (text: string, width: number) => text.length > width ? text.slice(0, width) : text,
      } as any);

      expect(lines.join('\n')).toContain(`pi-tool:200:read:${tmp}:AGENTS.md:file result`);
      expect(lines.join('\n')).not.toContain('read completed ·');

      const second = renderThreadBody({
        version: 1,
        source: 'events',
        items: [{ type: 'tool', name: 'read', status: 'completed', arguments: { path: 'README.md' }, result: { content: [{ type: 'text', text: 'second result' }], isError: false } }],
      } as any, {
        cwd: tmp,
        tui: { requestRender() {} },
        renderWidth: 200,
        visibleWidth: (text: string) => text.length,
        truncateToWidth: (text: string, width: number) => text.length > width ? text.slice(0, width) : text,
      } as any);
      expect(second.join('\n')).toContain('README.md:second result');
      expect(require(packageRoot).__readDefinitionCalls()).toBe(1);
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('does not render assistant toolCall parts as raw requested text when tool rows exist', () => {
    const snapshot = {
      version: 1,
      source: 'mixed',
      items: [
        { type: 'assistant', message: { role: 'assistant', content: [
          { type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: 'AGENTS.md' } },
          { type: 'text', text: 'Summary after reading files.' },
        ] } },
        { type: 'tool', tool_call_id: 'call-read', name: 'read', status: 'completed', arguments: { path: 'AGENTS.md' }, result: { content: [{ type: 'text', text: '# Agent Guide' }], isError: false } },
      ],
    };

    const text = renderText(snapshot as any);

    expect(text).toContain('Summary after reading files.');
    expect(text).toContain('read');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('# Agent Guide');
    expect(text).not.toContain('tool read requested');
  });

  it('renders claude background widget lines for running background tasks only', () => {
    const now = new Date().toISOString();
    const tasks = [
      { id: 'task-main-ignore', agent: 'main-agent', mode: 'task', status: 'running', task: 'foreground task', created_at: now },
      { id: 'task-finished-ignore', agent: 'reviewer', mode: 'background', status: 'completed', task: 'finished task', created_at: now },
      { id: 'task-1', agent: 'claude', mode: 'background', status: 'running', task: 'ping-pong loop command', last_activity: 'Running ping-pong loop command.', created_at: now },
      { id: 'task-2', agent: 'claude', mode: 'background', status: 'queued', task: 'PING-PONG loop bash', last_activity: 'Running PING-PONG loop bash.', created_at: now },
    ] as any;

    expect(renderClaudeBackgroundWidgetLines(tasks)).toEqual([
      '○ main',
      '○ claude Running ping-pong loop command.',
      '○ claude Running PING-PONG loop bash.',
    ]);
    expect(renderClaudeBackgroundWidgetLines(tasks, 'task-2')).toEqual([
      '○ main',
      '○ claude Running ping-pong loop command.',
      '● claude Running PING-PONG loop bash.',
    ]);
    expect(moveClaudeBackgroundWidgetSelection(tasks, 'main', 'down')).toBe('task-1');
    expect(moveClaudeBackgroundWidgetSelection(tasks, 'task-1', 'down')).toBe('task-2');
    expect(moveClaudeBackgroundWidgetSelection(tasks, 'task-2', 'up')).toBe('task-1');
    expect(renderClaudeBackgroundWidgetLines([{ id: 'done', agent: 'claude', mode: 'background', status: 'completed', task: 'done', created_at: now }] as any)).toBeUndefined();
  });

  it('allows navigating the claude background widget selection with arrow keys', () => {
    const now = new Date().toISOString();
    const requestRender = vi.fn();
    const state = new ClaudeBackgroundWidgetState(
      () => [
        { id: 'task-1', agent: 'tool-smoke', mode: 'background', status: 'running', task: 'sleep 15', last_activity: 'Running sleep 15.', created_at: now },
        { id: 'task-2', agent: 'tool-smoke', mode: 'background', status: 'queued', task: 'sleep 30', last_activity: 'Queued sleep 30.', created_at: now },
      ] as any,
      requestRender,
    );
    const widget = new ClaudeBackgroundWidget(
      state,
      { fg: (_name: string, text: string) => text, bold: (text: string) => text },
    );

    expect(widget.render(200)).toEqual([
      '○ main',
      '○ tool-smoke Running sleep 15.',
      '○ tool-smoke Queued sleep 30.',
    ]);

    expect(state.handleTerminalInput('\u001b[B')).toEqual({ consume: true });
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(widget.render(200)).toEqual([
      '○ main',
      '● tool-smoke Running sleep 15.',
      '○ tool-smoke Queued sleep 30.',
    ]);

    expect(state.handleTerminalInput('q')).toEqual({ consume: true });
    expect(widget.render(200)).toEqual([
      '○ main',
      '● tool-smoke Running sleep 15.',
      '○ tool-smoke Queued sleep 30.',
    ]);

    expect(state.handleTerminalInput('\u001b[B')).toEqual({ consume: true });
    expect(widget.render(200)).toEqual([
      '○ main',
      '○ tool-smoke Running sleep 15.',
      '● tool-smoke Queued sleep 30.',
    ]);

    expect(state.handleTerminalInput('\u001b[A')).toEqual({ consume: true });
    expect(widget.render(200)).toEqual([
      '○ main',
      '● tool-smoke Running sleep 15.',
      '○ tool-smoke Queued sleep 30.',
    ]);

    expect(state.handleTerminalInput('\u001b[A')).toEqual({ consume: true });
    expect(widget.render(200)).toEqual([
      '● main',
      '○ tool-smoke Running sleep 15.',
      '○ tool-smoke Queued sleep 30.',
    ]);

    expect(state.handleTerminalInput('\u001b[D')).toEqual({ consume: true, action: { type: 'focus-editor' } });
    expect(widget.render(200)).toEqual([
      '○ main',
      '○ tool-smoke Running sleep 15.',
      '○ tool-smoke Queued sleep 30.',
    ]);

    expect(state.handleTerminalInput('\u001b[A')).toBeUndefined();
    expect(state.handleTerminalInput('x')).toBeUndefined();
  });

  it('renders the selected claude background widget row with warning styling only while navigation is active', () => {
    const now = new Date().toISOString();
    const state = new ClaudeBackgroundWidgetState(
      () => [
        { id: 'task-1', agent: 'tool-smoke', mode: 'background', status: 'running', task: 'sleep 15', last_activity: 'Running sleep 15.', created_at: now },
      ] as any,
    );
    const fg = vi.fn((_: string, text: string) => text);
    const bold = vi.fn((text: string) => text);
    const widget = new ClaudeBackgroundWidget(state, { fg, bold });

    widget.render(200);
    expect(fg).not.toHaveBeenCalledWith('warning', expect.any(String));

    state.handleTerminalInput('\u001b[B');
    widget.render(200);

    expect(fg).toHaveBeenCalledWith('warning', '● tool-smoke Running sleep 15.');
    expect(bold).toHaveBeenCalledWith('● tool-smoke Running sleep 15.');
  });

  it('returns to input on main enter and opens the selected subagent on enter', () => {
    const now = new Date().toISOString();
    const state = new ClaudeBackgroundWidgetState(
      () => [
        { id: 'task-1', agent: 'tool-smoke', mode: 'background', status: 'running', task: 'sleep 15', last_activity: 'Running sleep 15.', created_at: now },
      ] as any,
    );

    expect(state.handleTerminalInput('\u001b[B')).toEqual({ consume: true });
    expect(state.handleTerminalInput('\r')).toEqual({ consume: true, action: { type: 'open-task', taskId: 'task-1' } });

    expect(state.handleTerminalInput('\u001b[B')).toEqual({ consume: true });
    expect(state.handleTerminalInput('\u001b[A')).toEqual({ consume: true });
    expect(state.handleTerminalInput('\r')).toEqual({ consume: true, action: { type: 'focus-editor' } });
  });

  it('filters assistant toolCall parts before using Pi assistant components to avoid duplicate raw JSON', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-toolcall-filter-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-toolcall-filter');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.getMarkdownTheme = () => ({});
      exports.createReadToolDefinition = () => ({ name: 'read' });
      exports.AssistantMessageComponent = class {
        constructor(message) { this.message = message; }
        render() { return this.message.content.map((part) => part.type === 'toolCall' ? 'raw-tool-json:' + JSON.stringify(part.arguments) : 'assistant-text:' + part.text); }
      };
      exports.ToolExecutionComponent = class {
        constructor(name, id, args) { this.name = name; this.args = args; }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult(result) { this.result = result; }
        setExpanded() {}
        render() { return ['pi-tool-row:' + this.name + ':' + this.args.path]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const text = renderText({
        version: 1,
        source: 'mixed',
        items: [
          { type: 'assistant', message: { role: 'assistant', content: [
            { type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: 'AGENTS.md' } },
            { type: 'text', text: 'final answer' },
          ] } },
          { type: 'tool', tool_call_id: 'call-read', name: 'read', status: 'completed', arguments: { path: 'AGENTS.md' }, result: { content: [{ type: 'text', text: '# Agent Guide' }], isError: false } },
        ],
      } as any, { tui: { requestRender() {} } });

      expect(text).toContain('assistant-text:final answer');
      expect(text).toContain('pi-tool-row:read:AGENTS.md');
      expect(text).not.toContain('raw-tool-json');
      expect(text).not.toContain('{"path":"AGENTS.md"}');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('renders memory tool fallback as a concise tool call instead of raw JSON arguments', () => {
    const text = renderText({
      version: 1,
      source: 'events',
      items: [
        { type: 'tool', name: 'memory_search', status: 'completed', arguments: { query: 'subagent memory tools render', limit: 3, scopes: ['project', 'general', 'global'], compact: true }, result: { content: [{ type: 'text', text: 'Found 3 memory result(s).' }], isError: false } },
      ],
    } as any);

    expect(text).toContain('memory_search completed');
    expect(text).toContain('subagent memory tools render');
    expect(text).toContain('Found 3 memory result(s).');
    expect(text).not.toContain('{"query"');
    expect(text).not.toContain('"scopes"');
  });

  it('renders structured thread body rows with safe generic fallbacks', () => {
    const snapshot = {
      version: 1,
      source: 'events',
      items: [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant explains the plan' }] } },
        { type: 'tool', name: 'memory_search', status: 'completed', arguments: { query: 'thread view' }, result: { content: [{ type: 'text', text: 'memory result text' }], isError: false } },
        { type: 'bash', command: 'npm test -- --run', output: 'vitest passed', status: 'completed', exitCode: 0 },
        { type: 'tool', name: 'edit', status: 'completed', arguments: { path: 'src/thread-view.ts' }, result: { content: [{ type: 'text', text: 'updated one file' }], isError: false } },
        { type: 'tool', name: 'read', status: 'completed', arguments: { path: 'README.md' }, result: { content: [{ type: 'text', text: 'read preview' }], isError: false } },
        { type: 'tool', name: 'custom_tool', status: 'failed', arguments: { value: 'custom args' }, result: { content: [{ type: 'text', text: 'custom failure text' }], isError: true } },
        { type: 'custom', customType: 'extension.event', fallbackText: 'custom fallback text' },
        { type: 'error', text: 'renderer-safe error row' },
      ],
    };

    const text = renderText(snapshot as any);

    expect(text).toContain('assistant explains the plan');
    expect(text).toContain('memory_search');
    expect(text).toContain('thread view');
    expect(text).toContain('bash');
    expect(text).toContain('npm test -- --run');
    expect(text).toContain('vitest passed');
    expect(text).toContain('edit');
    expect(text).toContain('src/thread-view.ts');
    expect(text).toContain('read');
    expect(text).toContain('README.md');
    expect(text).toContain('custom_tool');
    expect(text).toContain('failed');
    expect(text).toContain('custom failure text');
    expect(text).toContain('custom fallback text');
    expect(text).toContain('renderer-safe error row');
  });

  it('bounds malformed thread items and continues rendering later rows', () => {
    const snapshot = {
      version: 1,
      source: 'events',
      items: [
        { type: 'status', text: 'before malformed' },
        { type: 'tool', name: `bad_tool_${'x'.repeat(160)}`, status: 'completed', arguments: { circular: true } },
        { type: 'future_tool_shape', raw: { name: 'future_custom', text: 'malformed item text' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'after malformed still visible' }] } },
      ],
    };
    (snapshot.items[1] as any).arguments.self = (snapshot.items[1] as any).arguments;

    const text = renderText(snapshot as any, { truncateToWidth: (line, width) => {
      if (line.includes('bad_tool')) throw new Error('forced renderer failure');
      return line.length > width ? line.slice(0, width) : line;
    } });

    expect(text).toContain('thread item unavailable');
    expect(text).toContain('malformed thread item');
    expect(text).toContain('after malformed still visible');
  });

  it('uses bounded body widths for long rendered rows', () => {
    const widths: number[] = [];
    const text = renderText({
      version: 1,
      source: 'events',
      items: [{ type: 'bash', command: `node ${'x'.repeat(180)}`, output: 'done', status: 'completed', exitCode: 0 }],
    } as any, {
      truncateToWidth: (line, width) => {
        widths.push(width);
        return line.length > 72 ? `${line.slice(0, 71)}…` : line;
      },
    });

    expect(Math.max(...widths)).toBeLessThanOrEqual(100);
    expect(text).toContain('…');
  });

  it('hydrates the selected history task snapshot lazily and memoizes rendered structured body', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-panel-memo-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-panel-memo');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      let assistantRenders = 0;
      exports.__assistantRenders = () => assistantRenders;
      exports.getMarkdownTheme = () => ({});
      exports.AssistantMessageComponent = class {
        constructor(message) { this.message = message; }
        render(width) { assistantRenders += 1; return ['assistant-render:' + width + ':' + this.message.content[0].text]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const summaryTask: SubagentTask = {
        id: 'subtask_lazy_panel',
        agent: 'analyst',
        mode: 'task',
        status: 'completed',
        task: 'lazy panel',
        created_at: new Date().toISOString(),
        last_activity_at: '2026-01-01T00:00:00.000Z',
      } as any;
      const fullTask: SubagentTask = {
        ...summaryTask,
        thread_snapshot: { version: 1, updated_at: 'snapshot-v1', source: 'events', items: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hydrated snapshot body' }] } }] },
      } as any;
      let detailLoads = 0;
      const panel = new SubagentsHistoryPanel(
        [summaryTask],
        { fg: (_name: string, text: string) => text },
        () => undefined,
        () => false,
        (text) => text.length,
        (text, width) => text.length > width ? text.slice(0, width) : text,
        { cwd: tmp },
        20,
        (id) => { detailLoads += 1; return id === fullTask.id ? fullTask : undefined; },
      );

      expect(panel.render(120).join('\n')).toContain('assistant-render:120:hydrated snapshot body');
      expect(panel.render(120).join('\n')).toContain('assistant-render:120:hydrated snapshot body');
      expect(detailLoads).toBe(1);
      expect(require(packageRoot).__assistantRenders()).toBe(1);
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('keeps legacy history panel fallback when thread_snapshot is missing or invalid', () => {
    const baseTask: SubagentTask = {
      id: 'subtask_legacy_1',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'legacy task',
      created_at: new Date().toISOString(),
      transcript: 'legacy transcript line',
      result: 'legacy result line',
      error: 'legacy error line',
    };
    const makePanel = (task: SubagentTask) => new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);

    expect(makePanel(baseTask).render(160).join('\n')).toContain('legacy transcript line');
    expect(makePanel({ ...baseTask, thread_snapshot: { version: 1, source: 'events', items: [{ type: 'future', text: 'ignore me' }] } as any }).render(160).join('\n')).toContain('legacy error line');
  });

  it('renders valid thread snapshots before legacy transcript text in the history panel', () => {
    const task: SubagentTask = {
      id: 'subtask_thread_1',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'thread task',
      created_at: new Date().toISOString(),
      transcript: 'legacy transcript should not win',
      result: 'legacy result should not win',
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'structured snapshot wins' }] } }] },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const rendered = panel.render(160).join('\n');

    expect(rendered).toContain('structured snapshot wins');
    expect(rendered).not.toContain('legacy transcript should not win');
    expect(rendered).not.toContain('legacy result should not win');
  });

  it('renders failed and cancelled terminal errors even when a valid thread snapshot exists', () => {
    const failedTask: SubagentTask = {
      id: 'subtask_thread_failed',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'thread task failed',
      created_at: new Date().toISOString(),
      error: 'provider api error',
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'structured snapshot body' }] } }] },
    };
    const cancelledTask: SubagentTask = {
      id: 'subtask_thread_cancelled',
      agent: 'analyst',
      mode: 'task',
      status: 'cancelled',
      task: 'thread task cancelled',
      created_at: new Date().toISOString(),
      error: 'Subagent cancelled: user request',
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status', text: 'cancellation reached runner' }] },
    };
    const makePanel = (task: SubagentTask) => new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);

    const failedRendered = makePanel(failedTask).render(160).join('\n');
    const cancelledRendered = makePanel(cancelledTask).render(160).join('\n');

    expect(failedRendered).toContain('structured snapshot body');
    expect(failedRendered).toContain('# error');
    expect(failedRendered).toContain('provider api error');
    expect(cancelledRendered).toContain('cancellation reached runner');
    expect(cancelledRendered).toContain('# error');
    expect(cancelledRendered).toContain('Subagent cancelled: user request');
  });

  it('does not duplicate terminal errors when an equivalent snapshot error item already exists', () => {
    const task: SubagentTask = {
      id: 'subtask_thread_error_dedup',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'thread task dedup',
      created_at: new Date().toISOString(),
      error: 'provider api error',
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'error', text: 'provider api error' }] },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const rendered = panel.render(160).join('\n');

    expect(rendered.match(/provider api error/g)).toHaveLength(1);
    expect(rendered).not.toContain('# error\nprovider api error');
  });

  it('keeps completed snapshot rendering unaffected and preserves boundThreadSnapshot limits', () => {
    const task: SubagentTask = {
      id: 'subtask_thread_completed',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'thread task completed',
      created_at: new Date().toISOString(),
      error: 'should stay hidden',
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'completed snapshot body' }] } }] },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const rendered = panel.render(160).join('\n');
    const bounded = boundThreadSnapshot({ version: 1, source: 'events', items: [{ type: 'error', text: 'x'.repeat(5000) }, { type: 'status', text: 'second item' }] } as any, { textLimit: 32, maxItems: 1 });

    expect(rendered).toContain('completed snapshot body');
    expect(rendered).not.toContain('# error');
    expect(rendered).not.toContain('should stay hidden');
    expect(bounded?.items).toHaveLength(1);
    expect((bounded?.items[0] as any).text.length).toBeLessThanOrEqual(32);
  });

  it('does not raw-truncate terminal-escaped Pi component lines that visually fit', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-ansi-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-ansi');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.createReadToolDefinition = (cwd) => ({ name: 'read', cwd });
      exports.ToolExecutionComponent = class {
        constructor() {}
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult() {}
        setExpanded() {}
        render() { return ['\\x1b[42m│\\x1b[0m \\x1b[42mread\\x1b[0m    \\x1b[42mAGENTS.md\\x1b[0m \\x1b[42m│\\x1b[0m']; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const task: SubagentTask = {
        id: 'subtask_component_ansi',
        agent: 'analyst',
        mode: 'task',
        status: 'completed',
        task: 'preserve ansi component line',
        created_at: new Date().toISOString(),
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'tool', name: 'read', status: 'completed', arguments: { path: 'AGENTS.md' }, result: { content: [{ type: 'text', text: 'body' }], isError: false } }] },
      };
      const visible = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '').length;
      const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, visible, (text, width) => text.length > width ? text.slice(0, width) : text, { cwd: tmp, tui: { requestRender() {} } });
      const rendered = panel.render(40).join('\n');

      expect(rendered).toContain('\u001b[42m');
      expect(rendered).toContain('\u001b[0m');
      expect(rendered.replace(/\u001b\[[0-9;]*m/g, '')).toContain('│ read    AGENTS.md │');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('does not add body ellipsis for hidden OSC hyperlink escapes in rendered thread lines', () => {
    const hiddenTarget = `file:///tmp/${'x'.repeat(160)}/AGENTS.md`;
    const oscLine = `\u001b]8;;${hiddenTarget}\u001b\\read AGENTS.md\u001b]8;;\u001b\\`;
    const lines = renderThreadBody({
      version: 1,
      source: 'events',
      items: [{ type: 'status', text: oscLine }],
    } as any, {
      cwd: tmp,
      renderWidth: 40,
      visibleWidth: (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '').length,
      truncateToWidth: (text: string, width: number) => text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text,
    } as any);
    const rendered = lines.join('\n');

    expect(rendered).not.toContain('…');
    expect(rendered.replace(/\u001b\][^\u001b]*(?:\u001b\\|\u0007)/g, '')).toContain('info: read AGENTS.md');
  });

  it('preserves Pi component-rendered spacing in selected thread snapshots', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-panel-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-panel');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.createReadToolDefinition = (cwd) => ({ name: 'read', cwd });
      exports.ToolExecutionComponent = class {
        constructor() {}
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult() {}
        setExpanded() {}
        render() { return ['╭──── read tool ────╮', '│ read    AGENTS.md │']; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const task: SubagentTask = {
        id: 'subtask_component_spacing',
        agent: 'analyst',
        mode: 'task',
        status: 'completed',
        task: 'preserve component spacing',
        created_at: new Date().toISOString(),
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'tool', name: 'read', status: 'completed', arguments: { path: 'AGENTS.md' }, result: { content: [{ type: 'text', text: 'body' }], isError: false } }] },
      };
      const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text, { cwd: tmp, tui: { requestRender() {} } });
      const rendered = panel.render(160).join('\n');

      expect(rendered).toContain('╭──── read tool ────╮');
      expect(rendered).toContain('│ read    AGENTS.md │');
      expect(rendered).not.toContain('│ read AGENTS.md │');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('splits multiline Pi component output into width-bounded physical lines', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-panel-multiline-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-panel-multiline');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.BashExecutionComponent = class {
        constructor() {}
        appendOutput(output) { this.output = output; }
        setComplete() {}
        setExpanded() {}
        render() { return ['go test results:\\r\\n' + this.output]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const task: SubagentTask = {
        id: 'subtask_component_multiline',
        agent: 'analyst',
        mode: 'task',
        status: 'completed',
        task: 'render multiline component output safely',
        created_at: new Date().toISOString(),
        thread_snapshot: {
          version: 1,
          source: 'events',
          items: [{
            type: 'bash',
            command: 'go test ./...',
            output: [
              'ok github.com/example/project/internal/components 0.929s',
              'ok github.com/example/project/internal/components/communitytool 0.044s',
            ].join('\n'),
            status: 'completed',
            exitCode: 0,
          }],
        },
      };
      const panel = new SubagentsHistoryPanel(
        [task],
        { fg: (_name: string, text: string) => text },
        () => undefined,
        () => false,
        (text) => text.length,
        (text, width) => text.length > width ? text.slice(0, width) : text,
        { cwd: tmp, tui: { requestRender() {} } },
      );
      const rendered = panel.render(48);

      expect(rendered.every((line) => !line.includes('\n') && !line.includes('\r'))).toBe(true);
      expect(rendered.every((line) => line.length <= 48)).toBe(true);
      expect(rendered.join('\n')).toContain('go test results:');
      expect(rendered.join('\n')).toContain('github.com/example/project/internal/component');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('toggles expanded tool output in selected thread snapshots with ctrl+o', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-panel-expand-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-panel-expand');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.BashExecutionComponent = class {
        constructor(command) { this.command = command; this.expanded = false; }
        appendOutput(output) { this.output = output; }
        setComplete() {}
        setExpanded(value) { this.expanded = value; }
        render() { return ['bash-expanded:' + this.expanded + ':' + this.command + ':' + this.output]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const task: SubagentTask = {
        id: 'subtask_component_expand',
        agent: 'analyst',
        mode: 'task',
        status: 'completed',
        task: 'toggle component expansion',
        created_at: new Date().toISOString(),
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'bash', command: 'npm test', output: 'long output', status: 'completed', exitCode: 0 }] },
      };
      const keys: Record<string, string> = { 'ctrl+o': '\u000f' };
      const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, (data, key) => data === keys[key], (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text, { cwd: tmp, tui: { requestRender() {} } });

      expect(panel.render(160).join('\n')).toContain('bash-expanded:false:npm test:long output');
      panel.handleInput('\u000f');
      expect(panel.render(160).join('\n')).toContain('bash-expanded:true:npm test:long output');
      panel.handleInput('\u000f');
      expect(panel.render(160).join('\n')).toContain('bash-expanded:false:npm test:long output');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('toggles expanded tool output with injected app.tools.expand keybindings', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-panel-expand-keybindings-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-panel-expand-keybindings');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      exports.BashExecutionComponent = class {
        constructor(command) { this.command = command; this.expanded = false; }
        appendOutput(output) { this.output = output; }
        setComplete() {}
        setExpanded(value) { this.expanded = value; }
        render() { return ['bash-expanded:' + this.expanded + ':' + this.command + ':' + this.output]; }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const task: SubagentTask = {
        id: 'subtask_component_expand_keybindings',
        agent: 'analyst',
        mode: 'task',
        status: 'completed',
        task: 'toggle component expansion with injected keybindings',
        created_at: new Date().toISOString(),
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'bash', command: 'npm test', output: 'long output', status: 'completed', exitCode: 0 }] },
      };
      const keybindings = { matches: (data: string, keybinding: string) => keybinding === 'app.tools.expand' && data === '\u001b[111;5u' };
      const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, createSubagentsPanelKeyMatcher(keybindings), (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text, { cwd: tmp, tui: { requestRender() {} } });

      expect(panel.render(160).join('\n')).toContain('bash-expanded:false:npm test:long output');
      panel.handleInput('\u001b[111;5u');
      expect(panel.render(160).join('\n')).toContain('bash-expanded:true:npm test:long output');
    } finally {
      process.argv[1] = oldArgv1;
      resetPiComponentCacheForTests();
    }
  });

  it('matches injected keybindings for panel navigation, scrolling, and detail cancel controls', () => {
    const matcher = createSubagentsPanelKeyMatcher({
      matches: (data: string, keybinding: string) => ({
        navUp: ['tui.select.up', 'tui.editor.cursorUp'],
        navDown: ['tui.select.down', 'tui.editor.cursorDown'],
        navLeft: ['tui.editor.cursorLeft'],
        navRight: ['tui.editor.cursorRight'],
        pageUpKey: ['tui.select.pageUp', 'tui.editor.pageUp'],
        pageDownKey: ['tui.select.pageDown', 'tui.editor.pageDown'],
        homeKey: ['tui.editor.cursorLineStart'],
        endKey: ['tui.editor.cursorLineEnd'],
        escKey: ['app.interrupt', 'tui.select.cancel'],
        ctrlWFromEditorBinding: ['tui.editor.deleteWordBackward'],
      }[data] ?? []).includes(keybinding),
    });

    expect(matcher('navUp', 'up')).toBe(true);
    expect(matcher('navDown', 'down')).toBe(true);
    expect(matcher('navLeft', 'left')).toBe(true);
    expect(matcher('navRight', 'right')).toBe(true);
    expect(matcher('pageUpKey', 'pageUp')).toBe(true);
    expect(matcher('pageDownKey', 'pageDown')).toBe(true);
    expect(matcher('homeKey', 'home')).toBe(true);
    expect(matcher('endKey', 'end')).toBe(true);
    expect(matcher('escKey', 'escape')).toBe(true);
    expect(matcher('ctrlWFromEditorBinding', 'detailCancel')).toBe(false);
    expect(matcher('other', 'down')).toBe(false);
  });

  it('navigates tasks and scrolls snapshots with injected tui keybindings', () => {
    const tasks: SubagentTask[] = [
      {
        id: 'subtask_keybinding_nav_1',
        agent: 'analyst',
        mode: 'task',
        status: 'completed',
        task: 'first task',
        created_at: new Date().toISOString(),
        thread_snapshot: {
          version: 1,
          source: 'events',
          items: Array.from({ length: 160 }, (_, i) => ({ type: 'status' as const, text: `first line ${String(i).padStart(3, '0')}` })),
        },
      },
      {
        id: 'subtask_keybinding_nav_2',
        agent: 'reviewer',
        mode: 'task',
        status: 'completed',
        task: 'second task',
        created_at: new Date().toISOString(),
        thread_snapshot: {
          version: 1,
          source: 'events',
          items: [{ type: 'status' as const, text: 'second task body' }],
        },
      },
    ];
    const matcher = createSubagentsPanelKeyMatcher({
      matches: (data: string, keybinding: string) => ({
        keyDown: ['tui.select.down'],
        keyUp: ['tui.select.up'],
        keyRight: ['tui.editor.cursorRight'],
        keyLeft: ['tui.editor.cursorLeft'],
        keyPageDown: ['tui.editor.pageDown'],
        keyHome: ['tui.editor.cursorLineStart'],
      }[data] ?? []).includes(keybinding),
    });
    const panel = new SubagentsHistoryPanel(tasks, { fg: (_name: string, text: string) => text }, () => undefined, matcher, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const body = () => panel.render(120).join('\n');

    expect(body()).toContain('agent: analyst');
    expect(body()).toContain('first line 159');

    panel.handleInput('keyHome');
    expect(body()).toContain('first line 000');

    panel.handleInput('keyDown');
    expect(body()).toContain('first line 001');

    panel.handleInput('keyPageDown');
    expect(body()).toContain('first line 013');

    panel.handleInput('keyRight');
    expect(body()).toContain('agent: reviewer');
    expect(body()).toContain('second task body');

    panel.handleInput('keyLeft');
    expect(body()).toContain('agent: analyst');

    panel.handleInput('keyHome');
    expect(body()).toContain('first line 000');

    panel.handleInput('keyUp');
    expect(body()).toContain('first line 000');
  });

  it('keeps the selected execution visible and yellow in the horizontal task strip while navigating', () => {
    const tasks: SubagentTask[] = Array.from({ length: 12 }, (_, i) => ({
      id: `subtask_visible_selection_${i + 1}`,
      agent: `agent-${String(i + 1).padStart(2, '0')}`,
      mode: 'task',
      status: 'completed',
      task: `task ${i + 1}`,
      created_at: new Date().toISOString(),
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status' as const, text: `body ${i + 1}` }] },
    }));
    const warningSelections: string[] = [];
    const theme = {
      fg: (name: string, text: string) => {
        if (name === 'warning') warningSelections.push(text);
        return `<${name}>${text}</${name}>`;
      },
      bold: (text: string) => text,
    };
    const matcher = (data: string, key: string) => key === 'right' && data === 'right';
    const panel = new SubagentsHistoryPanel(tasks, theme, () => undefined, matcher, (text) => text.replace(/<[^>]+>/g, '').length, (text, width) => text.length > width ? text.slice(0, width) : text, {}, 24);

    for (let i = 0; i < 9; i++) panel.handleInput('right');
    const rendered = panel.render(130).join('\n');

    expect(rendered).toContain('/12');
    expect(rendered).toContain('○ agent-09:completed');
    expect(rendered).toContain('● agent-10:completed');
    expect(rendered).toContain('○ agent-11:completed');
    expect(rendered).not.toContain('○ agent-01:completed');
    expect(warningSelections.some((text) => text.includes('● agent-10:completed'))).toBe(true);
  });

  it('preserves panel chrome while rendering selected thread snapshots', () => {
    const task: SubagentTask = {
      id: 'subtask_thread_2',
      agent: 'reviewer',
      mode: 'task',
      status: 'running',
      task: 'keep shell visible',
      created_at: new Date().toISOString(),
      last_activity: 'rendering snapshot',
      model: 'mock/model',
      effort: 'high',
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status', text: 'thread body visible' }] },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text, bold: (text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const rendered = panel.render(120).join('\n');

    expect(rendered).toContain('subagents');
    expect(rendered).toContain('agent: reviewer');
    expect(rendered).toContain('status: running');
    expect(rendered).toContain('model: mock/model');
    expect(rendered).toContain('task: keep shell visible');
    expect(rendered).toContain('● reviewer:running effort:high');
    expect(rendered).toContain('thread body visible');
  });

  it('uses the configured available height instead of a fixed overlay viewport', () => {
    const task: SubagentTask = {
      id: 'subtask_viewport_height',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'bounded viewport',
      created_at: new Date().toISOString(),
      thread_snapshot: {
        version: 1,
        source: 'events',
        items: Array.from({ length: 80 }, (_, i) => ({ type: 'status' as const, text: `viewport line ${String(i).padStart(2, '0')}` })),
      },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text, {}, () => 60);
    const lines = panel.render(100);

    expect(lines).toHaveLength(60);
    expect(lines.at(-1)).toMatch(/\d+-\d+\/80/);
  });

  it('preserves keyboard scrolling for long thread snapshot bodies', () => {
    const keys: Record<string, string> = { down: 'j', up: 'k', pageDown: 'f', pageUp: 'b', home: 'g', end: 'G' };
    const task: SubagentTask = {
      id: 'subtask_thread_scroll',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'scroll long thread',
      created_at: new Date().toISOString(),
      thread_snapshot: {
        version: 1,
        source: 'events',
        items: Array.from({ length: 160 }, (_, i) => ({ type: 'status' as const, text: `thread line ${String(i).padStart(3, '0')}` })),
      },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, (data, key) => data === keys[key], (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const body = () => panel.render(120).join('\n');

    expect(body()).toContain('thread line 159');
    expect(body()).not.toContain('thread line 000');
    panel.handleInput('g');
    expect(body()).toContain('thread line 000');
    panel.handleInput('j');
    expect(body()).toContain('thread line 001');
    panel.handleInput('f');
    expect(body()).toContain('thread line 013');
    panel.handleInput('b');
    expect(body()).toContain('thread line 001');
    panel.handleInput('G');
    expect(body()).toContain('thread line 159');
    expect(body()).not.toContain('thread line 000');
    panel.handleInput('g');
    expect(body()).toContain('thread line 000');
    panel.handleInput('k');
    expect(body()).toContain('thread line 000');
  });

  it('scrolls selected thread snapshots with SGR mouse wheel input', () => {
    const task: SubagentTask = {
      id: 'subtask_thread_mouse_scroll_sgr',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'mouse scroll long thread',
      created_at: new Date().toISOString(),
      thread_snapshot: {
        version: 1,
        source: 'events',
        items: Array.from({ length: 160 }, (_, i) => ({ type: 'status' as const, text: `mouse sgr line ${String(i).padStart(3, '0')}` })),
      },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const body = () => panel.render(120).join('\n');

    expect(body()).toContain('mouse sgr line 159');
    panel.handleInput('\x1b[<64;10;5M');
    expect(body()).toContain('mouse sgr line 158');
    expect(body()).not.toContain('mouse sgr line 159');
    panel.handleInput('\x1b[<65;10;5M');
    expect(body()).toContain('mouse sgr line 159');
  });

  it('scrolls selected thread snapshots with legacy X10 mouse wheel input', () => {
    const task: SubagentTask = {
      id: 'subtask_thread_mouse_scroll_x10',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'mouse scroll x10 long thread',
      created_at: new Date().toISOString(),
      thread_snapshot: {
        version: 1,
        source: 'events',
        items: Array.from({ length: 160 }, (_, i) => ({ type: 'status' as const, text: `mouse x10 line ${String(i).padStart(3, '0')}` })),
      },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const body = () => panel.render(120).join('\n');

    expect(body()).toContain('mouse x10 line 159');
    panel.handleInput(`\x1b[M${String.fromCharCode(32 + 64)}!!`);
    expect(body()).toContain('mouse x10 line 158');
    expect(body()).not.toContain('mouse x10 line 159');
    panel.handleInput(`\x1b[M${String.fromCharCode(32 + 65)}!!`);
    expect(body()).toContain('mouse x10 line 159');
  });

  it('follows newly appended thread lines only while the viewer is at the bottom', () => {
    const keys: Record<string, string> = { up: 'k', end: 'G' };
    const snapshot = {
      version: 1 as const,
      source: 'events' as const,
      items: Array.from({ length: 80 }, (_, i) => ({ type: 'status' as const, text: `tail line ${String(i).padStart(3, '0')}` })),
    };
    const task: SubagentTask = {
      id: 'subtask_thread_autotail',
      agent: 'analyst',
      mode: 'task',
      status: 'running',
      task: 'auto tail thread',
      created_at: new Date().toISOString(),
      thread_snapshot: snapshot,
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, (data, key) => data === keys[key], (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const body = () => panel.render(120).join('\n');

    expect(body()).toContain('tail line 079');
    snapshot.items.push({ type: 'status', text: 'tail line 080' });
    expect(body()).toContain('tail line 080');

    panel.handleInput('k');
    expect(body()).toContain('tail line 079');
    expect(body()).not.toContain('tail line 080');
    snapshot.items.push({ type: 'status', text: 'tail line 081' });
    expect(body()).toContain('tail line 079');
    expect(body()).not.toContain('tail line 081');

    panel.handleInput('G');
    expect(body()).toContain('tail line 081');
    snapshot.items.push({ type: 'status', text: 'tail line 082' });
    expect(body()).toContain('tail line 082');
  });

  it('registers agent-facing tools only', () => {
    const tools: string[] = [], commands: string[] = [], shortcuts: string[] = [];
    extension({
      registerTool: (tool: any) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (key: string) => shortcuts.push(key),
    });
    expect(tools).toContain('subagent_run');
    expect(tools).toContain('subagent_list_agents');
    expect(tools).toContain('subagent_status');
    expect(tools).toContain('subagent_result');
    expect(commands).toEqual(['subagents', 'subagent-models']);
    expect(shortcuts).toEqual(['ctrl+,', 'ctrl+h']);
  });

  it('registers a compact/expanded renderer for background subagent completion messages', () => {
    let renderer: any;
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      registerMessageRenderer: (customType: string, value: any) => { if (customType === 'subagent-completion') renderer = value; },
    });
    const message = {
      customType: 'subagent-completion',
      content: 'full content for orchestrator to=functions.memory_get',
      details: {
        full_result: 'background final response to=functions.memory_get',
        task: { id: 'subtask_background_1', agent: 'analyst', status: 'completed' },
      },
    };

    const collapsed = stripAnsi(renderer(message, { expanded: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n'));
    expect(collapsed).toContain('[subagent] analyst completed: subtask_background_1');
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).not.toContain('to=functions.memory_get');

    const expanded = stripAnsi(renderer(message, { expanded: true }, { fg: (_name: string, text: string) => text }).render(120).join('\n'));
    expect(expanded).toContain('background final response to=functions.memory_get');
  });

  it('delivers background completion messages without triggering or waiting for a follow-up turn', () => {
    const sendMessage = vi.fn();
    const task = {
      id: 'subtask_notify_1',
      agent: 'analyst',
      status: 'completed',
      mode: 'background',
      result: 'done while main agent continues',
      model: 'mock/model',
      effort: 'high',
    };

    sendSubagentCompletionMessage({ sendMessage }, task);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: 'steer' });
  });

  it('renders background completion messages with a distinct themed block background', () => {
    let renderer: any;
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      registerMessageRenderer: (customType: string, value: any) => { if (customType === 'subagent-completion') renderer = value; },
    });
    const message = {
      customType: 'subagent-completion',
      content: 'compact visible content',
      details: {
        full_result: 'background response',
        task: { id: 'subtask_background_color', agent: 'discovery', status: 'completed' },
      },
    };
    const theme = {
      fg: (name: string, text: string) => `FG(${name}:${text})`,
      bg: (name: string, text: string) => `BG(${name}:${text})`,
    };

    const rendered = renderer(message, { expanded: false }, theme).render(90).join('\n');

    expect(rendered).toContain('BG(customMessageBg:');
    expect(rendered).toContain('FG(customMessageLabel:');
    expect(rendered).toContain('[subagent] discovery completed');
  });

  it('wraps expanded background completion responses instead of truncating them', () => {
    let renderer: any;
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
      registerMessageRenderer: (customType: string, value: any) => { if (customType === 'subagent-completion') renderer = value; },
    });
    const longResponse = 'Una herramienta de subagentes en background debería comportarse de forma claramente asíncrona para que el usuario pueda leer todo el texto sin cortes.';
    const message = {
      customType: 'subagent-completion',
      content: 'compact visible content',
      details: {
        full_result: longResponse,
        task: { id: 'subtask_background_wrap', agent: 'discovery', status: 'completed' },
      },
    };

    const rendered = stripAnsi(renderer(message, { expanded: true }, { fg: (_name: string, text: string) => text }).render(52).join('\n'));
    expect(rendered).toContain('[subagent] discovery completed:');
    expect(rendered).toContain('subtask_background_wrap');
    expect(rendered).toContain('response sent to the orchestrator');
    expect(rendered).toContain('Una herramienta de subagentes en background');
    expect(rendered).toContain('cortes.');
    expect(rendered).not.toContain('…');
  });

  it('notifies duplicate agents/subagents names at session startup', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agents', 'dup.md'), `---\nname: dup\ndescription: global agents dup\n---\n# Dup`);
    fs.writeFileSync(path.join(agentDir, 'subagents', 'dup.md'), `---\nname: dup\ndescription: global subagents dup\n---\n# Dup`);
    const notifications: Array<[string, string | undefined]> = [];
    let sessionStart: any;
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      withAgentDir(agentDir, () => {
        extension({
          registerTool: () => undefined,
          registerCommand: () => undefined,
          registerShortcut: () => undefined,
          on: (event: string, handler: any) => { if (event === 'session_start') sessionStart = handler; },
        });
        sessionStart?.({}, { cwd: tmp, ui: { notify: (message: string, level?: string) => notifications.push([message, level]) } });
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(notifications).toHaveLength(1);
    expect(notifications[0][0]).toContain('Duplicate subagent name');
    expect(notifications[0][0]).toContain('dup');
    expect(notifications[0][0]).toContain('using subagents');
    expect(notifications[0][1]).toBe('warning');
  });

  it('registers the configured opencode history panel and detail cancel shortcuts at extension startup', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'opencode', history_panel_shortcut: 'ctrl+p', detail_cancel_shortcut: 'ctrl+shift+q' }));
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      const shortcuts: string[] = [];
      extension({
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerShortcut: (key: string) => shortcuts.push(key),
      });
      expect(shortcuts).toEqual(['ctrl+p', 'ctrl+shift+q', 'ctrl+h']);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('detail cancel shortcut only cancels while the subagents panel is active', async () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ detail_cancel_shortcut: 'ctrl+shift+q' }));
    let cancelShortcut: any;
    let subagentsCommand: any;
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      extension({
        registerTool: () => undefined,
        registerCommand: (name: string, command: any) => { if (name === 'subagents') subagentsCommand = command; },
        registerShortcut: (key: string, shortcut: any) => { if (key === 'ctrl+shift+q') cancelShortcut = shortcut.handler; },
      });
    } finally {
      process.chdir(previousCwd);
    }

    await cancelShortcut({ cwd: tmp });

    const customStarted = new Promise<void>((resolve) => {
      void subagentsCommand.handler('', {
        cwd: tmp,
        ui: {
          custom: async (factory: any) => {
            factory({ terminal: { write: () => undefined }, requestRender() {} }, { fg: (_name: string, text: string) => text }, {}, () => undefined);
            resolve();
            await new Promise(() => undefined);
          },
        },
      });
    });
    await customStarted;
    await cancelShortcut({ cwd: tmp });
  });

  it('subagents history panel can start focused on a selected task id', () => {
    const now = new Date().toISOString();
    const tasks = [
      { id: 'task-1', agent: 'first', mode: 'background', status: 'running', task: 'first task', created_at: now, last_activity_at: now, last_activity: 'running first' },
      { id: 'task-2', agent: 'second', mode: 'background', status: 'running', task: 'second task', created_at: now, last_activity_at: now, last_activity: 'running second' },
    ] as any;
    const panel = new SubagentsHistoryPanel(
      tasks,
      { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      () => undefined,
      () => false,
      (text) => text.length,
      (text, width) => text.length > width ? text.slice(0, width) : text,
      {},
      () => 30,
      undefined,
      'task-2',
    );

    const rendered = panel.render(120).join('\n');
    expect(rendered).toContain('2/2');
    expect(rendered).toContain('agent: second');
  });

  it('cancels only the active task currently selected in the history panel with the configured detail shortcut', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ detail_cancel_shortcut: 'w' }));
    expect(readSubagentsConfig(tmp).detail_cancel_shortcut).toBe('w');
    const now = new Date().toISOString();
    const tasks = [
      { id: 'task-1', agent: 'first', mode: 'background', status: 'running', task: 'first task', created_at: now },
      { id: 'task-2', agent: 'second', mode: 'background', status: 'completed', task: 'second task', created_at: now },
    ] as any;
    const cancelled: string[] = [];
    const panel = new SubagentsHistoryPanel(
      tasks,
      { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      () => undefined,
      (data, key) => key === 'detailCancel' && data === readSubagentsConfig(tmp).detail_cancel_shortcut,
      (text) => text.length,
      (text, width) => text.length > width ? text.slice(0, width) : text,
      {},
      () => 30,
      undefined,
      undefined,
      (id) => { cancelled.push(id); tasks.find((task: any) => task.id === id)!.status = 'cancelled'; },
      'w',
    );

    const header = panel.render(120).join('\n');
    expect(header).toContain('w cancel active');

    panel.handleInput('w');
    expect(cancelled).toEqual(['task-1']);

    panel.handleInput('\u001b[C');
    panel.handleInput('w');
    expect(cancelled).toEqual(['task-1']);
  });

  it('registers the configured claude background handoff shortcut at extension startup', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ background_handoff_shortcut: 'ctrl+b' }));
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      const shortcuts: string[] = [];
      extension({
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerShortcut: (key: string) => shortcuts.push(key),
      });
      expect(shortcuts).toEqual(['ctrl+,', 'ctrl+b']);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('registers terminal input routing in claude mode and cleans it up on shutdown', async () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    const handlers: Record<string, any> = {};
    const off = vi.fn();
    const setWidget = vi.fn();
    extension({
      on: (event: string, handler: any) => { handlers[event] = handler; },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: () => undefined,
    });

    await handlers.session_start?.({}, {
      cwd: tmp,
      ui: {
        setWidget,
        onTerminalInput: vi.fn(() => off),
      },
    });

    expect(setWidget).toHaveBeenCalled();
    expect(off).not.toHaveBeenCalled();

    await handlers.session_shutdown?.({}, { ui: { setWidget } });
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('disables ctrl+, in claude mode while keeping the command available', async () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    let shortcutHandler: any;
    let subagentsCommand: any;
    const custom = vi.fn();
    extension({
      registerTool: () => undefined,
      registerCommand: (name: string, command: any) => { if (name === 'subagents') subagentsCommand = command; },
      registerShortcut: (_key: string, shortcut: any) => { shortcutHandler = shortcut.handler; },
    });

    await shortcutHandler({ cwd: tmp, ui: { custom } });
    expect(custom).not.toHaveBeenCalled();

    await subagentsCommand.handler('', { cwd: tmp, ui: { custom } });
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('enables mouse tracking while the subagents history panel is open and disables it on close', async () => {
    let subagentsCommand: any;
    const writes: string[] = [];
    extension({
      registerTool: () => undefined,
      registerCommand: (name: string, command: any) => { if (name === 'subagents') subagentsCommand = command; },
    });

    await subagentsCommand.handler('', {
      cwd: tmp,
      ui: {
        custom: async (factory: any) => {
          const component = factory({ terminal: { write: (text: string) => writes.push(text) }, requestRender() {} }, { fg: (_name: string, text: string) => text }, {}, () => undefined);
          component.handleInput('\x1b');
        },
      },
    });

    expect(writes.join('')).toContain('\x1b[?1000h\x1b[?1006h');
    expect(writes.join('')).toContain('\x1b[?1006l\x1b[?1000l');
  });

  it('parses markdown agents with frontmatter', () => {
    const parsed = parseFrontmatter('---\nname: analyst\ntools:\n  - read\n---\n# Body');
    expect(parsed.data.name).toBe('analyst');
    expect(parsed.data.tools).toEqual(['read']);
    expect(parsed.body).toContain('# Body');
  });

  it('loads agent names from markdown files and config default model/effort', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'analyst.md'), `---\nname: analyst\ndescription: analyst agent\nmodel: anthropic/claude-sonnet-4-5\neffort: high\ntools:\n  - read\n---\n# Agent`);
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ default_model: 'openai/gpt-5.2', default_effort: 'medium', stall_timeout_ms: 10 }));
    const agents = loadSubagents(tmp);
    const config = readSubagentsConfig(tmp);
    expect(agents.map((a) => a.name)).toEqual(['analyst']);
    expect(agents[0].model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' });
    expect(agents[0].effort).toBe('high');
    expect(config.default_model).toEqual({ provider: 'openai', id: 'gpt-5.2' });
    expect(config.default_effort).toBe('medium');
    expect(config.stall_timeout_ms).toBe(10);
  });

  it('falls back for invalid numeric config values', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 'bad', timeout_ms: 'bad', stall_timeout_ms: -1 }));
    const config = readSubagentsConfig(tmp);
    expect(config.max_concurrency).toBe(5);
    expect(config.timeout_ms).toBe(1200000);
    expect(config.stall_timeout_ms).toBe(240000);
  });

  it('loads global subagents and lets project-local agents/config override them', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents', 'analyst.md'), `---\nname: analyst\ndescription: global analyst\ntools:\n  - read\n---\n# Global Analyst`);
    fs.writeFileSync(path.join(agentDir, 'subagents', 'reviewer.md'), `---\nname: reviewer\ndescription: global reviewer\ntools:\n  - read\n---\n# Global Reviewer`);
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ max_concurrency: 1, default_tools: ['read'] }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'analyst.md'), `---\nname: analyst\ndescription: project analyst\ntools:\n  - memory_search\n---\n# Project Analyst`);
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 2 }));
    const old = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const agents = loadSubagents(tmp);
    const config = readSubagentsConfig(tmp);
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    expect(agents.map((a) => `${a.name}:${a.description}`).sort()).toEqual(['analyst:project analyst', 'reviewer:global reviewer']);
    expect(config.max_concurrency).toBe(2);
    expect(config.default_tools).toEqual(['read']);
  });

  it('loads agents and subagents sources with project-local definitions taking precedence', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.pi', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agents', 'shared.md'), `---\nname: shared\ndescription: global agents shared\ntools:\n  - read\n---\n# Global Agents Shared`);
    fs.writeFileSync(path.join(agentDir, 'subagents', 'shared.md'), `---\nname: shared\ndescription: global subagents shared\ntools:\n  - read\n---\n# Global Subagents Shared`);
    fs.writeFileSync(path.join(agentDir, 'agents', 'global-only.md'), `---\nname: global-only\ndescription: global agents only\ntools:\n  - read\n---\n# Global Agents Only`);
    fs.writeFileSync(path.join(tmp, '.pi', 'agents', 'shared.md'), `---\nname: shared\ndescription: project agents shared\ntools:\n  - read\n---\n# Project Agents Shared`);
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'shared.md'), `---\nname: shared\ndescription: project subagents shared\ntools:\n  - read\n---\n# Project Subagents Shared`);
    fs.writeFileSync(path.join(tmp, '.pi', 'agents', 'project-only.md'), `---\nname: project-only\ndescription: project agents only\ntools:\n  - read\n---\n# Project Agents Only`);

    const agents = withAgentDir(agentDir, () => loadSubagents(tmp));

    expect(agents.map((a) => `${a.name}:${a.description}`).sort()).toEqual([
      'global-only:global agents only',
      'project-only:project agents only',
      'shared:project subagents shared',
    ]);
  });

  it('reports duplicate names between agents and subagents at the same scope', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.pi', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agents', 'dup.md'), `---\nname: dup\ndescription: global agents dup\n---\n# Dup`);
    fs.writeFileSync(path.join(agentDir, 'subagents', 'dup.md'), `---\nname: dup\ndescription: global subagents dup\n---\n# Dup`);
    fs.writeFileSync(path.join(tmp, '.pi', 'agents', 'local-dup.md'), `---\nname: local-dup\ndescription: project agents dup\n---\n# Dup`);
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'local-dup.md'), `---\nname: local-dup\ndescription: project subagents dup\n---\n# Dup`);

    const warnings = withAgentDir(agentDir, () => subagentSourceWarnings(tmp));

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('global');
    expect(warnings[0]).toContain('dup');
    expect(warnings[0]).toContain('agents');
    expect(warnings[0]).toContain('subagents');
    expect(warnings[1]).toContain('project');
    expect(warnings[1]).toContain('local-dup');
  });

  it('merges model_profiles from global and project config with project precedence', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({
      model_profiles: {
        analyst: { model: 'anthropic/claude-sonnet-4-5', effort: 'high' },
        reviewer: { model: 'openai/gpt-5.2', effort: 'low' },
        invalidEffort: { model: 'openai/gpt-5.2', effort: 'extreme' },
        invalidModel: { model: 'missing-provider', effort: 'low' },
      },
    }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({
      model_profiles: {
        analyst: { model: { provider: 'openai', id: 'gpt-5.2-codex' }, effort: 'medium' },
        projectOnly: { model: 'anthropic/claude-opus-4-5', effort: 'xhigh' },
      },
    }));

    const config = withAgentDir(agentDir, () => readSubagentsConfig(tmp));

    expect(config.model_profiles).toEqual({
      analyst: { model: { provider: 'openai', id: 'gpt-5.2-codex' }, effort: 'medium' },
      reviewer: { model: { provider: 'openai', id: 'gpt-5.2' }, effort: 'low' },
      invalideffort: { model: { provider: 'openai', id: 'gpt-5.2' } },
      invalidmodel: { effort: 'low' },
      projectonly: { model: { provider: 'anthropic', id: 'claude-opus-4-5' }, effort: 'xhigh' },
    });
  });

  it('defaults nested subagent sessions to lean resources and preserves legacy config behavior', () => {
    const agentDir = path.join(tmp, 'isolated-global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({
      default_model: 'openai/gpt-5.2',
      default_effort: 'medium',
      timeout_ms: 123,
      stall_timeout_ms: 45,
      max_concurrency: 3,
      default_tools: ['read', 'subagent_run', 'memory_search'],
    }));

    const config = withAgentDir(agentDir, () => readSubagentsConfig(tmp));

    expect(config.model_profiles).toEqual({});
    expect(config.default_model).toEqual({ provider: 'openai', id: 'gpt-5.2' });
    expect(config.default_effort).toBe('medium');
    expect(config.timeout_ms).toBe(123);
    expect(config.stall_timeout_ms).toBe(45);
    expect(config.max_concurrency).toBe(3);
    expect(config.default_tools).toEqual(['read', 'memory_search']);
    expect(config.session_resources).toBe('lean');
  });

  it('allows explicitly opting nested subagent sessions back into full resource loading', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ session_resources: 'full' }));

    expect(readSubagentsConfig(tmp).session_resources).toBe('full');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ sessionResources: 'full' }));

    expect(readSubagentsConfig(tmp).session_resources).toBe('full');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ session_resources: 'invalid' }));

    expect(readSubagentsConfig(tmp).session_resources).toBe('lean');
  });

  it('supports mode values with opencode fallback', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    expect(readSubagentsConfig(tmp).mode).toBe('claude');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'opencode' }));
    expect(readSubagentsConfig(tmp).mode).toBe('opencode');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'invalid' }));
    expect(readSubagentsConfig(tmp).mode).toBe('opencode');
  });

  it('supports configurable claude background handoff shortcuts with ctrl+h fallback', () => {
    expect(readSubagentsConfig(tmp).background_handoff_shortcut).toBe('ctrl+h');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ background_handoff_shortcut: 'ctrl+b' }));
    expect(readSubagentsConfig(tmp).background_handoff_shortcut).toBe('ctrl+b');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ backgroundHandoffShortcut: 'CTRL+X' }));
    expect(readSubagentsConfig(tmp).background_handoff_shortcut).toBe('ctrl+x');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ background_handoff_shortcut: 'alt+b' }));
    expect(readSubagentsConfig(tmp).background_handoff_shortcut).toBe('ctrl+h');
  });

  it('supports configurable opencode history and detail cancel shortcuts', () => {
    expect(readSubagentsConfig(tmp).history_panel_shortcut).toBe('ctrl+,');
    expect(readSubagentsConfig(tmp).detail_cancel_shortcut).toBe('x');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ history_panel_shortcut: 'CTRL+P', detail_cancel_shortcut: 'x' }));
    expect(readSubagentsConfig(tmp).history_panel_shortcut).toBe('ctrl+p');
    expect(readSubagentsConfig(tmp).detail_cancel_shortcut).toBe('x');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ detailCancelShortcut: 'CTRL+SHIFT+Q' }));
    expect(readSubagentsConfig(tmp).detail_cancel_shortcut).toBe('ctrl+shift+q');

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ historyPanelShortcut: 'alt+p', detailCancelShortcut: 'alt+w' }));
    expect(readSubagentsConfig(tmp).history_panel_shortcut).toBe('ctrl+,');
    expect(readSubagentsConfig(tmp).detail_cancel_shortcut).toBe('x');
  });

  it('keeps project model_profiles precedence while scalar config precedence is unchanged', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({
      default_model: 'global/model',
      default_effort: 'low',
      timeout_ms: 100,
      stall_timeout_ms: 200,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: {
        analyst: { model: 'global/analyst', effort: 'low' },
        reviewer: { effort: 'minimal' },
      },
    }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({
      default_model: 'project/model',
      default_effort: 'high',
      timeout_ms: 300,
      stall_timeout_ms: 400,
      max_concurrency: 2,
      default_tools: ['memory_search'],
      model_profiles: {
        analyst: { effort: 'xhigh' },
        reviewer: { model: 'project/reviewer' },
      },
    }));

    const config = withAgentDir(agentDir, () => readSubagentsConfig(tmp));

    expect(config.model_profiles).toEqual({
      analyst: { effort: 'xhigh' },
      reviewer: { model: { provider: 'project', id: 'reviewer' } },
    });
    expect(config.default_model).toEqual({ provider: 'project', id: 'model' });
    expect(config.default_effort).toBe('high');
    expect(config.timeout_ms).toBe(300);
    expect(config.stall_timeout_ms).toBe(400);
    expect(config.max_concurrency).toBe(2);
    expect(config.default_tools).toEqual(['memory_search']);
  });

  it('saves global model profiles without dropping supported or unknown config keys', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({
      default_model: 'openai/gpt-5.2',
      timeout_ms: 600,
      future_unknown_key: { keep: true },
      model_profiles: { reviewer: { effort: 'medium' } },
    }));

    saveGlobalSubagentModelProfile({ agentName: 'analyst', profile: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, effort: 'high' }, agentDir });

    const text = fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      default_model: 'openai/gpt-5.2',
      timeout_ms: 600,
      future_unknown_key: { keep: true },
      model_profiles: {
        reviewer: { effort: 'medium' },
        analyst: { model: 'anthropic/claude-sonnet-4-5', effort: 'high' },
      },
    });
  });

  it('creates global config and removes empty profile entries after resets', () => {
    const agentDir = path.join(tmp, 'global-agent');
    saveGlobalSubagentModelProfile({ agentName: 'analyst', profile: { model: { provider: 'openai', id: 'gpt-5.2' } }, agentDir });
    resetGlobalSubagentModelProfileField({ agentName: 'analyst', field: 'model', agentDir });

    const text = fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({});
  });

  it('resolves effective subagent profile with independent precedence and provenance labels', () => {
    const definition = {
      name: 'analyst',
      description: 'analyst',
      filePath: 'analyst.md',
      instructions: '# Analyst',
      model: { provider: 'definition', id: 'model' },
      effort: 'medium' as const,
      tools: ['read'],
    };
    const config = {
      default_model: { provider: 'default', id: 'model' },
      default_effort: 'low' as const,
      timeout_ms: 1,
      stall_timeout_ms: 1,
      max_concurrency: 1,
      default_tools: ['read'],
      model_profiles: { analyst: { model: { provider: 'profile', id: 'model' } } },
    };

    const resolved = resolveEffectiveSubagentProfile({
      agentName: 'analyst',
      definition,
      config,
      ctx: { model: { provider: 'orchestrator', id: 'model' }, pi: { getThinkingLevel: () => 'xhigh' } },
    });

    expect(resolved.model).toMatchObject({ value: { provider: 'profile', id: 'model' }, source: 'profile', label: 'profile: profile/model' });
    expect(resolved.effort).toMatchObject({ value: 'medium', source: 'definition', label: 'definition: medium' });
  });

  it('resolves definition defaults and orchestrator fallbacks independently', () => {
    const baseDefinition = { name: 'reviewer', description: 'reviewer', filePath: 'reviewer.md', instructions: '# Reviewer', tools: ['read'] };
    const config = { timeout_ms: 1, stall_timeout_ms: 1, max_concurrency: 1, default_tools: ['read'], model_profiles: { reviewer: { effort: 'high' as const } } };

    expect(resolveEffectiveSubagentProfile({
      agentName: 'reviewer',
      definition: baseDefinition,
      config,
      ctx: { model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' },
    })).toMatchObject({
      model: { value: { provider: 'orchestrator', id: 'model' }, source: 'orchestrator', label: 'orchestrator: orchestrator/model' },
      effort: { value: 'high', source: 'profile', label: 'profile: high' },
    });

    expect(resolveEffectiveSubagentProfile({
      agentName: 'reviewer',
      definition: baseDefinition,
      config: { ...config, default_model: { provider: 'default', id: 'model' }, default_effort: 'minimal' as const, model_profiles: {} },
      ctx: { model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' },
    })).toMatchObject({
      model: { value: { provider: 'default', id: 'model' }, source: 'default', label: 'default: default/model' },
      effort: { value: 'minimal', source: 'default', label: 'default: minimal' },
    });
  });

  it('builds model profile rows for loaded agents and known SDD phases with labels', () => withAgentDir(path.join(tmp, 'isolated-agent'), () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'isolated-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({
      model_profiles: {
        analyst: { model: 'missing/provider-model', effort: 'high' },
        'sdd-spec': { effort: 'medium' },
      },
    }));
    const definitions = loadSubagents(tmp);
    const config = readSubagentsConfig(tmp);
    const rows = buildModelProfileRows({
      definitions,
      config,
      ctx: { model: { provider: 'openai', id: 'gpt-5.2' }, thinkingLevel: 'low' },
      availableModels: [{ provider: 'openai', id: 'gpt-5.2' }],
    });

    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(['analyst', 'sdd-explore', 'sdd-spec', 'sdd-apply', 'sdd-verify']));
    expect(rows.find((row) => row.name === 'analyst')).toMatchObject({
      explicitProfile: {},
      scope: 'project',
      modelLabel: 'orchestrator: openai/gpt-5.2',
      effortLabel: 'orchestrator: low',
    });
    expect(rows.find((row) => row.name === 'sdd-explore')).toMatchObject({ modelLabel: 'orchestrator: openai/gpt-5.2', effortLabel: 'orchestrator: low' });
    expect(rows.find((row) => row.name === 'sdd-spec')).toMatchObject({ effortLabel: 'profile: medium' });
  }));

  it('builds model profile rows with source scope for global and project definitions', () => withAgentDir(path.join(tmp, 'global-agent'), () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents', 'shared.md'), `---\nname: shared\ndescription: global shared\n---\n# Global Shared`);
    fs.writeFileSync(path.join(agentDir, 'subagents', 'global-only.md'), `---\nname: global-only\ndescription: global only\n---\n# Global Only`);
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'shared.md'), `---\nname: shared\ndescription: project shared\n---\n# Project Shared`);
    const definitions = loadSubagents(tmp);
    const rows = buildModelProfileRows({
      definitions,
      config: readSubagentsConfig(tmp),
      ctx: { model: { provider: 'openai', id: 'gpt-5.2' }, thinkingLevel: 'low' },
    });

    expect(rows.find((row) => row.name === 'shared')).toMatchObject({ description: 'project shared', scope: 'project' });
    expect(rows.find((row) => row.name === 'global-only')).toMatchObject({ description: 'global only', scope: 'global' });
  }));

  it('groups available models by provider for provider and model selection', () => {
    expect(groupAvailableModelsByProvider([
      { provider: 'openai', id: 'gpt-5.2' },
      { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      { provider: { id: 'openai' }, model: 'gpt-5.2-codex' },
    ])).toEqual({
      anthropic: [{ provider: 'anthropic', id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }],
      openai: [
        { provider: 'openai', id: 'gpt-5.2', label: 'gpt-5.2' },
        { provider: 'openai', id: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
      ],
    });
  });

  it('stages selected row edits and reset operations without changing other rows', () => {
    let staged: SubagentModelProfiles = {
      analyst: { model: { provider: 'openai', id: 'gpt-5.2' }, effort: 'high' as const },
      reviewer: { effort: 'medium' as const },
    };

    staged = stageModelProfileEdit(staged, { agentName: 'analyst', model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, effort: 'low' });
    expect(staged.analyst).toEqual({ model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, effort: 'low' });
    expect(staged.reviewer).toEqual({ effort: 'medium' });

    staged = stageModelProfileEdit(staged, { agentName: 'analyst', reset: 'model' });
    expect(staged.analyst).toEqual({ effort: 'low' });
    staged = stageModelProfileEdit(staged, { agentName: 'analyst', reset: 'effort' });
    expect(staged.analyst).toEqual({});
    staged = stageModelProfileEdit(staged, { agentName: 'reviewer', reset: 'row' });
    expect(staged.reviewer).toEqual({});
  });

  it('tracks only dirty model profile rows while preserving reset semantics', () => {
    const baseProfiles: SubagentModelProfiles = {
      analyst: { model: { provider: 'openai', id: 'gpt-5.2' }, effort: 'high' },
      reviewer: {},
      'sdd-apply': { effort: 'medium' },
    };

    let dirty: SubagentModelProfiles = {};
    dirty = applyDirtyProfileEdit({
      baseProfiles,
      dirtyProfiles: dirty,
      edit: { agentName: 'analyst', effort: 'low' },
    });
    expect(dirty).toEqual({
      analyst: { model: { provider: 'openai', id: 'gpt-5.2' }, effort: 'low' },
    });
    expect(dirty).not.toHaveProperty('reviewer');

    dirty = applyDirtyProfileEdit({
      baseProfiles,
      dirtyProfiles: dirty,
      edit: { agentName: 'reviewer', model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } },
    });
    expect(dirty).toEqual({
      analyst: { model: { provider: 'openai', id: 'gpt-5.2' }, effort: 'low' },
      reviewer: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } },
    });

    dirty = applyDirtyProfileEdit({
      baseProfiles,
      dirtyProfiles: dirty,
      edit: { agentName: 'analyst', effort: 'high' },
    });
    expect(dirty).toEqual({
      reviewer: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } },
    });

    dirty = applyDirtyProfileEdit({
      baseProfiles,
      dirtyProfiles: dirty,
      edit: { agentName: 'sdd-apply', reset: 'row' },
    });
    expect(dirty).toEqual({
      reviewer: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } },
      'sdd-apply': {},
    });
    expect(dirty).not.toHaveProperty('sdd-spec');
  });

  it('returns an exact no-op Save All message without writing model profiles', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const existingConfig = {
      default_model: 'openai/gpt-5.2',
      model_profiles: { analyst: { effort: 'high' } },
    };
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify(existingConfig));

    const message = buildNoChangesModelProfilesMessage(agentDir);

    expect(message).toBe(`No subagent model profile changes to save. Nothing written to ${globalSubagentsConfigPath(agentDir)}.`);
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8'))).toEqual(existingConfig);
  });

  it('builds local rows with only local explicit profiles even when a global profile is inherited', () => withAgentDir(path.join(tmp, 'global-agent'), () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents', 'analyst.md'), `---\nname: analyst\ndescription: global analyst\n---\n# Global Analyst`);
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { model: 'global/model', effort: 'low' } } }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'analyst.md'), `---\nname: analyst\ndescription: project analyst\n---\n# Project Analyst`);

    const config = readSubagentsConfig(tmp);
    const rows = buildModelProfileRows({ definitions: loadSubagents(tmp), config, ctx: {} });
    const analyst = rows.find((row) => row.name === 'analyst');

    expect(analyst).toMatchObject({ scope: 'project', modelLabel: 'unresolved', effortLabel: 'unresolved' });
    expect(analyst?.explicitProfile).toEqual({});
  }));

  it('ignores project-local model profiles for global-only subagent definitions', () => withAgentDir(path.join(tmp, 'global-agent'), () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(path.join(agentDir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents', 'tool-smoke.md'), `---\nname: tool-smoke\ndescription: global smoke\n---\n# Global Smoke`);
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ model_profiles: { 'tool-smoke': { model: 'global/smoke', effort: 'low' } } }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ model_profiles: { 'tool-smoke': { model: 'project/wrong', effort: 'high' } } }));

    const rows = buildModelProfileRows({ definitions: loadSubagents(tmp), config: readSubagentsConfig(tmp), ctx: {} });
    const smoke = rows.find((row) => row.name === 'tool-smoke');

    expect(smoke).toMatchObject({ scope: 'global', modelLabel: 'profile: global/smoke', effortLabel: 'profile: low' });
    expect(smoke?.explicitProfile).toEqual({ model: { provider: 'global', id: 'smoke' }, effort: 'low' });
  }));

  it('commits staged model profile saves to global and project config by row scope', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({
      default_model: 'openai/gpt-5.2',
      model_profiles: { global_agent: { effort: 'medium' }, local_agent: { effort: 'low' } },
    }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({
      timeout_ms: 123,
      model_profiles: { local_agent: { effort: 'high' } },
    }));

    const message = commitStagedModelProfiles({
      agentDir,
      cwd: tmp,
      profileScopes: { local_agent: 'project', global_agent: 'global' },
      stagedProfiles: {
        local_agent: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, effort: 'xhigh' },
        global_agent: { model: { provider: 'openai', id: 'gpt-5.2-codex' } },
      },
      save: true,
    });

    expect(message).toContain(path.join(tmp, '.pi', 'subagents.json'));
    expect(message).toContain(globalSubagentsConfigPath(agentDir));
    expect(JSON.parse(fs.readFileSync(path.join(tmp, '.pi', 'subagents.json'), 'utf8'))).toEqual({
      timeout_ms: 123,
      model_profiles: { local_agent: { model: 'anthropic/claude-sonnet-4-5', effort: 'xhigh' } },
    });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8'))).toEqual({
      default_model: 'openai/gpt-5.2',
      model_profiles: {
        global_agent: { model: 'openai/gpt-5.2-codex' },
        local_agent: { effort: 'low' },
      },
    });
  });

  it('commits staged model profile saves and leaves config unchanged on cancel', () => {
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({
      default_model: 'openai/gpt-5.2',
      model_profiles: {
        analyst: { model: 'openai/gpt-5.2', effort: 'high' },
        reviewer: { effort: 'medium' },
      },
    }));
    const beforeCancel = fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8');
    expect(commitStagedModelProfiles({ agentDir, stagedProfiles: { analyst: {} }, save: false })).toMatch(/Cancelled/);
    expect(fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8')).toBe(beforeCancel);

    const message = commitStagedModelProfiles({
      agentDir,
      stagedProfiles: {
        analyst: { effort: 'low' },
        reviewer: {},
        'sdd-apply': { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } },
      },
      save: true,
    });

    expect(message).toContain('Saved subagent model profiles');
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8'))).toEqual({
      default_model: 'openai/gpt-5.2',
      model_profiles: {
        analyst: { effort: 'low' },
        'sdd-apply': { model: 'anthropic/claude-sonnet-4-5' },
      },
    });
  });

  it('modal navigates rows with arrow/vim/home/end keys and saves selected model identifiers', () => {
    const completions: any[] = [];
    let renderRequests = 0;
    const modal = createSubagentModelProfilesModal({
      rows: [
        { name: 'analyst', description: 'analysis agent', kind: 'subagent', modelLabel: 'default: openai/gpt-5.2', effortLabel: 'default: medium', effectiveModel: { provider: 'openai', id: 'gpt-5.2' }, effectiveEffort: 'medium', explicitProfile: {} },
        { name: 'reviewer', description: 'review agent', kind: 'subagent', modelLabel: 'orchestrator: openai/gpt-5.2-codex', effortLabel: 'orchestrator: low', effectiveModel: { provider: 'openai', id: 'gpt-5.2-codex' }, effectiveEffort: 'low', explicitProfile: {} },
        { name: 'sdd-apply', description: 'apply phase', kind: 'sdd-phase', modelLabel: 'unresolved model', effortLabel: 'unresolved effort', explicitProfile: {} },
      ],
      availableModels: [
        { provider: 'anthropic', id: 'claude-sonnet-4-5', label: 'Claude Sonnet' },
        { provider: 'openai', id: 'gpt-5.2-codex', label: 'GPT Codex' },
      ],
      tui: { requestRender: () => { renderRequests += 1; } },
      done: (result: any) => completions.push(result),
    });

    modal.handleInput('down');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+reviewer/);
    modal.handleInput('j');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+sdd-apply/);
    modal.handleInput('up');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+reviewer/);
    modal.handleInput('k');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+analyst/);
    modal.handleInput('end');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+sdd-apply/);
    modal.handleInput('home');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+analyst/);
    modal.handleInput('G');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+sdd-apply/);
    modal.handleInput('g');
    expect(stripAnsi(modal.render(100).join('\n'))).toMatch(/›\s+analyst/);

    modal.handleInput('enter');
    expect(stripAnsi(modal.render(100).join('\n'))).toContain('Select model provider for analyst');
    modal.handleInput('down');
    modal.handleInput('enter');
    expect(stripAnsi(modal.render(100).join('\n'))).toContain('Select anthropic model for analyst');
    modal.handleInput('enter');
    modal.handleInput('s');

    expect(completions).toEqual([{ action: 'save', dirtyProfiles: { analyst: { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } } } }]);
    expect(renderRequests).toBeGreaterThan(0);
  });

  it('modal handles main reset hotkeys, effort picker values, nested back, save, and cancel', () => {
    const rows = [
      { name: 'analyst', description: 'analysis agent', kind: 'subagent' as const, modelLabel: 'profile: openai/gpt-5.2', effortLabel: 'profile: medium', effectiveModel: { provider: 'openai', id: 'gpt-5.2' }, effectiveEffort: 'medium' as const, explicitProfile: { model: { provider: 'openai', id: 'gpt-5.2' }, effort: 'medium' as const } },
      { name: 'reviewer', description: 'review agent', kind: 'subagent' as const, modelLabel: 'orchestrator: openai/gpt-5.2-codex', effortLabel: 'orchestrator: low', effectiveModel: { provider: 'openai', id: 'gpt-5.2-codex' }, effectiveEffort: 'low' as const, explicitProfile: {} },
    ];
    const saved: any[] = [];
    const modal = createSubagentModelProfilesModal({ rows, availableModels: [{ provider: 'openai', id: 'gpt-5.2-codex', label: 'GPT Codex' }], done: (result: any) => saved.push(result) });

    modal.handleInput('e');
    const effortPicker = stripAnsi(modal.render(100).join('\n'));
    for (const label of ['inherit/reset effort', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']) expect(effortPicker).toContain(label);
    for (let i = 0; i < 5; i += 1) modal.handleInput('down');
    modal.handleInput('enter');
    modal.handleInput('M');
    modal.handleInput('E');
    modal.handleInput('r');
    modal.handleInput('down');
    modal.handleInput('m');
    modal.handleInput('q');
    modal.handleInput('s');

    expect(saved).toEqual([{ action: 'save', dirtyProfiles: { analyst: {} } }]);

    const cancelled: any[] = [];
    const cancelModal = createSubagentModelProfilesModal({ rows, availableModels: [], done: (result: any) => cancelled.push(result) });
    cancelModal.handleInput('q');
    expect(cancelled).toEqual([{ action: 'cancel' }]);

    const escaped: any[] = [];
    const escapeModal = createSubagentModelProfilesModal({ rows, availableModels: [], done: (result: any) => escaped.push(result) });
    escapeModal.handleInput('esc');
    expect(escaped).toEqual([{ action: 'cancel' }]);
  });

  it('modal preserves unrelated dirty rows when nested pickers are cancelled', () => {
    const results: any[] = [];
    const modal = createSubagentModelProfilesModal({
      rows: [
        { name: 'analyst', description: 'analysis agent', kind: 'subagent', modelLabel: 'default: openai/gpt-5.2', effortLabel: 'default: medium', effectiveModel: { provider: 'openai', id: 'gpt-5.2' }, effectiveEffort: 'medium', explicitProfile: {} },
        { name: 'reviewer', description: 'review agent', kind: 'subagent', modelLabel: 'orchestrator: openai/gpt-5.2-codex', effortLabel: 'orchestrator: low', effectiveModel: { provider: 'openai', id: 'gpt-5.2-codex' }, effectiveEffort: 'low', explicitProfile: {} },
      ],
      availableModels: [{ provider: 'openai', id: 'gpt-5.2-codex', label: 'GPT Codex' }],
      done: (result: any) => results.push(result),
    });

    modal.handleInput('e');
    for (let i = 0; i < 6; i += 1) modal.handleInput('down');
    modal.handleInput('enter');
    modal.handleInput('down');
    modal.handleInput('m');
    modal.handleInput('esc');
    modal.handleInput('s');

    expect(results).toEqual([{ action: 'save', dirtyProfiles: { analyst: { effort: 'xhigh' } } }]);
  });

  it('modal labels each subagent row with a dimmed local/global scope', () => {
    const dimmed: string[] = [];
    const modal = createSubagentModelProfilesModal({
      rows: [
        { name: 'analyst', description: 'analysis agent', kind: 'subagent', scope: 'project', modelLabel: 'default: openai/gpt-5.2', effortLabel: 'default: medium', explicitProfile: {} },
        { name: 'reviewer', description: 'review agent', kind: 'subagent', scope: 'global', modelLabel: 'orchestrator: openai/gpt-5.2-codex', effortLabel: 'orchestrator: low', explicitProfile: {} },
      ],
      theme: { fg: (name: string, text: string) => { if (name === 'dim') dimmed.push(text); return text; } },
      availableModels: [],
      done: () => undefined,
    });

    const rendered = stripAnsi(modal.render(120).join('\n'));

    expect(rendered).toContain('analyst (local)');
    expect(rendered).toContain('reviewer (global)');
    expect(dimmed).toEqual(expect.arrayContaining(['(local)', '(global)']));
  });

  it('modal renders a compact model/effort editor without noisy descriptions', () => {
    const modal = createSubagentModelProfilesModal({
      rows: [
        { name: 'analyst', description: 'long analysis description that should not take vertical space in the compact default view', kind: 'subagent', modelLabel: 'default: openai/gpt-5.2', effortLabel: 'default: medium', effectiveModel: { provider: 'openai', id: 'gpt-5.2' }, effectiveEffort: 'medium', explicitProfile: {} },
        { name: 'reviewer', description: 'review agent', kind: 'subagent', modelLabel: 'orchestrator: openai/gpt-5.2-codex', effortLabel: 'orchestrator: low', effectiveModel: { provider: 'openai', id: 'gpt-5.2-codex' }, effectiveEffort: 'low', explicitProfile: {} },
        { name: 'sdd-apply', description: 'apply phase', kind: 'sdd-phase', modelLabel: 'orchestrator: openai/gpt-5.5', effortLabel: 'orchestrator: high', effectiveModel: { provider: 'openai', id: 'gpt-5.5' }, effectiveEffort: 'high', explicitProfile: {} },
      ],
      availableModels: [],
      done: () => undefined,
    });

    const lines = modal.render(120).map(stripAnsi);
    const rendered = lines.join('\n');

    expect(rendered).toContain('Subagent model profiles');
    expect(rendered).toContain('target: local/global by subagent scope');
    expect(rendered).toContain('pending: none');
    expect(rendered).toContain('agent/phase');
    expect(rendered).toContain('model');
    expect(rendered).toContain('effort');
    expect(lines.some((line) => line.startsWith('│ target: local/global by subagent scope'))).toBe(true);
    expect(rendered).toContain('›   analyst');
    expect(rendered).toContain('reviewer');
    expect(rendered).toContain('sdd-apply');
    expect(rendered).toContain('selected: analyst');
    expect(rendered).not.toContain('long analysis description');
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it('modal renders a framed compact layout with destination and dirty status', () => {
    const modal = createSubagentModelProfilesModal({
      rows: [
        { name: 'analyst', description: 'analysis agent', kind: 'subagent', modelLabel: 'default: openai/gpt-5.2', effortLabel: 'default: medium', effectiveModel: { provider: 'openai', id: 'gpt-5.2' }, effectiveEffort: 'medium', explicitProfile: {} },
        { name: 'reviewer', description: 'review agent', kind: 'subagent', modelLabel: 'orchestrator: openai/gpt-5.2-codex', effortLabel: 'orchestrator: low', effectiveModel: { provider: 'openai', id: 'gpt-5.2-codex' }, effectiveEffort: 'low', explicitProfile: {} },
      ],
      availableModels: [{ provider: 'openai', id: 'gpt-5.2-codex', label: 'GPT Codex' }],
      done: () => undefined,
    });

    const initial = stripAnsi(modal.render(120).join('\n'));
    expect(initial).toContain('╭');
    expect(initial).toContain('Subagent model profiles');
    expect(initial).toContain('target: local/global by subagent scope');
    expect(initial).toContain('pending: none');
    expect(initial).toContain('agent/phase');
    expect(initial).toContain('model');
    expect(initial).toContain('effort');
    expect(initial).toContain('selected: analyst');
    expect(initial).toContain('enter/m model');

    modal.handleInput('e');
    for (let i = 0; i < 5; i += 1) modal.handleInput('down');
    modal.handleInput('enter');
    const dirty = stripAnsi(modal.render(120).join('\n'));
    expect(dirty).toContain('pending: 1 change');
    expect(dirty).toContain('* analyst');
  });

  it('modal keeps unavailable model text discoverable and constrains rendered width', () => {
    const modal = createSubagentModelProfilesModal({
      rows: [{
        name: 'analyst',
        description: `analysis agent with ${'very '.repeat(20)}long description`,
        kind: 'subagent',
        modelLabel: `profile: missing/${'model-'.repeat(20)} (unavailable)`,
        effortLabel: 'profile: high',
        effectiveModel: { provider: 'missing', id: `${'model-'.repeat(20)}legacy` },
        effectiveEffort: 'high',
        explicitProfile: { model: { provider: 'missing', id: `${'model-'.repeat(20)}legacy` }, effort: 'high' },
      }],
      availableModels: [],
      done: () => undefined,
    });

    for (const width of [42, 120]) {
      const lines = modal.render(width).map(stripAnsi);
      expect(lines.every((line) => line.length <= width)).toBe(true);
    }
    expect(stripAnsi(modal.render(120).join('\n'))).toContain('unavailable');
  });

  it('returns non-TUI fallback text with the global subagents config path', async () => {
    const message = buildNonTuiModelProfilesMessage('/home/example/.pi/agent');
    expect(message).toContain('subagent model profiles require Pi TUI');
    expect(message).toContain('/home/example/.pi/agent/subagents.json');

    await expect(runSubagentModelsCommand({ cwd: tmp })).resolves.toContain(path.join(os.homedir(), '.pi', 'agent', 'subagents.json'));
  });

  it('subagent models command uses custom modal overlay and saves project-local dirty rows locally', async () => {
    writeAgent('analyst');
    writeAgent('reviewer');
    const agentDir = path.join(tmp, 'global-agent');
    const notifications: Array<[string, string | undefined]> = [];
    let capturedOptions: any;
    const custom = vi.fn(async (factory: any, options: any) => {
      capturedOptions = options;
      let result: any;
      const component = factory({ requestRender() {} }, {}, {}, (value: any) => { result = value; });
      component.handleInput('enter');
      component.handleInput('down');
      component.handleInput('enter');
      component.handleInput('enter');
      component.handleInput('down');
      component.handleInput('e');
      for (let i = 0; i < 5; i += 1) component.handleInput('down');
      component.handleInput('enter');
      component.handleInput('s');
      return result;
    });

    const message = await withAgentDir(agentDir, () => runSubagentModelsCommand({
      cwd: tmp,
      agentDir,
      modelRegistry: { getAvailable: async () => [{ provider: 'openai', id: 'gpt-5.2', label: 'GPT 5.2' }] },
      ui: { custom, notify: (text: string, level?: string) => notifications.push([text, level]) },
    }));

    expect(custom).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toEqual({ overlay: true, overlayOptions: { anchor: 'center', width: '96%', maxHeight: '90%', minWidth: 96 } });
    expect(message).toBe(`Saved subagent model profiles to ${path.join(tmp, '.pi', 'subagents.json')}.`);
    expect(notifications).toEqual([[message, 'info']]);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, '.pi', 'subagents.json'), 'utf8'))).toEqual({
      model_profiles: {
        analyst: { model: 'openai/gpt-5.2' },
        reviewer: { effort: 'high' },
      },
    });
    expect(fs.existsSync(path.join(agentDir, 'subagents.json'))).toBe(false);
  });

  it('subagent models command custom Save All with no dirty rows writes nothing and notifies exact no-op message', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { effort: 'medium' } } }));
    const before = fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8');
    const notifications: Array<[string, string | undefined]> = [];

    const message = await withAgentDir(agentDir, () => runSubagentModelsCommand({
      cwd: tmp,
      agentDir,
      modelRegistry: { getAvailable: async () => [] },
      ui: {
        custom: async (factory: any) => {
          let result: any;
          const component = factory({ requestRender() {} }, {}, {}, (value: any) => { result = value; });
          component.handleInput('s');
          return result;
        },
        notify: (text: string, level?: string) => notifications.push([text, level]),
      },
    }));

    expect(message).toBe(`No subagent model profile changes to save. Nothing written to ${globalSubagentsConfigPath(agentDir)}.`);
    expect(notifications).toEqual([[message, 'info']]);
    expect(fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8')).toBe(before);
  });

  it('subagent models command custom top-level cancel writes nothing and preserves cancel warning', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { effort: 'medium' } } }));
    const before = fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8');
    const notifications: Array<[string, string | undefined]> = [];

    const message = await withAgentDir(agentDir, () => runSubagentModelsCommand({
      cwd: tmp,
      agentDir,
      modelRegistry: { getAvailable: async () => [] },
      ui: {
        custom: async (factory: any) => {
          let result: any;
          const component = factory({ requestRender() {} }, {}, {}, (value: any) => { result = value; });
          component.handleInput('e');
          component.handleInput('down');
          component.handleInput('enter');
          component.handleInput('q');
          return result;
        },
        notify: (text: string, level?: string) => notifications.push([text, level]),
      },
    }));

    expect(message).toBe(`Cancelled. No changes written to ${globalSubagentsConfigPath(agentDir)}.`);
    expect(notifications).toEqual([[message, 'warning']]);
    expect(fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8')).toBe(before);
  });

  it('fallback select wizard remains usable when custom ui is absent', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    const select = vi.fn(async (prompt: string, choices: string[]) => {
      if (prompt.startsWith('Select subagent')) return choices.find((choice) => choice.startsWith('analyst'));
      if (prompt.startsWith('Configure analyst')) return 'Set provider/model/effort';
      if (prompt.startsWith('Select provider')) return 'openai';
      if (prompt.startsWith('Select model')) return 'GPT Codex';
      if (prompt.startsWith('Select effort')) return 'high';
      if (prompt.startsWith('Save subagent')) return 'Save';
      return choices[0];
    });

    const message = await withAgentDir(agentDir, () => runSubagentModelsCommand({
      cwd: tmp,
      agentDir,
      modelRegistry: { getAvailable: async () => [{ provider: 'openai', id: 'gpt-5.2-codex', label: 'GPT Codex' }] },
      ui: { select },
    }));

    expect(message).toBe(`Saved subagent model profiles to ${path.join(tmp, '.pi', 'subagents.json')}.`);
    expect(select).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(tmp, '.pi', 'subagents.json'), 'utf8'))).toEqual({
      model_profiles: { analyst: { model: 'openai/gpt-5.2-codex', effort: 'high' } },
    });
    expect(fs.existsSync(path.join(agentDir, 'subagents.json'))).toBe(false);
  });

  it('fallback select wizard cancel writes nothing and non-tui fallback remains compatible', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { effort: 'medium' } } }));
    const before = fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8');
    const select = vi.fn(async (prompt: string, choices: string[]) => {
      if (prompt.startsWith('Select subagent')) return choices.find((choice) => choice.startsWith('analyst'));
      if (prompt.startsWith('Configure analyst')) return 'Cancel';
      return choices[0];
    });

    const message = await withAgentDir(agentDir, () => runSubagentModelsCommand({ cwd: tmp, agentDir, ui: { select } }));

    expect(message).toBe(`Cancelled. No changes written to ${globalSubagentsConfigPath(agentDir)}.`);
    expect(fs.readFileSync(path.join(agentDir, 'subagents.json'), 'utf8')).toBe(before);
    await expect(runSubagentModelsCommand({ cwd: tmp, agentDir, ui: {} })).resolves.toBe(buildNonTuiModelProfilesMessage(agentDir));
  });

  it('filters delegation tools from subagent tool allowlists', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'analyst.md'), `---\nname: analyst\ntools:\n  - read\n  - subagent_run\n  - subagent_result\n  - memory_search\n---\n# Agent`);
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ default_tools: ['read', 'subagent_run', 'memory_search'] }));
    const agents = loadSubagents(tmp);
    const config = readSubagentsConfig(tmp);
    expect(agents[0].tools).toEqual(['read', 'memory_search']);
    expect(config.default_tools).toEqual(['read', 'memory_search']);
  });

  it('allows sdd agents to receive memory write tools while still blocking delegation tools', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents', 'sdd-explore.md'), `---\nname: sdd-explore\ntools:\n  - read\n  - memory_search\n  - memory_get\n  - memory_add\n  - memory_update\n  - subagent_run\n---\n# SDD Explore`);
    const agents = loadSubagents(tmp);
    expect(agents[0].tools).toEqual(['read', 'memory_search', 'memory_get', 'memory_add', 'memory_update']);
  });

  it('builds a delegated user prompt without embedding subagent system instructions', () => {
    const prompt = buildPrompt({ name: 'analyst', description: 'analyst', filePath: 'analyst.md', instructions: '# Analyst\nSYSTEM_ONLY', tools: ['read', 'memory_search', 'memory_get'] }, 'inspect', undefined, ['read', 'memory_search', 'memory_get']);
    expect(prompt).toBe('## delegated task\ninspect');
    expect(prompt).not.toContain('SYSTEM_ONLY');
    expect(prompt).not.toContain('operating constraints');
  });

  it('keeps orchestrator context in the delegated user prompt when supplied', () => {
    const prompt = buildPrompt({ name: 'sdd-explore', description: 'sdd', filePath: 'sdd-explore.md', instructions: '# SDD Explore', tools: ['read'] }, 'explore feature', 'CWD: /tmp/project', ['read']);
    expect(prompt).toBe('## orchestrator context\nCWD: /tmp/project\n\n## delegated task\nexplore feature');
  });

  it('loads configured workflow subagents with no delegation tools and memory writes only for phase agents', () => {
    const writeConfiguredSubagent = (name: string, tools: string[]) => {
      fs.writeFileSync(path.join(tmp, '.pi', 'subagents', `${name}.md`), [
        '---',
        `name: ${name}`,
        `description: ${name} agent`,
        'tools:',
        ...tools.map((tool) => `  - ${tool}`),
        '---',
        `# ${name}`,
      ].join('\n'));
    };
    writeConfiguredSubagent('discovery', ['read', 'bash', 'memory_search', 'memory_get', 'subagent_run']);
    writeConfiguredSubagent('prd-review', ['read', 'bash', 'memory_search', 'memory_get', 'memory_add', 'memory_update', 'subagent_cancel']);
    writeConfiguredSubagent('sdd-explore', [
      'read',
      'bash',
      'skill_registry_resolve',
      'context7_status',
      'context7_search_library',
      'context7_get_context',
      'context7_resolve_and_get_context',
      'write',
      'edit',
      'memory_search',
      'memory_get',
      'memory_add',
      'memory_update',
      'subagent_status',
    ]);
    writeConfiguredSubagent('tool-smoke', ['read', 'bash', 'skill_registry_resolve', 'context7_status', 'subagent_result']);

    const agents = loadSubagents(tmp);
    expect(agents.map((agent) => agent.name).sort()).toEqual(['discovery', 'prd-review', 'sdd-explore', 'tool-smoke']);
    const toolSmoke = agents.find((agent) => agent.name === 'tool-smoke');
    expect(toolSmoke?.tools).toEqual(['read', 'bash', 'skill_registry_resolve', 'context7_status']);
    const sddExplore = agents.find((agent) => agent.name === 'sdd-explore');
    expect(sddExplore?.tools).toEqual([
      'read',
      'bash',
      'skill_registry_resolve',
      'context7_status',
      'context7_search_library',
      'context7_get_context',
      'context7_resolve_and_get_context',
      'write',
      'edit',
      'memory_search',
      'memory_get',
      'memory_add',
      'memory_update',
    ]);
    for (const agent of agents) {
      if (agent.name.startsWith('sdd-') || agent.name === 'prd-review') {
        expect(agent.tools).toContain('memory_add');
        expect(agent.tools).toContain('memory_update');
        expect(agent.tools).not.toContain('memory_context');
        expect(agent.tools).not.toContain('memory_recall');
      } else {
        expect(agent.tools).not.toContain('memory_add');
        expect(agent.tools).not.toContain('memory_update');
      }
      expect(agent.tools.some((tool) => tool.startsWith('subagent_'))).toBe(false);
    }
  });

  it('keeps subagent debug logging disabled by default', () => {
    const logFile = path.join(tmp, '.pi', 'subagents-debug.log');
    expect(readSubagentsConfig(tmp).debug).toBe(false);
    expect(isSubagentsDebugEnabled(tmp)).toBe(false);
    writeSubagentsDebugLog(tmp, 'disabled_event', { ok: true });
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('keeps render diagnostics disabled by default and ignores malformed settings', () => {
    expect(readSubagentsConfig(tmp).render_debug).toBeUndefined();

    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ render_debug: { enabled: 'true', path: 42 } }));

    expect(readSubagentsConfig(tmp).render_debug).toBeUndefined();
  });

  it('parses render diagnostics config from snake_case and camelCase with project override merging', () => {
    const globalAgentDir = path.join(tmp, 'global-agent');
    const projectRoot = path.join(tmp, 'project-root');
    fs.mkdirSync(globalAgentDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(globalAgentDir, 'subagents.json'), JSON.stringify({ render_debug: { enabled: true, path: '/tmp/global-render.jsonl' } }));
    fs.writeFileSync(path.join(projectRoot, '.pi', 'subagents.json'), JSON.stringify({ renderDebug: { enabled: true, path: '/tmp/project-render.jsonl' } }));

    const config = withAgentDir(globalAgentDir, () => readSubagentsConfig(projectRoot));

    expect(config.render_debug).toEqual({ enabled: true, path: '/tmp/project-render.jsonl' });

    fs.writeFileSync(path.join(projectRoot, '.pi', 'subagents.json'), JSON.stringify({ renderDebug: { enabled: true } }));
    expect(withAgentDir(globalAgentDir, () => readSubagentsConfig(projectRoot)).render_debug).toEqual({ enabled: true, path: '/tmp/global-render.jsonl' });

    fs.writeFileSync(path.join(globalAgentDir, 'subagents.json'), JSON.stringify({ render_debug: { enabled: true } }));
    fs.rmSync(path.join(projectRoot, '.pi', 'subagents.json'));
    expect(withAgentDir(globalAgentDir, () => readSubagentsConfig(projectRoot)).render_debug).toEqual({ enabled: true, path: DEFAULT_RENDER_DEBUG_LOG_PATH });
  });

  it('lets project render diagnostics disable a globally enabled render logger', () => {
    const globalAgentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(globalAgentDir, { recursive: true });
    fs.writeFileSync(path.join(globalAgentDir, 'subagents.json'), JSON.stringify({ render_debug: { enabled: true, path: '/tmp/global-render.jsonl' } }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ render_debug: { enabled: false } }));

    const config = withAgentDir(globalAgentDir, () => readSubagentsConfig(tmp));

    expect(config.render_debug).toBeUndefined();
  });

  it('writes render diagnostics JSONL with allowlisted metadata and monotonic sequence only', () => {
    const logFile = path.join(tmp, 'render-debug.jsonl');
    const task: SubagentTask = {
      id: 'task-sensitive-123',
      agent: 'analyst',
      mode: 'task',
      status: 'running',
      task: 'SENTINEL_TASK_TEXT',
      prompt: 'SENTINEL_PROMPT_TEXT',
      result: 'SENTINEL_OUTPUT_TEXT',
      created_at: new Date().toISOString(),
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status', text: 'SENTINEL_RENDERED_LINE' }] },
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text, {}, () => 18);
    panel.render(72);

    const logger = createSubagentsRenderLogger({
      cwd: tmp,
      sessionId: 'session-sensitive-456',
      config: { enabled: true, path: logFile },
      env: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'ghostty',
        SECRET_TOKEN: 'SENTINEL_SECRET_TOKEN',
      } as NodeJS.ProcessEnv,
    });

    logger.log({ event: 'panel_created' });
    logger.log({ event: 'render_started', reason: 'initial', renderCycle: 1, dimensions: { stdoutColumns: 120, stdoutRows: 40, renderWidth: 72 } });
    logger.log({ event: 'render_completed', reason: 'initial', renderCycle: 1, durationMs: 2.5, dimensions: { stdoutColumns: 120, stdoutRows: 40, renderWidth: 72 }, state: panel.getRenderDebugState() });

    const records = readJsonl(logFile);
    const serialized = JSON.stringify(records);

    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(records.every((record) => record.panel_instance_id === records[0].panel_instance_id)).toBe(true);
    expect(records[1]).toMatchObject({ event: 'render_started', reason: 'initial', render_cycle: 1 });
    expect(records[2]).toMatchObject({ event: 'render_completed', reason: 'initial', render_cycle: 1 });
    expect(records[2].terminal).toEqual({ term: 'xterm-256color', colorterm: 'truecolor', term_program: 'ghostty', inside_tmux: false, inside_herdr: false });
    expect(records[2].state).toMatchObject({ task_count: 1, selected_index: 0, selected_status: 'running', has_usage: false });
    expect(records[2].session_id_hash).toMatch(/^sha256:/);
    expect(serialized).not.toContain('SENTINEL_TASK_TEXT');
    expect(serialized).not.toContain('SENTINEL_PROMPT_TEXT');
    expect(serialized).not.toContain('SENTINEL_OUTPUT_TEXT');
    expect(serialized).not.toContain('SENTINEL_RENDERED_LINE');
    expect(serialized).not.toContain('SENTINEL_SECRET_TOKEN');
    expect(serialized).not.toContain('task-sensitive-123');
    expect(serialized).not.toContain('session-sensitive-456');
  });

  it('swallows render diagnostics filesystem errors', () => {
    const logDir = path.join(tmp, 'render-debug-dir');
    fs.mkdirSync(logDir, { recursive: true });
    const logger = createSubagentsRenderLogger({ cwd: tmp, config: { enabled: true, path: logDir } });

    expect(() => logger.log({ event: 'panel_created' })).not.toThrow();
    expect(fs.readdirSync(logDir)).toHaveLength(0);
  });

  it('logs subagents panel lifecycle diagnostics without raw input or rendered text', async () => {
    vi.useFakeTimers();
    try {
      const logFile = path.join(tmp, 'subagents-panel-render.jsonl');
      fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ render_debug: { enabled: true, path: logFile } }));
      let subagentsCommand: any;
      const requestRender = vi.fn();
      extension({
        registerTool: () => undefined,
        registerCommand: (name: string, command: any) => { if (name === 'subagents') subagentsCommand = command; },
      });

      await subagentsCommand.handler('', {
        cwd: tmp,
        ui: {
          custom: async (factory: any) => {
            const component = factory(
              { terminal: { write: () => undefined }, requestRender },
              { fg: (_name: string, text: string) => text, bold: (text: string) => text },
              {},
              () => undefined,
            );
            component.render(90);
            vi.advanceTimersByTime(1000);
            component.render(90);
            component.handleInput('\u001b[B');
            component.render(90);
            component.handleInput('\u001b');
          },
        },
      });

      const records = readJsonl(logFile);
      const events = records.map((record) => record.event);
      const serialized = JSON.stringify(records);

      expect(events).toContain('panel_created');
      expect(events).toContain('render_requested');
      expect(events).toContain('render_started');
      expect(events).toContain('render_completed');
      expect(events).toContain('input_received');
      expect(events).toContain('panel_disposed');
      expect(records.filter((record) => record.event === 'render_requested').map((record) => record.reason)).toEqual(expect.arrayContaining(['initial', 'interval', 'input']));
      expect(records.filter((record) => record.event === 'input_received').map((record) => record.input)).toEqual([{ category: 'navigation', action: 'down' }, { category: 'lifecycle', action: 'close' }]);
      expect(records.filter((record) => record.event === 'render_completed').every((record) => typeof record.duration_ms === 'number' && record.duration_ms >= 0)).toBe(true);
      expect(serialized).not.toContain('\u001b[B');
      expect(serialized).not.toContain('No subagent tasks recorded in this session yet.');
      expect(serialized).not.toContain('session execution flow');
      expect(requestRender).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enables subagent debug logging from config and writes to the executing project .pi directory', () => {
    const globalAgentDir = path.join(tmp, 'global-agent');
    const projectRoot = path.join(tmp, 'project-root');
    fs.mkdirSync(path.join(globalAgentDir), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(globalAgentDir, 'subagents.json'), JSON.stringify({ debug: true }));
    const config = withAgentDir(globalAgentDir, () => readSubagentsConfig(projectRoot));
    expect(config.debug).toBe(true);
    expect(withAgentDir(globalAgentDir, () => isSubagentsDebugEnabled(projectRoot))).toBe(true);
    withAgentDir(globalAgentDir, () => writeSubagentsDebugLog(projectRoot, 'config_enabled_event', { ok: true }));
    expect(fs.readFileSync(path.join(projectRoot, '.pi', 'subagents-debug.log'), 'utf8')).toContain('config_enabled_event');
    expect(fs.existsSync(path.join(globalAgentDir, '.pi', 'subagents-debug.log'))).toBe(false);
  });

  it('lets project subagents debug config override global debug config', () => {
    const globalAgentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(globalAgentDir, { recursive: true });
    fs.writeFileSync(path.join(globalAgentDir, 'subagents.json'), JSON.stringify({ debug: true }));
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ debug: false }));

    const config = withAgentDir(globalAgentDir, () => readSubagentsConfig(tmp));

    expect(config.debug).toBe(false);
    expect(withAgentDir(globalAgentDir, () => isSubagentsDebugEnabled(tmp))).toBe(false);
  });

  it('adds the subagent debug log path to gitignore when debug logs are written inside a git repo', () => {
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ debug: true }));
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules\n');

    writeSubagentsDebugLog(tmp, 'gitignore_event', { ok: true });

    const gitignore = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules\n');
    expect(gitignore).toContain('.pi/subagents-debug.log\n');
    expect(gitignore.match(/\.pi\/subagents-debug\.log/g)).toHaveLength(1);
  });

  it('runs one subagent as task and exposes the active effort', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(mockRunner());
    const result = await manager.run({ agent: 'analyst', task: 'check scope', mode: 'task' }, { cwd: tmp, pi: { getThinkingLevel: () => 'high' } });
    expect(result.results?.[0].status).toBe('completed');
    expect(result.results?.[0].result).toContain('analyst handled check scope');
    expect(result.results?.[0].effort).toBe('high');
  });

  it('resolves task metadata before running and passes the same effective profile to the runner', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({
      model_profiles: { analyst: { model: 'profile/model', effort: 'xhigh' } },
    }));
    const seenUpdates: SubagentTask[][] = [];
    let runnerProfile: EffectiveSubagentProfile | undefined;
    const runner: SubagentRunner = async ({ effectiveProfile }) => {
      runnerProfile = effectiveProfile;
      return { result: 'profiled result', model: effectiveProfile?.model.label.replace(/^profile: /, ''), effort: effectiveProfile?.effort.value, fallback_used: false };
    };
    const manager = new SubagentManager(runner);

    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let result!: Awaited<ReturnType<SubagentManager['run']>>;
    try {
      result = await manager.run(
        { agent: 'analyst', task: 'profiled work', mode: 'task' },
        { cwd: tmp, model: { provider: 'orchestrator', id: 'model' }, thinkingLevel: 'low' },
        undefined,
        (tasks) => seenUpdates.push(tasks.map((task) => ({ ...task }))),
      );
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }

    const queued = seenUpdates.flat().find((task) => task.status === 'queued');
    expect(queued).toMatchObject({ model: 'profile/model', effort: 'xhigh', model_source: 'profile', effort_source: 'profile' });
    expect(runnerProfile).toMatchObject({
      agent: 'analyst',
      model: { value: { provider: 'profile', id: 'model' }, source: 'profile', label: 'profile: profile/model' },
      effort: { value: 'xhigh', source: 'profile', label: 'profile: xhigh' },
    });
    expect(result.results?.[0]).toMatchObject({ model: 'profile/model', effort: 'xhigh', model_source: 'profile', effort_source: 'profile' });
  });

  it('runs multiple subagents in one task call', async () => {
    writeAgent('analyst');
    writeAgent('reviewer');
    const manager = new SubagentManager(mockRunner());
    const result = await manager.run({ agents: ['analyst', 'reviewer'], task: 'review plan', mode: 'task' }, { cwd: tmp });
    expect(result.task_ids.length).toBe(2);
    expect(result.results?.map((r) => r.agent).sort()).toEqual(['analyst', 'reviewer']);
  });

  it('loads subagent markdown definitions only once per multi-agent run', async () => {
    writeAgent('a');
    writeAgent('b');
    writeAgent('c');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const manager = new SubagentManager(mockRunner());

    await manager.run({ agents: ['a', 'b', 'c'], task: 'single discovery pass', mode: 'task' }, { cwd: tmp });

    const markdownReads = readSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((file) => file.startsWith(path.join(tmp, '.pi', 'subagents')) && file.endsWith('.md'));
    expect(markdownReads).toHaveLength(3);
    readSpy.mockRestore();
  });

  it('enforces configured max concurrency within one run and across concurrent runs', async () => {
    writeAgent('a');
    writeAgent('b');
    writeAgent('c');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 1 }));
    let running = 0;
    let maxRunning = 0;
    const runner: SubagentRunner = async ({ definition }) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { result: `${definition.name} done`, model: 'mock/model', fallback_used: false };
    };
    const manager = new SubagentManager(runner);
    await Promise.all([
      manager.run({ agents: ['a', 'b'], task: 'limited one', mode: 'task' }, { cwd: tmp }),
      manager.run({ agent: 'c', task: 'limited two', mode: 'task' }, { cwd: tmp }),
    ]);
    expect(maxRunning).toBe(1);
  });

  it('derives manager error text compatibly and enriches structured failure metadata eagerly', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({
        message: 'streaming response',
        output: 'partial answer before failure',
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 14, turns: 1 },
      });
      throw new SubagentStructuredError(normalizeErrorMetadata({
        category: 'provider_rate_limit',
        message: 'provider said rate limit exceeded',
        retryable: true,
        phase: 'runner_invoke',
        partial_result_available: false,
      }));
    };
    const manager = new SubagentManager(runner);

    const result = await manager.run({ agent: 'analyst', task: 'structured failure', mode: 'task' }, { cwd: tmp, sessionId: 'parent-session-123' });

    expect(result.results?.[0].status).toBe('failed');
    expect(result.results?.[0].error).toBe('provider rate limit');
    expect(result.results?.[0].error_metadata).toMatchObject({
      version: 1,
      category: 'provider_rate_limit',
      retryable: true,
      usage_at_failure: { input: 10, output: 4, contextTokens: 14, turns: 1 },
      last_activity: 'streaming response',
      partial_result_available: true,
      parent_session_id: 'parent-session-123',
    });
    expect(result.results?.[0].error_metadata?.task_id).toBe(result.results?.[0].id);
    expect(result.results?.[0].error_metadata?.message).toBe('provider said rate limit exceeded');
  });

  it('classifies manager total timeout ownership compatibly and preserves structured metadata', async () => {
    writeAgent('analyst');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ timeout_ms: 20 }));
    const runner: SubagentRunner = async () => new Promise(() => {});
    const manager = new SubagentManager(runner);
    const result = await manager.run({ agent: 'analyst', task: 'timeout', mode: 'task' }, { cwd: tmp, sessionId: 'timeout-parent' });

    expect(result.results?.[0].status).toBe('failed');
    expect(result.results?.[0].error).toBe('timed out after 20ms');
    expect(result.results?.[0].error_metadata).toMatchObject({
      version: 1,
      category: 'total_timeout',
      phase: 'manager',
      retryable: false,
      partial_result_available: false,
      parent_session_id: 'timeout-parent',
      details: { timeout_ms: '20' },
    });
  });

  it('keeps exact-string compatibility for plain and malformed legacy manager failures while attaching metadata', async () => {
    writeAgent('analyst');
    const plainManager = new SubagentManager(async () => { throw new Error('legacy plain failure'); });
    const malformedManager = new SubagentManager(async () => { throw { reason: 'legacy malformed failure' }; });

    const plain = await plainManager.run({ agent: 'analyst', task: 'plain fail', mode: 'task' }, { cwd: tmp });
    const malformed = await malformedManager.run({ agent: 'analyst', task: 'malformed fail', mode: 'task' }, { cwd: tmp });

    expect(plain.results?.[0].error).toBe('legacy plain failure');
    expect(plain.results?.[0].error_metadata).toMatchObject({ category: 'provider_api_error', message: 'legacy plain failure' });
    expect(malformed.results?.[0].error).toBe('[object Object]');
    expect(malformed.results?.[0].error_metadata).toMatchObject({ category: 'malformed_thrown_value', message: '[object Object]' });
  });

  it('marks tasks failed when a runner returns no final response text', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({ message: 'collected final response', output: '{"path":"not-a-final-answer.md"}' });
      return { result: '', model: 'mock/model', fallback_used: false };
    };
    const manager = new SubagentManager(runner);

    const result = await manager.run({ agent: 'analyst', task: 'empty final response', mode: 'task' }, { cwd: tmp });

    expect(result.results?.[0].status).toBe('failed');
    expect(result.results?.[0].error).toMatch(/final response/i);
    expect(result.results?.[0].result).toBeUndefined();
    expect(result.results?.[0].output_preview).toContain('not-a-final-answer');
  });

  it('starts background tasks and keeps notification compact while completion message carries full response', async () => {
    writeAgent('analyst');
    const notifications: string[] = [];
    const manager = new SubagentManager(mockRunner(20));
    const result = await manager.run({ agent: 'analyst', task: 'background work', mode: 'background' }, { cwd: tmp, ui: { notify: (msg: string) => notifications.push(msg) } });
    expect(result.results).toBeUndefined();
    const id = result.task_ids[0];
    expect(manager.getTask(id)?.status).toMatch(/queued|running/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const completed = manager.getTask(id);
    expect(completed?.status).toBe('completed');
    expect(notifications.some((n) => n.includes('completed'))).toBe(true);
    const message = completionMessage(completed);
    expect(message).toContain('Read only this final response');
    expect(message).toContain('analyst handled background work');
  });

  it('can move a running task-mode subagent to background and notify on completion', async () => {
    writeAgent('analyst');
    const notifications: string[] = [];
    const manager = new SubagentManager(mockRunner(20));
    const runPromise = manager.run({ agent: 'analyst', task: 'task work', mode: 'task' }, { cwd: tmp, ui: { notify: (msg: string) => notifications.push(msg) } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const running = manager.listTasks(tmp).find((task) => task.task === 'task work');
    expect(running?.mode).toBe('task');

    const backgrounded = manager.sendToBackground([running!.id]);
    expect(backgrounded.map((task) => task.id)).toEqual([running!.id]);
    expect(manager.getTask(running!.id)?.mode).toBe('background');

    const result = await runPromise;
    expect(result.results?.[0]?.status).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(notifications.some((n) => n.includes('completed'))).toBe(true);
  });

  it('records manager cancel metadata and avoids double terminal records for explicit user cancellation', async () => {
    writeAgent('analyst');
    const persisted: Array<{ status: string; error?: string }> = [];
    const history = {
      upsertTask(_cwd: string, task: SubagentTask) { persisted.push({ status: task.status, error: task.error }); },
      addEvent() {},
      listTasks() { return []; },
      listSessionTasks() { return []; },
      getTask() { return undefined; },
    };
    const runner: SubagentRunner = async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Subagent was aborted')), { once: true });
    });
    const manager = new SubagentManager(runner, history as any);
    const result = await manager.run({ agent: 'analyst', task: 'slow work', mode: 'background' }, { cwd: tmp, sessionId: 'cancel-parent' });
    const task = manager.cancel(result.task_ids[0], 'user request');

    expect(task.status).toBe('cancelled');
    expect(task.error).toBe('Subagent cancelled: user request');
    expect(task.error_metadata).toMatchObject({
      version: 1,
      category: 'cancelled',
      phase: 'user',
      partial_result_available: false,
      parent_session_id: 'cancel-parent',
      details: { cancel_reason: 'user request' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(persisted.filter((entry) => entry.status === 'cancelled')).toHaveLength(1);
    expect(persisted.filter((entry) => entry.status === 'failed')).toHaveLength(0);
  });

  it('records manager cancel metadata for parent abort with compatible wording', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Subagent was aborted')), { once: true });
    });
    const manager = new SubagentManager(runner);
    const controller = new AbortController();
    const runPromise = manager.run({ agent: 'analyst', task: 'slow work', mode: 'background' }, { cwd: tmp, sessionId: 'parent-session-456' }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await runPromise;
    const task = manager.getTask(result.task_ids[0]);

    expect(task?.status).toBe('cancelled');
    expect(task?.error).toBe('Subagent cancelled: parent abort');
    expect(task?.error_metadata).toMatchObject({
      version: 1,
      category: 'cancelled',
      phase: 'manager',
      parent_session_id: 'parent-session-456',
      details: { cancel_reason: 'parent abort' },
    });
  });

  it('cleans up queued cancellations and lets later tasks run', async () => {
    writeAgent('a');
    writeAgent('b');
    writeAgent('c');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 1 }));
    const manager = new SubagentManager(mockRunner(30));
    const result = await manager.run({ agents: ['a', 'b', 'c'], task: 'queue', mode: 'background' }, { cwd: tmp });
    const cancelled = manager.cancel(result.task_ids[1]);
    expect(cancelled.status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(manager.getTask(result.task_ids[0])?.status).toBe('completed');
    expect(manager.getTask(result.task_ids[2])?.status).toBe('completed');
  });

  it('throttles noisy activity persistence and update notifications while always flushing terminal state', async () => {
    vi.useFakeTimers();
    writeAgent('analyst');
    const persisted: Array<{ task: SubagentTask; activity: string }> = [];
    const events: Array<{ task: SubagentTask; activity: string }> = [];
    const history = {
      upsertTask(_cwd: string, task: SubagentTask) { persisted.push({ task: { ...task }, activity: task.last_activity ?? '' }); },
      addEvent(_cwd: string, task: SubagentTask, activity: string) { events.push({ task: { ...task }, activity }); },
      listTasks() { return []; },
      listSessionTasks() { return []; },
      getTask() { return undefined; },
    };
    const runner: SubagentRunner = async ({ onActivity }) => {
      for (let index = 0; index < 20; index += 1) onActivity?.({ message: 'streaming response', output: `chunk ${index}` });
      return { result: 'final review', model: 'mock/model', fallback_used: false };
    };
    const updates: SubagentTask[][] = [];
    const manager = new SubagentManager(runner, history as any);

    const resultPromise = manager.run({ agent: 'analyst', task: 'inspect', mode: 'task' }, { cwd: tmp }, undefined, (tasks) => updates.push(tasks.map((task) => ({ ...task }))));
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.results?.[0].status).toBe('completed');
    expect(events.map((entry) => entry.activity)).toContain('queued');
    expect(events.map((entry) => entry.activity)).toContain('started');
    expect(events.map((entry) => entry.activity)).toContain('completed');
    expect(events.length).toBeLessThan(10);
    expect(updates.length).toBeLessThan(10);
    expect(persisted.at(-1)?.task).toMatchObject({ status: 'completed', result: 'final review', output_preview: 'final review' });
  });

  it('tracks latest activity and partial output while running', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({ message: 'reading docs' });
      onActivity?.({ message: 'streaming response', output: 'found current architecture notes' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { result: 'final review', model: 'mock/model', fallback_used: false };
    };
    const manager = new SubagentManager(runner);
    const result = await manager.run({ agent: 'analyst', task: 'inspect', mode: 'background' }, { cwd: tmp });
    const running = manager.getTask(result.task_ids[0]);
    expect(running?.last_activity).toBe('streaming response');
    expect(running?.output_preview).toContain('architecture notes');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const completed = manager.getTask(result.task_ids[0]);
    expect(completed?.last_activity).toBe('completed');
    expect(completed?.output_preview).toBe('final review');
  });

  it('persists subagent system prompts separately from delegated user prompts', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_system_prompt_history',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'ping',
      prompt: '## delegated task\nping',
      system_prompt: '# Analyst\nSYSTEM_ONLY',
      created_at: new Date().toISOString(),
      result: 'pong',
    } as any;

    history.upsertTask(tmp, task);
    const persisted = history.getTask(tmp, task.id);

    expect(persisted?.prompt).toBe('## delegated task\nping');
    expect(persisted?.system_prompt).toBe('# Analyst\nSYSTEM_ONLY');
    expect(persisted?.prompt).not.toContain('SYSTEM_ONLY');
  });

  it('persists nullable structured error metadata and category across history reopen', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_error_metadata_history',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'persist structured failure',
      created_at: new Date().toISOString(),
      error: 'Subagent cancelled: user request',
      error_metadata: normalizeErrorMetadata({
        category: 'cancelled',
        message: 'Subagent cancelled: user request',
        partial_result_available: false,
        details: { cancel_reason: 'user request', raw_payload: 'Authorization: Bearer sk-fake-secret-token' },
      }),
    } as any;

    history.upsertTask(tmp, task);

    const { DatabaseSync } = require('node:sqlite') as any;
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    const columns = db.prepare('PRAGMA table_info(subagent_tasks)').all() as Array<{ name: string; notnull: number }>;
    expect(columns.find((column) => column.name === 'error_metadata_json')?.notnull).toBe(0);
    expect(columns.find((column) => column.name === 'error_category')?.notnull).toBe(0);

    const row = db.prepare('SELECT error, error_metadata_json, error_category FROM subagent_tasks WHERE id = ?').all(task.id)[0] as any;
    expect(row.error).toBe('Subagent cancelled: user request');
    expect(row.error_category).toBe('cancelled');
    expect(row.error_metadata_json).toContain('cancelled');
    expect(row.error_metadata_json).not.toContain('sk-fake-secret-token');

    const reopened = new SubagentHistoryStore().getTask(tmp, task.id);
    expect(reopened?.error).toBe('Subagent cancelled: user request');
    expect(reopened?.error_metadata?.category).toBe('cancelled');
    expect(reopened?.error_metadata?.details?.raw_payload).toContain('[redacted]');
  });

  it('adds nullable error columns idempotently without backfilling legacy rows and preserves exact legacy error strings', () => {
    const { DatabaseSync } = require('node:sqlite') as any;
    fs.mkdirSync(path.dirname(resolveSubagentHistoryDbPath()), { recursive: true });
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_tasks (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        agent TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL,
        session_id TEXT,
        started_at TEXT,
        ended_at TEXT,
        last_activity_at TEXT,
        last_activity TEXT,
        output_preview TEXT,
        prompt TEXT,
        system_prompt TEXT,
        transcript TEXT,
        usage_input INTEGER,
        usage_output INTEGER,
        usage_cache_read INTEGER,
        usage_cache_write INTEGER,
        usage_cost REAL,
        usage_context_tokens INTEGER,
        usage_turns INTEGER,
        model TEXT,
        effort TEXT,
        model_source TEXT,
        effort_source TEXT,
        fallback_used INTEGER,
        error TEXT,
        result TEXT,
        thread_snapshot_json TEXT
      );
    `);
    db.prepare(`
      INSERT INTO subagent_tasks (
        id, cwd, agent, mode, status, task, created_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'subtask_legacy_error_only',
      tmp,
      'analyst',
      'task',
      'failed',
      'legacy history row',
      new Date().toISOString(),
      'legacy plain error  with  exact   spacing',
    );

    const reopenedStore = new SubagentHistoryStore();
    const legacy = reopenedStore.getTask(tmp, 'subtask_legacy_error_only');
    expect(legacy?.error).toBe('legacy plain error  with  exact   spacing');
    expect(legacy?.error_metadata).toBeUndefined();

    const migratedColumns = db.prepare('PRAGMA table_info(subagent_tasks)').all() as Array<{ name: string; notnull: number }>;
    expect(migratedColumns.find((column) => column.name === 'error_metadata_json')?.notnull).toBe(0);
    expect(migratedColumns.find((column) => column.name === 'error_category')?.notnull).toBe(0);

    const row = db.prepare('SELECT error_metadata_json, error_category FROM subagent_tasks WHERE id = ?').all('subtask_legacy_error_only')[0] as any;
    expect(row.error_metadata_json).toBeNull();
    expect(row.error_category).toBeNull();

    reopenedStore.upsertTask(tmp, {
      id: 'subtask_no_error_metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'no metadata needed',
      created_at: new Date().toISOString(),
      result: 'ok',
    } as any);
    const currentRow = db.prepare('SELECT error_metadata_json, error_category FROM subagent_tasks WHERE id = ?').all('subtask_no_error_metadata')[0] as any;
    expect(currentRow.error_metadata_json).toBeNull();
    expect(currentRow.error_category).toBeNull();
  });

  it('ignores malformed persisted error metadata json safely while preserving legacy error text', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_malformed_error_metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'malformed metadata row',
      created_at: new Date().toISOString(),
      error: 'legacy malformed metadata error',
    } as any;
    history.upsertTask(tmp, task);

    const { DatabaseSync } = require('node:sqlite') as any;
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    db.prepare('UPDATE subagent_tasks SET error_metadata_json = ?, error_category = ? WHERE id = ?').run('{bad json', 'provider_api_error', task.id);

    const loaded = history.getTask(tmp, task.id);
    expect(loaded?.error).toBe('legacy malformed metadata error');
    expect(loaded?.error_metadata).toBeUndefined();
  });

  it('never lets error metadata serialization failure escape history upsertTask', () => {
    const history = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_unserializable_error_metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'unserializable metadata',
      created_at: new Date().toISOString(),
      error: 'legacy serialization-safe error',
      error_metadata: {
        category: 'provider_api_error',
        message: 'should fail closed',
        partial_result_available: false,
        details: { broken: 1n as any },
      } as any,
    } as any;

    expect(() => history.upsertTask(tmp, task)).not.toThrow();
    const persisted = history.getTask(tmp, task.id);
    expect(persisted?.error).toBe('legacy serialization-safe error');
    expect(persisted?.error_metadata?.category).toBe('serialization_failure');
    expect(deriveErrorString(persisted?.error_metadata!)).toBe('Subagent error metadata could not be serialized safely.');
  });

  it('keeps current-session listing available when sqlite history is temporarily busy', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
    const history = {
      listSessionTasks: vi.fn()
        .mockReturnValueOnce([{ id: 'persisted_cached', agent: 'analyst', mode: 'task', status: 'completed', task: 'cached', created_at: '2026-01-01T00:00:00.000Z', session_id: 'session-current' }])
        .mockImplementationOnce(() => { throw busy; }),
      listTasks() { return []; },
      getTask() { return undefined; },
      upsertTask() {},
      addEvent() {},
    };
    const manager = new SubagentManager(mockRunner(), history as any);

    vi.useFakeTimers();
    try {
      expect(manager.listSessionTasks(tmp, 'session-current').map((task) => task.id)).toEqual(['persisted_cached']);
      vi.advanceTimersByTime(1600);
      let lockedResult: SubagentTask[] = [];
      expect(() => { lockedResult = manager.listSessionTasks(tmp, 'session-current'); }).not.toThrow();
      expect(lockedResult.map((task) => task.id)).toEqual(['persisted_cached']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists persisted current-session tasks after manager reload while excluding other sessions', () => {
    const history = new SubagentHistoryStore();
    const sessionTask: SubagentTask = {
      id: 'subtask_session_current',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'current session task',
      created_at: new Date().toISOString(),
      session_id: 'session-current',
      result: 'current result',
    } as any;
    const otherTask: SubagentTask = {
      ...sessionTask,
      id: 'subtask_session_other',
      task: 'other session task',
      session_id: 'session-other',
    } as any;
    history.upsertTask(tmp, sessionTask);
    history.upsertTask(tmp, otherTask);

    const manager = new SubagentManager(mockRunner(), history);
    const listed = manager.listSessionTasks(tmp, 'session-current');

    expect(listed.map((task) => task.id)).toContain('subtask_session_current');
    expect(listed.map((task) => task.id)).not.toContain('subtask_session_other');
  });

  it('resolves sqlite history under global data storage like memory, not the project .pi directory', () => {
    expect(resolveSubagentsHistoryHome({ XDG_DATA_HOME: '/xdg' } as any)).toBe(path.join('/xdg', 'pi', 'subagents'));
    expect(resolveSubagentHistoryDbPath({ XDG_DATA_HOME: '/xdg' } as any)).toBe(path.join('/xdg', 'pi', 'subagents', 'subagents-history.sqlite'));
    expect(resolveSubagentHistoryDbPath({ PI_SUBAGENTS_HISTORY_DB_PATH: '/custom/history.sqlite' } as any)).toBe('/custom/history.sqlite');
    expect(resolveSubagentsHistoryHome({ PI_SUBAGENTS_HISTORY_HOME: '/custom/home' } as any)).toBe('/custom/home');

    const store = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_global_history_1',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'global history location',
      created_at: new Date().toISOString(),
      result: 'stored globally',
    } as any;

    store.upsertTask(tmp, task);

    expect(resolveSubagentHistoryDbPath()).toBe(path.join(tmp, 'global-agent', 'subagents-history.sqlite'));
    expect(fs.existsSync(path.join(tmp, 'global-agent', 'subagents-history.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.pi', 'subagents-history.sqlite'))).toBe(false);
    expect(store.getTask(tmp, task.id)?.result).toBe('stored globally');
  });

  it('retrieves completed tasks from sqlite history when not in memory', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(mockRunner());
    const result = await manager.run({ agent: 'analyst', task: 'persisted work', mode: 'task' }, { cwd: tmp });
    const id = result.task_ids[0];
    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(id, tmp);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.result).toContain('analyst handled persisted work');
    expect(freshManager.listSessionTasks(tmp)).toEqual([]);
  });

  it('copies activity and final thread snapshots onto tasks and persists final snapshots through history reload', async () => {
    writeAgent('analyst');
    const activitySnapshot = statusSnapshot('activity snapshot from runner');
    const finalSnapshot = statusSnapshot('final snapshot from runner');
    const seenUpdates: SubagentTask[][] = [];
    const runner: SubagentRunner = async ({ onActivity }) => {
      onActivity?.({ message: 'snapshot activity', thread_snapshot: activitySnapshot });
      return { result: 'snapshot result', model: 'mock/model', fallback_used: false, thread_snapshot: finalSnapshot };
    };
    const manager = new SubagentManager(runner);

    const result = await manager.run(
      { agent: 'analyst', task: 'persist snapshots', mode: 'task' },
      { cwd: tmp },
      undefined,
      (tasks) => seenUpdates.push(tasks.map((task) => ({ ...task }))),
    );

    expect(seenUpdates.flat().some((task) => task.thread_snapshot?.items[0]?.type === 'status' && task.thread_snapshot.items[0].text === 'activity snapshot from runner')).toBe(true);
    expect(result.results?.[0].thread_snapshot).toEqual(finalSnapshot);

    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(result.task_ids[0], tmp);
    expect(persisted?.thread_snapshot).toEqual(finalSnapshot);
  });

  it('can list session history without parsing thread snapshots and hydrate them on demand', () => {
    const store = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_lazy_history_1',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'lazy history snapshot',
      created_at: new Date().toISOString(),
      session_id: 'session-lazy',
      thread_snapshot: statusSnapshot('lazy snapshot body'),
    } as any;
    store.upsertTask(tmp, task);

    const listed = store.listSessionTasks(tmp, 'session-lazy', 100, { includeSnapshots: false });
    expect(listed).toHaveLength(1);
    expect(listed[0].thread_snapshot).toBeUndefined();

    const hydrated = store.getTask(tmp, task.id);
    expect(hydrated?.thread_snapshot).toEqual(statusSnapshot('lazy snapshot body'));
  });

  it('persists only bounded valid thread snapshots and ignores corrupt history snapshot JSON', () => {
    const store = new SubagentHistoryStore();
    const task: SubagentTask = {
      id: 'subtask_history_snapshot_1',
      agent: 'analyst',
      mode: 'task',
      status: 'completed',
      task: 'history snapshot',
      created_at: new Date().toISOString(),
      transcript: 'legacy transcript survives corrupt snapshots',
      result: 'legacy result survives corrupt snapshots',
      thread_snapshot: statusSnapshot('x'.repeat(5000)),
    };

    store.upsertTask(tmp, task);
    const bounded = store.getTask(tmp, task.id)?.thread_snapshot;
    expect(bounded?.items[0]).toMatchObject({ type: 'status', text: expect.stringMatching(/…$/) });
    expect((bounded?.items[0] as any).text.length).toBeLessThanOrEqual(4000);

    const { DatabaseSync } = require('node:sqlite') as any;
    const db = new DatabaseSync(resolveSubagentHistoryDbPath());
    // Old history data may be deleted/reset; v1 deliberately does not migrate flat transcripts into snapshots.
    db.prepare('UPDATE subagent_tasks SET thread_snapshot_json = ? WHERE id = ?').run('{not valid json', task.id);
    const corruptLoaded = store.getTask(tmp, task.id);
    expect(corruptLoaded?.thread_snapshot).toBeUndefined();
    expect(corruptLoaded?.transcript).toContain('legacy transcript survives corrupt snapshots');

    db.prepare('UPDATE subagent_tasks SET thread_snapshot_json = ? WHERE id = ?').run(JSON.stringify({ version: 1, source: 'events', items: [{ type: 'future', text: 'ignored' }] }), task.id);
    const invalidLoaded = store.getTask(tmp, task.id);
    expect(invalidLoaded?.thread_snapshot).toBeUndefined();
    expect(invalidLoaded?.result).toContain('legacy result survives corrupt snapshots');
  });

  it('persists subagent usage stats and effort for display', async () => {
    writeAgent('analyst');
    const runner: SubagentRunner = async () => ({
      result: 'usage-aware result',
      model: 'mock/model',
      effort: 'xhigh',
      fallback_used: false,
      usage: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 5, cost: 0.01, contextTokens: 1545, turns: 1 },
    });
    const manager = new SubagentManager(runner);
    const result = await manager.run({ agent: 'analyst', task: 'measure usage', mode: 'task' }, { cwd: tmp });
    const id = result.task_ids[0];
    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(id, tmp);
    expect(persisted?.usage).toEqual({ input: 1200, output: 300, cacheRead: 40, cacheWrite: 5, cost: 0.01, contextTokens: 1545, turns: 1 });
    expect(persisted?.effort).toBe('xhigh');
  });

  it('persists effective model and effort source metadata for rendering', async () => {
    writeAgent('analyst');
    const agentDir = path.join(tmp, 'global-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ model_profiles: { analyst: { effort: 'high' } } }));
    const manager = new SubagentManager(async ({ effectiveProfile }) => ({
      result: 'source-aware result',
      model: effectiveProfile?.model.label.replace(/^orchestrator: /, ''),
      effort: effectiveProfile?.effort.value,
      fallback_used: false,
    }));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let result!: Awaited<ReturnType<SubagentManager['run']>>;
    try {
      result = await manager.run({ agent: 'analyst', task: 'source metadata', mode: 'task' }, { cwd: tmp, model: { provider: 'mock', id: 'model' } });
    } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    }
    const freshManager = new SubagentManager(mockRunner());
    const persisted = freshManager.getTask(result.task_ids[0], tmp);
    expect(persisted).toMatchObject({ model: 'mock/model', effort: 'high', model_source: 'orchestrator', effort_source: 'profile' });
  });

  it('renders agent, model, and effort as explicit labels in tool results', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(async () => ({ result: 'clear render', model: 'mock/model', effort: 'high', fallback_used: false }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const result = await runTool.execute('1', { agent: 'analyst', task: 'render clearly', mode: 'task' }, undefined, undefined, { cwd: tmp });
    const rendered = runTool.renderResult(result, { isPartial: false }, { fg: (_name: string, text: string) => text }).render(200).join('\n');
    expect(rendered).toContain('agent: analyst');
    expect(rendered).toContain('model: mock/model');
    expect(rendered).toContain('effort: high');
  });

  it('tells the agent to free the chat and wait for automatic notification after background launch', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(mockRunner(50));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'background instructions', mode: 'background' }, undefined, undefined, { cwd: tmp });
    const text = result.content[0].text;

    expect(text).toContain('Sent 1 subagent task(s) to background');
    expect(text).toContain('Do not call subagent_status or subagent_result just to wait');
    expect(text).toContain('The subagent will notify this chat automatically when it finishes');
    expect(text).toContain('Keep the chat available so the user can continue asking questions');
    expect(result.terminate).not.toBe(true);
  });

  it('returns a background handoff result when ctrl+h shortcut is triggered in claude task mode', async () => {
    writeAgent('analyst');
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    const manager = new SubagentManager(mockRunner(50));
    let runTool: any;
    let shortcutHandler: ((ctx: any) => any) | undefined;
    const notifications: string[] = [];
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    extension({
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerShortcut: (key: string, shortcut: any) => {
        if (key === 'ctrl+h') shortcutHandler = shortcut.handler;
      },
    });

    const resultPromise = runTool.execute(
      '1',
      { agent: 'analyst', task: 'render clearly', mode: 'task' },
      undefined,
      undefined,
      {
        cwd: tmp,
        ui: {
          onTerminalInput: () => () => undefined,
          notify: (message: string) => { notifications.push(message); },
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    await shortcutHandler?.({ cwd: tmp, ui: { notify: (message: string) => { notifications.push(message); } } });

    const result = await resultPromise;
    const text = result.content[0].text;
    expect(result.isError).not.toBe(true);
    expect(result.terminate).toBe(true);
    expect(notifications.some((message) => message.includes('Sent subagent to background:'))).toBe(true);
    expect(text).toContain('Sent 1 subagent task(s) to background');
    const taskId = text.match(/subtask_[^\n]+/)?.[0]!;
    expect(manager.getTask(taskId, tmp)?.mode).toBe('background');
  });

  it('renders a dim ctrl+, and command hint in the subagent_run title outside claude mode', () => {
    const manager = new SubagentManager(mockRunner());
    let runTool: any;
    const dim = vi.fn((_name: string, text: string) => text);
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const rendered = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');

    expect(rendered).toContain('subagent analyst (task)');
    expect(rendered).toContain('(ctrl+, or /subagents for details)');
    expect(dim).toHaveBeenCalledWith('dim', '(ctrl+, or /subagents for details)');
  });

  it('hides ctrl+, from the subagent_run title in claude mode', () => {
    fs.writeFileSync(path.join(tmp, '.pi', 'subagents.json'), JSON.stringify({ mode: 'claude' }));
    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      const manager = new SubagentManager(mockRunner());
      let runTool: any;
      const dim = vi.fn((_name: string, text: string) => text);
      registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

      const rendered = runTool.renderCall({ agent: 'analyst', mode: 'task' }, { fg: dim, bold: (text: string) => text }).render(200).join('\n');

      expect(rendered).toContain('subagent analyst (task)');
      expect(rendered).toContain('(/subagents for details)');
      expect(rendered).not.toContain('ctrl+,');
      expect(dim).toHaveBeenCalledWith('dim', '(/subagents for details)');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('keeps ansi-styled subagent_run title hints visible when visual width fits', () => {
    const manager = new SubagentManager(mockRunner());
    let runTool: any;
    const theme = {
      fg: (_name: string, text: string) => `\u001b[36m${text}\u001b[39m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    };
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const rendered = runTool.renderCall({ agent: 'discovery', mode: 'task' }, theme).render(80).join('\n');
    const plain = stripAnsi(rendered);

    expect(plain).toContain('subagent discovery (task)');
    expect(plain).toContain('(ctrl+, or /subagents for details)');
    expect(plain).not.toContain('�');
  });

  it('renders a ctrl+h background hint in partial claude task-mode results', () => {
    const manager = new SubagentManager(mockRunner());
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const rendered = runTool.renderResult({ details: { frame: 0, backgroundable: true, tasks: [{ agent: 'analyst', status: 'running', effort: 'high', model: 'mock/model', last_activity: 'working' }] } }, { isPartial: true }, { fg: (_name: string, text: string) => text }).render(200).join('\n');

    expect(rendered).toContain('ctrl+h to send to background');
  });

  it('keeps subagent_run command results compact when tasks include large thread snapshots', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(async () => ({
      result: 'compact result',
      model: 'mock/model',
      fallback_used: false,
      thread_snapshot: statusSnapshot('oversized snapshot text '.repeat(400)),
    }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'compact snapshots', mode: 'task' }, undefined, undefined, { cwd: tmp });
    const serialized = JSON.stringify(result);

    expect(result.content[0].text).toContain('Completed 1 subagent task');
    expect(serialized).not.toContain('thread_snapshot');
    expect(serialized).not.toContain('oversized snapshot text oversized snapshot text oversized snapshot text');
  });

  it('exposes only safe structured error summaries in subagent_run/status/result details while preserving legacy error text', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(async () => {
      throw new SubagentStructuredError(normalizeErrorMetadata({
        category: 'provider_api_error',
        message: 'Authorization: Bearer sk-fake-secret-token fake.user@example.com /tmp/fake-private.txt',
        partial_result_available: false,
        details: {
          provider_code: '429',
          auth_header: 'Authorization: Bearer sk-fake-secret-token',
          prompt: 'SYSTEM: hidden prompt body',
          file_path: '/tmp/fake-private.txt',
          nested_payload: JSON.stringify({ transcript: 'SECRET_FILE_BODY_DO_NOT_SHOW' }),
        },
        last_activity: 'USER: hidden prompt body /tmp/fake-private.txt',
      }));
    });
    let runTool: any;
    let statusTool: any;
    let resultTool: any;
    registerSubagentTools({ registerTool: (tool: any) => {
      if (tool.name === 'subagent_run') runTool = tool;
      if (tool.name === 'subagent_status') statusTool = tool;
      if (tool.name === 'subagent_result') resultTool = tool;
    } }, manager);

    const runResult = await runTool.execute('1', { agent: 'analyst', task: 'structured failure', mode: 'task' }, undefined, undefined, { cwd: tmp });
    const taskId = runResult.details.results[0].id;
    const statusResult = await statusTool.execute('2', { task_id: taskId }, undefined, undefined, { cwd: tmp });
    const resultResult = await resultTool.execute('3', { task_id: taskId }, undefined, undefined, { cwd: tmp });

    expect(runResult.isError).toBe(true);
    expect(runResult.details.results[0].error).toBe('provider api error');
    expect(statusResult.details.task.error).toBe('provider api error');
    expect(resultResult.content[0].text).toBe('provider api error');
    expect(resultResult.details.task.error).toBe('provider api error');

    for (const task of [runResult.details.results[0], statusResult.details.task, resultResult.details.task]) {
      expect(task.error_metadata).toMatchObject({
        version: 1,
        category: 'provider_api_error',
        retryable: true,
        code: 'provider_api_error',
        partial_result_available: false,
        details: { provider_code: '429' },
      });
      expect(task.error_metadata.message).toBeUndefined();
      expect(task.error_metadata.last_activity).toBeUndefined();
      expect(task.error_metadata.usage_at_failure).toBeUndefined();
      expect(task.error_metadata.task_id).toBeUndefined();
      expect(task.error_metadata.parent_session_id).toBeUndefined();
      expect(task.error_metadata.attempts).toBeUndefined();
      expect(task.error_metadata.cause).toBeUndefined();
      const serialized = JSON.stringify(task.error_metadata);
      expect(serialized).not.toContain('sk-fake-secret-token');
      expect(serialized).not.toContain('fake.user@example.com');
      expect(serialized).not.toContain('/tmp/fake-private.txt');
      expect(serialized).not.toContain('hidden prompt body');
      expect(serialized).not.toContain('SECRET_FILE_BODY_DO_NOT_SHOW');
    }
  });

  it('fails closed when compact tool details encounter malformed error metadata payloads', async () => {
    const circular: any = { category: 'provider_api_error', message: 'unsafe raw payload' };
    circular.details = { circular };
    const task: any = {
      id: 'subtask_malformed_tool_error_metadata',
      agent: 'analyst',
      mode: 'task',
      status: 'failed',
      task: 'broken metadata',
      created_at: new Date().toISOString(),
      error: 'provider api error',
      error_metadata: circular,
    };
    const manager: any = {
      getTask: () => task,
    };
    let statusTool: any;
    let resultTool: any;
    registerSubagentTools({ registerTool: (tool: any) => {
      if (tool.name === 'subagent_status') statusTool = tool;
      if (tool.name === 'subagent_result') resultTool = tool;
    } }, manager);

    const statusResult = await statusTool.execute('1', { task_id: task.id }, undefined, undefined, { cwd: tmp });
    const resultResult = await resultTool.execute('2', { task_id: task.id }, undefined, undefined, { cwd: tmp });

    expect(() => JSON.stringify(statusResult)).not.toThrow();
    expect(() => JSON.stringify(resultResult)).not.toThrow();
    expect(statusResult.details.task.error).toBe('provider api error');
    expect(resultResult.details.task.error).toBe('provider api error');
    expect(statusResult.details.task.error_metadata).toMatchObject({ category: 'serialization_failure', version: 1 });
    expect(resultResult.details.task.error_metadata).toMatchObject({ category: 'serialization_failure', version: 1 });
  });

  it('includes only bounded structured error summaries in background completion details', () => {
    const sendMessage = vi.fn();
    const task = {
      id: 'subtask_background_failure',
      agent: 'analyst',
      status: 'failed',
      mode: 'background',
      error: 'provider api error',
      model: 'mock/model',
      effort: 'high',
      error_metadata: {
        category: 'provider_api_error',
        message: 'Authorization: Bearer sk-fake-secret-token fake.user@example.com /tmp/fake-private.txt',
        partial_result_available: true,
        details: {
          provider_code: '429',
          auth_header: 'Authorization: Bearer sk-fake-secret-token',
          prompt: 'SYSTEM: hidden prompt body',
          file_path: '/tmp/fake-private.txt',
          nested_payload: JSON.stringify({ transcript: 'SECRET_FILE_BODY_DO_NOT_SHOW' }),
        },
        last_activity: 'USER: hidden prompt body /tmp/fake-private.txt',
        usage_at_failure: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5, contextTokens: 6, turns: 7 },
        task_id: 'subtask_background_failure',
        parent_session_id: 'parent-session-secret',
      },
    };

    sendSubagentCompletionMessage({ sendMessage }, task);

    const payload = sendMessage.mock.calls[0][0];
    expect(payload.details.full_result).toBe('provider api error');
    expect(payload.details.task.error).toBe('provider api error');
    expect(payload.details.task.error_metadata).toMatchObject({
      version: 1,
      category: 'provider_api_error',
      retryable: true,
      code: 'provider_api_error',
      partial_result_available: true,
      details: { provider_code: '429' },
    });
    expect(payload.details.task.error_metadata.message).toBeUndefined();
    expect(payload.details.task.error_metadata.last_activity).toBeUndefined();
    expect(payload.details.task.error_metadata.usage_at_failure).toBeUndefined();
    expect(payload.details.task.error_metadata.task_id).toBeUndefined();
    expect(payload.details.task.error_metadata.parent_session_id).toBeUndefined();
    const serialized = JSON.stringify(payload.details.task.error_metadata);
    expect(serialized).not.toContain('sk-fake-secret-token');
    expect(serialized).not.toContain('fake.user@example.com');
    expect(serialized).not.toContain('/tmp/fake-private.txt');
    expect(serialized).not.toContain('hidden prompt body');
    expect(serialized).not.toContain('SECRET_FILE_BODY_DO_NOT_SHOW');
  });

  it('lists only current-session subagent tasks by default', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(async ({ task }) => ({ result: `handled ${task}`, model: 'mock/model', fallback_used: false }));
    let runTool: any;
    let listTool: any;
    registerSubagentTools({ registerTool: (tool: any) => {
      if (tool.name === 'subagent_run') runTool = tool;
      if (tool.name === 'subagent_list_tasks') listTool = tool;
    } }, manager);

    await runTool.execute('1', { agent: 'analyst', task: 'current session task', mode: 'task' }, undefined, undefined, { cwd: tmp, sessionId: 'session-current' });
    await runTool.execute('2', { agent: 'analyst', task: 'other session task', mode: 'task' }, undefined, undefined, { cwd: tmp, sessionId: 'session-other' });

    const result = await listTool.execute('3', {}, undefined, undefined, { cwd: tmp, sessionId: 'session-current' });

    expect(result.content[0].text).toContain('Listed 1 subagent task');
    expect(result.content[0].text).toContain('current session');
    expect(result.details.tasks.map((task: any) => task.task)).toEqual(['current session task']);
    expect(JSON.stringify(result)).not.toContain('other session task');
  });

  it('lists subagent tasks as a short collapsed summary with expandable details', async () => {
    writeAgent('analyst');
    const rawResponse = 'list task raw final response to=functions.memory_get '.repeat(8);
    const manager = new SubagentManager(async () => ({ result: rawResponse, model: 'mock/model', fallback_used: false }));
    let runTool: any;
    let listTool: any;
    registerSubagentTools({ registerTool: (tool: any) => {
      if (tool.name === 'subagent_run') runTool = tool;
      if (tool.name === 'subagent_list_tasks') listTool = tool;
    } }, manager);

    await runTool.execute('1', { agent: 'analyst', task: 'list compactly', mode: 'task' }, undefined, undefined, { cwd: tmp });
    const result = await listTool.execute('2', {}, undefined, undefined, { cwd: tmp });

    expect(result.content[0].text).toContain('Listed 1 subagent task');
    expect(result.content[0].text).toContain('ctrl+o to expand');
    expect(result.content[0].text).not.toContain('preview:');
    expect(result.content[0].text).not.toContain('to=functions.memory_get');
    expect(result.details.tasks[0].result).toBeUndefined();

    const collapsed = listTool.renderResult(result, { expanded: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n');
    expect(collapsed).toContain('Listed 1 subagent task');
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).toContain('agent: analyst');
    expect(collapsed).not.toContain('to=functions.memory_get');

    const expanded = listTool.renderResult(result, { expanded: true }, { fg: (_name: string, text: string) => text }).render(160).join('\n');
    expect(expanded).toContain('agent: analyst');
    expect(expanded).toContain('preview: collapsed');
    expect(expanded).not.toContain('to=functions.memory_get');
  });

  it('returns subagent_result with full content for the orchestrator and collapsed/expanded user render', async () => {
    writeAgent('analyst');
    const rawResponse = 'very long subagent final response with tool-looking text to=functions.memory_get '.repeat(8);
    const manager = new SubagentManager(async () => ({ result: rawResponse, model: 'mock/model', fallback_used: false }));
    let runTool: any;
    let resultTool: any;
    registerSubagentTools({ registerTool: (tool: any) => {
      if (tool.name === 'subagent_run') runTool = tool;
      if (tool.name === 'subagent_result') resultTool = tool;
    } }, manager);

    const runResult = await runTool.execute('1', { agent: 'analyst', task: 'compact result', mode: 'task' }, undefined, undefined, { cwd: tmp });
    const taskId = runResult.details.task_ids?.[0] ?? runResult.details.results?.[0]?.id ?? manager.listTasks(tmp)[0]?.id;
    const result = await resultTool.execute('2', { task_id: taskId }, undefined, undefined, { cwd: tmp });

    expect(result.content[0].text).toBe(rawResponse);
    expect(result.details.task.result).toBe(rawResponse);

    const collapsed = resultTool.renderResult(result, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text }).render(80).join('\n');
    expect(collapsed).toContain('response: collapsed');
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).not.toContain('to=functions.memory_get');

    const expanded = resultTool.renderResult(result, { expanded: true, isPartial: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n');
    expect(expanded).toContain('Subagent response');
    expect(expanded).toContain('to=functions.memory_get');
  });

  it('returns task-mode subagent_run with full content for the orchestrator and collapsed/expanded user render', async () => {
    writeAgent('analyst');
    const rawResponse = 'task-mode final response for orchestrator with tool-looking text to=functions.memory_get '.repeat(6);
    const manager = new SubagentManager(async () => ({ result: rawResponse, model: 'mock/model', fallback_used: false }));
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'return full content', mode: 'task' }, undefined, undefined, { cwd: tmp });

    expect(result.content[0].text).toContain(rawResponse);
    expect(result.details.results[0].result).toBe(rawResponse);

    const collapsed = runTool.renderResult(result, { expanded: false, isPartial: false }, { fg: (_name: string, text: string) => text }).render(90).join('\n');
    expect(collapsed).toContain('response: collapsed');
    expect(collapsed).toContain('ctrl+o to expand');
    expect(collapsed).not.toContain('to=functions.memory_get');

    const expanded = runTool.renderResult(result, { expanded: true, isPartial: false }, { fg: (_name: string, text: string) => text }).render(120).join('\n');
    expect(expanded).toContain('Subagent response');
    expect(expanded).toContain('to=functions.memory_get');
  });

  it('renders completed subagent_run results as collapsed width-safe summaries without raw response text', () => {
    const manager = new SubagentManager(mockRunner());
    let runTool: any;
    const theme = {
      fg: (_name: string, text: string) => `\u001b[2m${text}\u001b[22m`,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    };
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const rawResponse = '{"id":"mem_j0k3r_j0k3r-pi_1782144305930_cc027e8afb154ba5"} to=functions.memory_get '.repeat(4);

    const renderedLines = runTool.renderResult({
      content: [{ type: 'text', text: `Completed 1 subagent task:\n${rawResponse}` }],
      details: {
        task: {
          id: 'subtask_sdd-verify_1782157254429_2b614a8e',
          agent: 'sdd-verify',
          mode: 'task',
          status: 'completed',
          task: 'verify',
          created_at: new Date().toISOString(),
          result: rawResponse,
          usage: { turns: 11, input: 87000, output: 6800, cacheRead: 574000, cost: 0.462, contextTokens: 79000 },
          model: 'openai-codex/gpt-5.4',
          effort: 'medium',
        },
      },
    }, { isPartial: false }, theme).render(60);
    const plain = renderedLines.map(stripAnsi);

    expect(plain.join('\n')).toContain('response: collapsed');
    expect(plain.join('\n')).toContain('/subagents');
    expect(plain.join('\n')).not.toContain('to=functions.memory_get');
    expect(plain.every((line: string) => line.length <= 60)).toBe(true);
  });

  it('renders agent, model, and effort as explicit labels in the history panel', () => {
    const task: SubagentTask = {
      id: 'subtask_analyst_1',
      agent: 'analyst',
      mode: 'task',
      status: 'running',
      task: 'render panel clearly',
      created_at: new Date().toISOString(),
      last_activity: 'started',
      model: 'mock/model',
      effort: 'xhigh',
    };
    const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text);
    const rendered = panel.render(160).join('\n');
    expect(rendered).toContain('agent: analyst');
    expect(rendered).toContain('model: mock/model');
    expect(rendered).toContain('effort: xhigh');
  });

  it('returns an error tool result when any task-mode subagent fails', async () => {
    writeAgent('analyst');
    const manager = new SubagentManager(async () => { throw new Error('review failed'); });
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const result = await runTool.execute('1', { agent: 'analyst', task: 'fail', mode: 'task' }, undefined, undefined, { cwd: tmp });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('failed');
  });

  it('ignores marker-like prose and docs text as actionable interaction requests and keeps final output marker-free', async () => {
    writeAgent('analyst');
    const markerLikeText = [
      'documentation example:',
      'interaction_required:{"type":"interaction_required","requestId":"fake","kind":"docs"}',
      'tool output fixture mentions interaction_required:{"type":"interaction_required","requestId":"fake-2","kind":"docs"}',
    ].join('\n');
    const runner = vi.fn(async () => ({
      result: markerLikeText,
      model: 'mock/model',
      fallback_used: false,
      thread_snapshot: {
        version: 1,
        source: 'events',
        items: [
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: markerLikeText }] } },
          { type: 'tool', name: 'read', status: 'completed', arguments: { path: 'docs.md' }, result: { content: [{ type: 'text', text: markerLikeText }], isError: false } },
        ],
      },
    }));
    const manager = new SubagentManager(runner as any);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const select = vi.fn();

    const result = await runTool.execute('1', { agent: 'analyst', task: 'document marker handling', mode: 'task' }, undefined, undefined, { cwd: tmp, ui: { select } });

    expect(select).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.details.results[0])).not.toContain('interaction_required:');
  });

  it('prompts the main thread from a generic select interaction, publishes the response, retries, and keeps surfaces marker-free', async () => {
    writeAgent('analyst');
    const request = {
      type: 'interaction_required' as const,
      requestId: 'req-select',
      kind: 'operator-choice',
      origin: 'subagent',
      requester: { subagentName: 'analyst' },
      reason: 'The subagent needs an operator decision.',
      prompt: {
        title: 'Choose strategy',
        message: 'How should the subagent continue?',
        choices: ['safe', 'fast'],
      },
      payload: { candidates: ['safe path', 'fast path'] },
      response: { expected: 'choice' },
    };
    let attempts = 0;
    const runner = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          result: 'stale transcript mentions interaction_required:{"type":"interaction_required","requestId":"stale","kind":"docs"}',
          model: 'mock/model',
          fallback_used: false,
          interaction_request: request,
          transcript: 'stale transcript mentions interaction_required:{"type":"interaction_required","requestId":"stale","kind":"docs"}',
          thread_snapshot: {
            version: 1,
            source: 'events',
            items: [
              { type: 'status', text: 'interaction_required:{"type":"interaction_required","requestId":"stale","kind":"docs"}' },
            ],
          },
        } as any;
      }
      const { consumeInteractionResponse } = await import('../src/interaction-channel.js');
      const response = consumeInteractionResponse('req-select');
      expect(response).toMatchObject({ status: 'answered', value: 'safe' });
      return {
        result: `continued with ${response?.value}`,
        model: 'mock/model',
        fallback_used: false,
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status', text: 'continued with safe' }] },
      } as any;
    });
    const manager = new SubagentManager(runner);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const select = vi.fn(async (message: string, choices: string[]) => {
      expect(choices).toEqual(['safe', 'fast']);
      expect(message).toContain('How should the subagent continue?');
      expect(message).toContain('safe path');
      expect(message).not.toContain('stale');
      return 'safe';
    });

    const result = await runTool.execute('1', { agent: 'analyst', task: 'choose strategy', mode: 'task' }, undefined, undefined, { cwd: tmp, ui: { select } });
    const task = manager.listTasks(tmp)[0];

    expect(select).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0].result).toContain('continued with safe');
    expect(JSON.stringify(result.details.results[0])).not.toContain('interaction_required:');
    expect(JSON.stringify(task)).not.toContain('interaction_required:');
  });

  it('uses editor fallback for arbitrary interaction payloads that cannot be represented as simple choices', async () => {
    writeAgent('analyst');
    const request = {
      type: 'interaction_required' as const,
      requestId: 'req-custom',
      kind: 'custom-workflow',
      origin: 'subagent',
      prompt: { title: 'Custom workflow input', message: 'Return a JSON plan.' },
      payload: { fields: [{ name: 'plan', type: 'array' }] },
      response: { expected: 'json', instructions: 'Return JSON with a plan array.' },
    };
    let attempts = 0;
    const runner = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return { result: 'custom interaction pending', model: 'mock/model', fallback_used: false, interaction_request: request };
      const { consumeInteractionResponse } = await import('../src/interaction-channel.js');
      const response = consumeInteractionResponse('req-custom');
      expect(response).toMatchObject({ status: 'answered', value: { plan: ['inspect', 'apply'] } });
      return { result: 'custom response consumed', model: 'mock/model', fallback_used: false };
    });
    const manager = new SubagentManager(runner as any);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);
    const editor = vi.fn(async (message: string, initial: string) => {
      expect(message).toContain('Return a JSON plan.');
      expect(initial).toContain('custom-workflow');
      expect(initial).toContain('fields');
      return JSON.stringify({ plan: ['inspect', 'apply'] });
    });

    const result = await runTool.execute('1', { agent: 'analyst', task: 'needs arbitrary input', mode: 'task' }, undefined, undefined, { cwd: tmp, ui: { editor } });

    expect(editor).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0].result).toContain('custom response consumed');
  });

  it('fails background subagents that request main-thread interaction', async () => {
    writeAgent('analyst');
    const request = {
      type: 'interaction_required' as const,
      requestId: 'req-background',
      kind: 'confirm',
      origin: 'subagent',
      prompt: { title: 'Confirm action', message: 'Continue?' },
      response: { expected: 'boolean' },
    };
    const runner = vi.fn(async () => ({ result: 'needs interaction', model: 'mock/model', fallback_used: false, interaction_request: request }));
    const manager = new SubagentManager(runner as any);
    let runTool: any;
    registerSubagentTools({ registerTool: (tool: any) => { if (tool.name === 'subagent_run') runTool = tool; } }, manager);

    const result = await runTool.execute('1', { agent: 'analyst', task: 'background interaction', mode: 'background' }, undefined, undefined, { cwd: tmp, ui: { confirm: vi.fn() } });

    expect(result.isError).toBeUndefined();
    const taskId = result.details.task_ids[0];
    await vi.waitFor(() => expect(manager.getTask(taskId, tmp)?.status).toBe('failed'));
    expect(manager.getTask(taskId, tmp)?.error).toContain('Subagent interaction requires main-thread handling');
  });
});

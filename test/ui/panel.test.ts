import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import extension, { ClaudeBackgroundWidget, ClaudeBackgroundWidgetState, completionMessage, createSubagentsPanelKeyMatcher, moveClaudeBackgroundWidgetSelection, renderClaudeBackgroundWidgetLines, resolveRegisteredToolDefinition, sendSubagentCompletionMessage } from '../../index.js';
import { loadSubagents, parseFrontmatter, readSubagentsConfig, resetGlobalSubagentModelProfileField, saveGlobalSubagentModelProfile, subagentSourceWarnings } from '../../src/config.js';
import { resolveEffectiveSubagentProfile } from '../../src/profile-resolver.js';
import { buildPrompt, ThreadSnapshotBuilder } from '../../src/runner.js';
import { SubagentStructuredError, deriveErrorString, normalizeErrorMetadata, parseErrorMetadata, safeErrorMetadataDetails, serializeErrorMetadata } from '../../src/error-metadata.js';
import { applyDirtyProfileEdit, buildModelProfileRows, buildNoChangesModelProfilesMessage, buildNonTuiModelProfilesMessage, commitStagedModelProfiles, createSubagentModelProfilesModal, globalSubagentsConfigPath, groupAvailableModelsByProvider, runSubagentModelsCommand, stageModelProfileEdit } from '../../src/model-profiles-ui.js';
import { resolveSubagentHistoryDbPath, resolveSubagentsHistoryHome, SubagentHistoryStore } from '../../src/history.js';
import { isSubagentsDebugEnabled, writeSubagentsDebugLog } from '../../src/debug.js';
import { createSubagentsRenderLogger, DEFAULT_RENDER_DEBUG_LOG_PATH } from '../../src/render-debug.js';
import { SubagentManager } from '../../src/manager.js';
import { registerSubagentTools } from '../../src/tools.js';
import { SubagentsHistoryPanel } from '../../src/ui.js';
import { boundThreadSnapshot, isValidThreadSnapshot, registerSubagentRuntimeToolDefinition, renderThreadBody, resetPiComponentCacheForTests } from '../../src/thread-view.js';
import type { EffectiveSubagentProfile, SubagentErrorMetadata, SubagentModelProfiles, SubagentRunner, SubagentTask } from '../../src/types.js';

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

describe('subagents panel and extension ui', () => {
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

  it('reuses native bash tool components across rerenders and bypasses stale body caching while tools are active', () => {
    resetPiComponentCacheForTests();
    const packageRoot = path.join(tmp, 'fake-pi-panel-active-bash-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.cjs' }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    const shimDir = path.join(tmp, 'bin-panel-active-bash');
    fs.mkdirSync(shimDir);
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), path.join(shimDir, 'pi'));
    fs.writeFileSync(path.join(packageRoot, 'index.cjs'), `
      let constructions = 0;
      exports.__constructions = () => constructions;
      exports.createBashToolDefinition = (cwd) => ({ name: 'bash', cwd, kind: 'native-bash' });
      exports.ToolExecutionComponent = class {
        constructor(name, id, args) {
          constructions += 1;
          this.command = args.command;
          this.renderCount = 0;
        }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult() {}
        setExpanded() {}
        render() {
          this.renderCount += 1;
          return ['native-bash-render:' + this.renderCount + ':' + this.command];
        }
      };
    `);
    const oldArgv1 = process.argv[1];
    process.argv[1] = path.join(shimDir, 'pi');
    try {
      const now = new Date().toISOString();
      const task: SubagentTask = {
        id: 'subtask_active_bash_component',
        agent: 'analyst',
        mode: 'task',
        status: 'running',
        task: 'keep native bash active',
        created_at: now,
        last_activity_at: now,
        thread_snapshot: { version: 1, updated_at: now, source: 'events', items: [{ type: 'tool', tool_call_id: 'bash-1', name: 'bash', status: 'running', arguments: { command: 'npm test', timeout: 15 }, started_at: now }] },
      };
      const panel = new SubagentsHistoryPanel([task], { fg: (_name: string, text: string) => text }, () => undefined, () => false, (text) => text.length, (text, width) => text.length > width ? text.slice(0, width) : text, { cwd: tmp, tui: { requestRender() {} } });

      expect(panel.render(160).join('\n')).toContain('native-bash-render:1:npm test');
      expect(panel.render(160).join('\n')).toContain('native-bash-render:2:npm test');
      expect(require(packageRoot).__constructions()).toBe(1);
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
      exports.createBashToolDefinition = (cwd) => ({ name: 'bash', cwd, kind: 'native-bash' });
      exports.ToolExecutionComponent = class {
        constructor(name, id, args) { this.command = args.command; }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult(result) { this.output = result.preview || ''; }
        setExpanded() {}
        render() { return ['go test results:\r\n' + this.output]; }
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
            type: 'tool',
            name: 'bash',
            status: 'completed',
            arguments: { command: 'go test ./...' },
            result: {
              content: [{ type: 'text', text: [
                'ok github.com/example/project/internal/components 0.929s',
                'ok github.com/example/project/internal/components/communitytool 0.044s',
              ].join('\n') }],
              preview: [
                'ok github.com/example/project/internal/components 0.929s',
                'ok github.com/example/project/internal/components/communitytool 0.044s',
              ].join('\n'),
              isError: false,
            },
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
      expect(rendered.join('\n')).toContain('go test ./...');
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
      exports.createBashToolDefinition = (cwd) => ({ name: 'bash', cwd, kind: 'native-bash' });
      exports.ToolExecutionComponent = class {
        constructor(name, id, args) { this.command = args.command; this.expanded = false; }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult(result) { this.output = result.preview || ''; }
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
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'tool', name: 'bash', status: 'completed', arguments: { command: 'npm test', timeout: 15 }, result: { content: [{ type: 'text', text: 'long output' }], preview: 'long output', isError: false } }] },
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
      exports.createBashToolDefinition = (cwd) => ({ name: 'bash', cwd, kind: 'native-bash' });
      exports.ToolExecutionComponent = class {
        constructor(name, id, args) { this.command = args.command; this.expanded = false; }
        markExecutionStarted() {}
        setArgsComplete() {}
        updateResult(result) { this.output = result.preview || ''; }
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
        thread_snapshot: { version: 1, source: 'events', items: [{ type: 'tool', name: 'bash', status: 'completed', arguments: { command: 'npm test', timeout: 15 }, result: { content: [{ type: 'text', text: 'long output' }], preview: 'long output', isError: false } }] },
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
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:10.000Z',
      last_activity: 'rendering snapshot',
      model: 'mock/model',
      effort: 'high',
      usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 2 },
      thread_snapshot: { version: 1, source: 'events', items: [{ type: 'status', text: 'thread body visible' }] },
    };
    const panel = new SubagentsHistoryPanel(
      [task],
      { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      () => undefined,
      () => false,
      (text) => text.length,
      (text, width) => text.length > width ? text.slice(0, width) : text,
      {},
      42,
      undefined,
      undefined,
      undefined,
      'ctrl+shift+q',
      { timeoutMs: 2_600_000, stallTimeoutMs: 120_000, contextWindowForTask: () => 200_000 },
    );
    const rendered = panel.render(160).join('\n');

    expect(rendered).toContain('subagents');
    expect(rendered).toContain('agent: reviewer');
    expect(rendered).toContain('status: running');
    expect(rendered).toContain('effort: high (ctrl+shift+q cancel)');
    expect(rendered).toContain('model: mock/model');
    expect(rendered).toContain('duration: 10s (timeout 43m20s)');
    expect(rendered).toContain('usage: 2 turns ↑1.0k ↓500 ctx:50k (25%)');
    expect(rendered).toContain('last: rendering snapshot (stall 2m)');
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

  it('opens the subagents history panel as a full-screen overlay with bounded height', async () => {
    let subagentsCommand: any;
    let customOptions: any;
    let renderedLines: string[] = [];
    const writes: string[] = [];
    const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 50 });
    extension({
      registerTool: () => undefined,
      registerCommand: (name: string, command: any) => { if (name === 'subagents') subagentsCommand = command; },
    });

    await subagentsCommand.handler('', {
      cwd: tmp,
      ui: {
        custom: async (factory: any, options: any) => {
          customOptions = options;
          const component = factory({ terminal: { write: (text: string) => writes.push(text) }, requestRender() {} }, { fg: (_name: string, text: string) => text }, {}, () => undefined);
          renderedLines = component.render(80);
          component.handleInput('\x1b');
        },
      },
    });

    expect(customOptions).toEqual({ overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } });
    expect(renderedLines).toHaveLength(48);
    expect(writes.join('')).toContain('\x1b[?1000h\x1b[?1006h');
    expect(writes.join('')).toContain('\x1b[?1006l\x1b[?1000l');
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    else delete (process.stdout as any).rows;
  });

});

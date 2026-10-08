import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import extension from '../index.js';
import { buildPrompt } from '../src/runner.js';
import { runSubagentModelsCommand } from '../src/model-profiles-ui.js';
import { boundThreadSnapshot, isValidThreadSnapshot, renderThreadBody } from '../src/thread-view.js';
import { installSubagentTestEnv } from './helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

describe('subagents smoke', () => {
  it('keeps root and deep import smoke reachable', () => {
    expect(typeof extension).toBe('function');
    expect(typeof runSubagentModelsCommand).toBe('function');
    expect(typeof buildPrompt).toBe('function');
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
    expect(renderThreadBody(snapshot as any, { visibleWidth: (text) => text.length, truncateToWidth: (text, width) => text.slice(0, width), cwd: env.tmp }).join('\n')).toContain('hello from assistant');
    expect(renderThreadBody(snapshot as any, { visibleWidth: (text) => text.length, truncateToWidth: (text, width) => text.slice(0, width), cwd: env.tmp }).join('\n')).toContain('read completed');

    const bounded = boundThreadSnapshot({ version: 1, source: 'events', items: [{ type: 'status', text: 'x'.repeat(5000) }] } as any, { textLimit: 32 });
    expect(bounded?.items[0]).toMatchObject({ type: 'status', text: expect.stringMatching(/…$/) });
    expect((bounded?.items[0] as any).text.length).toBeLessThanOrEqual(32);
  });

  it('subagent models command uses custom modal overlay and saves project-local dirty rows locally', async () => {
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents', 'analyst.md'), `---\nname: analyst\ndescription: analyst\nscope: project\n---\nbody`);
    const notifications: any[] = [];
    let capturedOptions: any;
    const custom = async (factory: any, options: any) => {
      capturedOptions = options;
      const done = () => undefined;
      factory({ requestRender: () => undefined }, {}, undefined, done);
      return { action: 'save', dirtyProfiles: { analyst: { model: { provider: 'openai', id: 'gpt-5.5' }, effort: 'high' } } };
    };
    const message = await runSubagentModelsCommand({
      cwd: env.tmp,
      modelRegistry: { getAvailable: async () => [{ provider: 'openai', id: 'gpt-5.5', label: 'gpt-5.5' }] },
      ui: { custom, notify: (...args: any[]) => notifications.push(args) },
    });

    expect(capturedOptions).toEqual({ overlay: true, overlayOptions: { anchor: 'center', width: '96%', maxHeight: '90%', minWidth: 96 } });
    expect(message).toBe(`Saved subagent model profiles to ${path.join(env.tmp, '.pi', 'subagents.json')}.`);
    expect(notifications).toEqual([[message, 'info']]);
  });

  it('builds a delegated user prompt without embedding subagent system instructions', () => {
    const prompt = buildPrompt({ name: 'analyst', description: 'analysis', filePath: '/tmp/analyst.md', instructions: 'SYSTEM ONLY', tools: ['read'] } as any, 'inspect the repo', undefined, ['read']);
    expect(prompt).toBe('## delegated task\ninspect the repo');
    expect(prompt).not.toContain('SYSTEM ONLY');
  });

  it('reuses one manager on reload and reconciles only a new entry', async () => {
    vi.resetModules();
    const reconcileOrphanedTasks = vi.fn();
    const cancelRunning = vi.fn();
    const managerInstance = {
      reconcileOrphanedTasks,
      cancelRunning,
      awaitSettled: vi.fn(async () => undefined),
      onTaskUpdate: vi.fn(() => () => undefined),
      listActiveSessionTasks: () => [],
      listSessionTasks: () => [],
    };
    const constructor = vi.fn();
    class MockManager {
      constructor() {
        constructor();
        return managerInstance as any;
      }
    }
    vi.doMock('../src/manager.js', () => ({ SubagentManager: MockManager }));
    const runtime = await import('../src/runtime-registry.js');
    runtime.resetRuntimeRegistryForTests();
    const { default: reloadedExtension } = await import('../src/extension/subagents-extension.js');
    const makePi = () => {
      const handlers = new Map<string, Function>();
      return {
        handlers,
        pi: {
          registerMessageRenderer: vi.fn(), registerShortcut: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn(),
          on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler); }),
        },
      };
    };
    const ctx = { cwd: env.tmp, sessionManager: { getSessionId: () => 'reload-session' }, ui: {} };
    const generationA = makePi();
    reloadedExtension(generationA.pi);
    generationA.handlers.get('session_start')?.({}, ctx);
    generationA.handlers.get('session_shutdown')?.({ reason: 'reload' }, ctx);
    expect(cancelRunning).not.toHaveBeenCalled();

    const generationB = makePi();
    reloadedExtension(generationB.pi);
    generationB.handlers.get('session_start')?.({ reason: 'reload' }, ctx);

    expect(constructor).toHaveBeenCalledTimes(1);
    expect(reconcileOrphanedTasks).toHaveBeenCalledTimes(1);
    expect(reconcileOrphanedTasks).toHaveBeenCalledWith(env.tmp);
  });

  it.each(['quit', 'new', 'resume', 'fork', 'unexpected'])('uses definitive closing for %s', async (reason) => {
    vi.resetModules();
    const cancelRunning = vi.fn();
    const managerInstance = {
      reconcileOrphanedTasks: vi.fn(), cancelRunning, awaitSettled: vi.fn(async () => undefined),
      onTaskUpdate: vi.fn(() => () => undefined), listActiveSessionTasks: () => [], listSessionTasks: () => [],
    };
    class MockManager { constructor() { return managerInstance as any; } }
    vi.doMock('../src/manager.js', () => ({ SubagentManager: MockManager }));
    const runtime = await import('../src/runtime-registry.js');
    runtime.resetRuntimeRegistryForTests();
    const { default: reloadedExtension } = await import('../src/extension/subagents-extension.js');
    const handlers = new Map<string, Function>();
    reloadedExtension({
      registerMessageRenderer: vi.fn(), registerShortcut: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn(),
      on: (event: string, handler: Function) => handlers.set(event, handler),
    });
    const ctx = { cwd: env.tmp, sessionManager: { getSessionId: () => `closing-${reason}` }, ui: {} };
    handlers.get('session_start')?.({}, ctx);
    await handlers.get('session_shutdown')?.({ reason }, ctx);
    expect(cancelRunning).toHaveBeenCalledWith(`Pi session shutdown: ${reason}`);
    expect(runtime.getRuntimeEntryForTests(`closing-${reason}`)).toBeUndefined();
  });

  it('requires getSessionId for session identity', async () => {
    vi.resetModules();
    const runtime = await import('../src/runtime-registry.js');
    runtime.resetRuntimeRegistryForTests();
    const { default: reloadedExtension } = await import('../src/extension/subagents-extension.js');
    const handlers = new Map<string, Function>();
    reloadedExtension({ registerTool: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(), on: (event: string, handler: Function) => handlers.set(event, handler) });
    const expected = 'Missing Pi session identity from ctx.sessionManager.getSessionId().';
    expect(() => handlers.get('session_start')?.({}, { cwd: env.tmp, sessionManager: {} })).toThrow(expected);
    expect(() => handlers.get('session_shutdown')?.({ reason: 'reload' }, { cwd: env.tmp, sessionManager: {} })).toThrow(expected);
  });
});

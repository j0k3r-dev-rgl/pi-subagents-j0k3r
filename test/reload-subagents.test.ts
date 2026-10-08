import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import extension from '../src/extension/subagents-extension.js';
import { SubagentManager } from '../src/manager.js';
import {
  beginClosing,
  bindSessionGeneration,
  enqueueOrDeliverTerminal,
  getRuntimeEntryForTests,
  getRuntimeResolver,
  markReloading,
  resetRuntimeRegistryForTests,
} from '../src/runtime-registry.js';
import { registerSubagentTools } from '../src/tools.js';
import { openSubagentsPanel, registerSubagentsPanelOpener, resetSubagentsPanelOpenerStateForTests } from '../src/ui/panel-overlay.js';
import type { RuntimeEntryV1, RuntimeManagerAccessV1 } from '../src/runtime-registry.js';
import type { SubagentRunner, SubagentTask } from '../src/types.js';
import { installSubagentTestEnv } from './helpers/subagent-test-helpers.js';

const env = installSubagentTestEnv();

function context(sessionId: string, ui: Record<string, unknown> = {}) {
  return { cwd: env.tmp, sessionManager: { getSessionId: () => sessionId }, ui };
}

function writeAgent(name: string, mode = 'background'): void {
  fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents', `${name}.md`), `---\nname: ${name}\ndescription: ${name}\nsubagent_mode: ${mode}\ntools:\n  - read\n---\n# ${name}`);
}

async function waitForTask(manager: SubagentManager, id: string, status: SubagentTask['status']): Promise<SubagentTask> {
  await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe(status));
  return manager.getTask(id)!;
}

describe('reload runtime', () => {
  beforeEach(() => {
    resetRuntimeRegistryForTests();
    resetSubagentsPanelOpenerStateForTests();
  });

  it('evaluates two extension generations and keeps running and queued work in one manager', async () => {
    writeAgent('generation-first');
    writeAgent('generation-second');
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 1, timeout_ms: 1000 }));
    const releases = new Map<string, () => void>();
    const starts: string[] = [];
    const steer = vi.fn();
    const runner: SubagentRunner = async ({ definition, registerLiveBridge }) => {
      starts.push(definition.name);
      registerLiveBridge?.({ supported: true, detected_pi_version: '0.85.1', steer });
      return await new Promise((resolve) => {
        releases.set(definition.name, () => resolve({ result: `${definition.name} done`, model: 'mock/model' }));
      });
    };
    const createPi = () => {
      const handlers = new Map<string, Function>();
      const tools: Record<string, any> = {};
      const sendMessage = vi.fn();
      return {
        handlers, tools, sendMessage,
        pi: {
          sendMessage,
          registerTool: (tool: any) => { tools[tool.name] = tool; },
          registerMessageRenderer: vi.fn(), registerShortcut: vi.fn(), registerCommand: vi.fn(),
          on: (event: string, handler: Function) => handlers.set(event, handler),
        },
      };
    };
    const setWidgetA = vi.fn();
    const ctxA = context('extension-reload-session', { setWidget: setWidgetA, onTerminalInput: vi.fn(() => () => undefined) });
    const generationA = createPi();
    extension(generationA.pi);
    generationA.handlers.get('session_start')?.({}, ctxA);
    const entryA = getRuntimeEntryForTests('extension-reload-session')!;
    (entryA.manager as any).runner = runner;
    const launched = await entryA.manager.run({ agents: ['generation-first', 'generation-second'], task: 'extension reload', mode: 'background' }, ctxA);
    await waitForTask(entryA.manager, launched.task_ids[0]!, 'running');
    expect(entryA.manager.getTask(launched.task_ids[1]!)?.status).toBe('queued');

    generationA.handlers.get('session_shutdown')?.({ reason: 'reload' }, ctxA);
    expect(setWidgetA.mock.calls.some((call) => call[1] === undefined)).toBe(true);
    releases.get('generation-first')?.();
    await waitForTask(entryA.manager, launched.task_ids[0]!, 'completed');
    expect(starts).toEqual(['generation-first']);

    const setWidgetB = vi.fn();
    const ctxB = context('extension-reload-session', { setWidget: setWidgetB, onTerminalInput: vi.fn(() => () => undefined) });
    const generationB = createPi();
    extension(generationB.pi);
    generationB.handlers.get('session_start')?.({ reason: 'reload' }, ctxB);
    const entryB = getRuntimeEntryForTests('extension-reload-session')!;
    expect(entryB.manager).toBe(entryA.manager);
    generationA.handlers.get('session_shutdown')?.({ reason: 'reload' }, ctxA);
    expect(setWidgetB.mock.calls.filter((call) => call[1] === undefined)).toHaveLength(0);
    await waitForTask(entryB.manager, launched.task_ids[1]!, 'running');
    await vi.waitFor(() => expect(generationB.sendMessage).toHaveBeenCalledTimes(1));
    const steering = await generationB.tools.subagent_send_message.execute('message', { task_id: launched.task_ids[1], message: 'continue through generation B' }, undefined, undefined, ctxB);
    expect(steering.details.status).toBe('queued');
    expect(steer).toHaveBeenCalledWith('continue through generation B');
    releases.get('generation-second')?.();
    await waitForTask(entryB.manager, launched.task_ids[1]!, 'completed');
    await generationB.handlers.get('session_shutdown')?.({ reason: 'quit' }, ctxB);
  });

  it('flattens generation A runner context and sends success and error UI notifications through generation B', async () => {
    writeAgent('late-success');
    writeAgent('late-failure');
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 2, timeout_ms: 1000 }));
    let generationAInvalid = false;
    const rejectStaleAccess = () => {
      if (generationAInvalid) throw new Error('generation A wrapper used after reload');
    };
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    const piA = {
      getThinkingLevel: () => { rejectStaleAccess(); return 'high'; },
      getTools: () => { rejectStaleAccess(); return [{ name: 'read' }]; },
    };
    const ctxA = {
      cwd: env.tmp,
      pi: piA,
      sessionManager: { getSessionId: () => { rejectStaleAccess(); return 'late-context-session'; } },
      getThinkingLevel: () => { rejectStaleAccess(); return 'low'; },
      getTools: () => { rejectStaleAccess(); return [{ name: 'write' }]; },
      ui: { notify: notifyA },
    };
    let releaseRunners: (() => void) | undefined;
    const runnerGate = new Promise<void>((resolve) => { releaseRunners = resolve; });
    const started: string[] = [];
    const runner: SubagentRunner = async ({ definition, ctx, parentPiSessionId }) => {
      started.push(definition.name);
      await runnerGate;
      expect(parentPiSessionId).toBe('late-context-session');
      expect(ctx.sessionManager).toBeUndefined();
      expect(ctx.pi).toBeUndefined();
      expect(ctx.getThinkingLevel).toBeUndefined();
      expect(ctx.getTools).toBeUndefined();
      expect(ctx.thinkingLevel).toBe('high');
      expect(ctx.activeToolNames).toEqual(['read']);
      if (definition.name === 'late-failure') throw new Error('late failure');
      return { result: 'late success', model: 'mock/model' };
    };
    const tokenA = Symbol('late-a');
    const binding = bindSessionGeneration({
      sessionId: 'late-context-session', token: tokenA, pi: piA, ctx: ctxA, cwd: env.tmp,
      createManager: (access) => new SubagentManager(runner, undefined, undefined, undefined, access),
    });
    const launched = await binding.entry.manager.run({ agents: ['late-success', 'late-failure'], task: 'cross reload', mode: 'background' }, ctxA);
    await vi.waitFor(() => expect(started).toHaveLength(2));

    expect(markReloading(binding.entry, 'late-context-session', tokenA)).toBe(true);
    const ctxB = context('late-context-session', { notify: notifyB });
    bindSessionGeneration({
      sessionId: 'late-context-session', token: Symbol('late-b'), pi: {}, ctx: ctxB, cwd: env.tmp,
      createManager: () => { throw new Error('manager must survive reload'); },
    });
    generationAInvalid = true;
    releaseRunners?.();

    await waitForTask(binding.entry.manager, launched.task_ids[0]!, 'completed');
    await waitForTask(binding.entry.manager, launched.task_ids[1]!, 'failed');
    expect(notifyA).not.toHaveBeenCalled();
    expect(notifyB).toHaveBeenCalledWith(expect.stringContaining('late-success'), 'info');
    expect(notifyB).toHaveBeenCalledWith(expect.stringContaining('late-failure'), 'warning');
  });

  it('preserves running and queued tasks and resolves steering, interaction, and terminal delivery through the new link', async () => {
    for (const name of ['first', 'second', 'interactive', 'failure', 'retry']) writeAgent(name, name === 'interactive' ? 'task' : 'background');
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 1, timeout_ms: 1000 }));

    const releases = new Map<string, () => void>();
    const starts: string[] = [];
    const steers = new Map<string, ReturnType<typeof vi.fn>>();
    let interactionAttempt = 0;
    const runner: SubagentRunner = async ({ definition, registerLiveBridge }) => {
      starts.push(definition.name);
      const steer = vi.fn();
      steers.set(definition.name, steer);
      registerLiveBridge?.({ supported: true, detected_pi_version: '0.85.1', steer });
      if (definition.name === 'failure') throw new Error('failure after reload');
      if (definition.name === 'interactive') {
        interactionAttempt += 1;
        if (interactionAttempt === 1) {
          return {
            result: 'interaction needed', model: 'mock/model', fallback_used: false,
            interaction_request: { type: 'interaction_request', requestId: 'request-after-reload', kind: 'input', origin: 'extension', reasonCode: 'test', riskLevel: 'low' } as any,
          };
        }
        return { result: 'interaction complete', model: 'mock/model', fallback_used: false };
      }
      return await new Promise((resolve) => {
        releases.set(definition.name, () => resolve({ result: `${definition.name} complete`, model: 'mock/model', fallback_used: false }));
      });
    };

    const sentA = vi.fn();
    const tokenA = Symbol('generation-a');
    const ctxA = context('session-main', { input: vi.fn(async () => 'old') });
    let entry: RuntimeEntryV1 | undefined;
    const bindingA = bindSessionGeneration({
      sessionId: 'session-main', token: tokenA, pi: { sendMessage: sentA }, ctx: ctxA, cwd: env.tmp,
      createManager: (access: RuntimeManagerAccessV1) => new SubagentManager(runner, undefined, (task, cwd) => {
        if (entry) enqueueOrDeliverTerminal(entry, task, cwd);
      }, undefined, access),
    });
    entry = bindingA.entry;
    const manager = entry.manager;

    const launch = await manager.run({ agents: ['first', 'second'], task: 'survive reload', mode: 'background' }, ctxA);
    const firstId = launch.task_ids[0]!;
    const secondId = launch.task_ids[1]!;
    await waitForTask(manager, firstId, 'running');
    expect(manager.getTask(secondId)?.status).toBe('queued');

    expect(markReloading(entry, 'session-main', tokenA)).toBe(true);
    releases.get('first')?.();
    const firstTask = await waitForTask(manager, firstId, 'completed');
    enqueueOrDeliverTerminal(entry, firstTask, env.tmp);
    expect(sentA).not.toHaveBeenCalled();
    expect(starts).toEqual(['first']);

    const sentB = vi.fn();
    const inputB = vi.fn(async () => 'answer from generation B');
    const tokenB = Symbol('generation-b');
    const ctxB = context('session-main', { input: inputB });
    const bindingB = bindSessionGeneration({
      sessionId: 'session-main', token: tokenB, pi: { sendMessage: sentB }, ctx: ctxB, cwd: env.tmp,
      createManager: () => { throw new Error('reload must reuse the manager'); },
    });
    expect(bindingB.entry.manager).toBe(manager);
    await vi.waitFor(() => expect(sentB).toHaveBeenCalledTimes(1));
    await waitForTask(manager, secondId, 'running');

    const tools: Record<string, any> = {};
    registerSubagentTools({ registerTool: (tool: any) => { tools[tool.name] = tool; } }, getRuntimeResolver(), env.tmp);
    const steering = await tools.subagent_send_message.execute('steer', { task_id: secondId, message: 'new generation steering' }, undefined, undefined, ctxB);
    expect(steering.details.status).toBe('queued');
    expect(steers.get('second')).toHaveBeenCalledWith('new generation steering');
    releases.get('second')?.();
    await waitForTask(manager, secondId, 'completed');

    const interaction = await manager.run({ agent: 'interactive', task: 'ask after reload', mode: 'task' }, ctxB);
    expect(interaction.results?.[0]?.status).toBe('completed');
    expect(inputB).toHaveBeenCalledTimes(1);

    const failed = await manager.run({ agent: 'failure', task: 'fail after reload', mode: 'background' }, ctxB);
    const failedTask = await waitForTask(manager, failed.task_ids[0]!, 'failed');
    await vi.waitFor(() => expect(sentB).toHaveBeenCalledTimes(3));
    expect(sentB.mock.calls.some(([message]) => String(message?.content).includes(failedTask.id))).toBe(true);

    let failRetryDelivery = true;
    sentB.mockImplementation((message: any) => {
      if (failRetryDelivery && String(message?.content).includes('retry')) throw new Error('delivery failed');
    });
    const retryRun = await manager.run({ agent: 'retry', task: 'retry delivery', mode: 'background' }, ctxB);
    await waitForTask(manager, retryRun.task_ids[0]!, 'running');
    releases.get('retry')?.();
    const retryTask = await waitForTask(manager, retryRun.task_ids[0]!, 'completed');
    enqueueOrDeliverTerminal(entry, retryTask, env.tmp);
    await vi.waitFor(() => {
      const failedDeliveryCount = sentB.mock.calls.filter(([message]) => String(message?.content).includes(retryTask.id)).length;
      expect(failedDeliveryCount).toBe(1);
    });

    expect(markReloading(entry, 'session-main', tokenB)).toBe(true);
    failRetryDelivery = false;
    const sentC = vi.fn();
    bindSessionGeneration({
      sessionId: 'session-main', token: Symbol('generation-c'), pi: { sendMessage: sentC }, ctx: context('session-main'), cwd: env.tmp,
      createManager: () => { throw new Error('second reload must reuse the manager'); },
    });
    await vi.waitFor(() => expect(sentC).toHaveBeenCalledTimes(1));
    expect(String(sentC.mock.calls[0]?.[0]?.content)).toContain(retryTask.id);
  });

  it('isolates session identifiers and prevents an old UI owner from clearing a new opener', () => {
    const create = (sessionId: string, token: symbol) => bindSessionGeneration({
      sessionId, token, pi: {}, ctx: context(sessionId), cwd: env.tmp,
      createManager: (access) => new SubagentManager(async () => ({ result: 'done', model: 'mock/model' }), undefined, undefined, undefined, access),
    });
    const first = create('parent-session', Symbol('parent'));
    const nested = create('nested-session', Symbol('nested'));
    expect(first.entry.manager).not.toBe(nested.entry.manager);
    expect(getRuntimeResolver().resolve(context('parent-session')).manager).toBe(first.entry.manager);
    expect(getRuntimeResolver().resolve(context('nested-session')).manager).toBe(nested.entry.manager);

    const opened: string[] = [];
    const removeOld = registerSubagentsPanelOpener(Symbol('old-ui'), () => { opened.push('old'); });
    registerSubagentsPanelOpener(Symbol('new-ui'), () => { opened.push('new'); });
    removeOld();
    openSubagentsPanel();
    expect(opened).toEqual(['new']);
  });

  it('removes an aborted limiter waiter during reload and gives each interaction invocation a full timeout', async () => {
    for (const name of ['blocker', 'aborted', 'next', 'timed-interaction']) writeAgent(name, name === 'timed-interaction' ? 'task' : 'background');
    fs.writeFileSync(path.join(env.tmp, '.pi', 'subagents.json'), JSON.stringify({ max_concurrency: 1, timeout_ms: 80 }));
    const starts: string[] = [];
    let releaseBlocker: (() => void) | undefined;
    let interactionAttempt = 0;
    const runner: SubagentRunner = async ({ definition }) => {
      starts.push(definition.name);
      if (definition.name === 'blocker') return await new Promise((resolve) => { releaseBlocker = () => resolve({ result: 'released', model: 'mock/model' }); });
      if (definition.name === 'timed-interaction') {
        interactionAttempt += 1;
        if (interactionAttempt <= 2) {
          return {
            result: `interaction ${interactionAttempt}`, model: 'mock/model',
            interaction_request: { type: 'interaction_request', requestId: `timed-${interactionAttempt}`, kind: 'input', origin: 'extension', reasonCode: 'test', riskLevel: 'low' } as any,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return { result: `${definition.name} done`, model: 'mock/model' };
    };
    const tokenA = Symbol('race-a');
    const ui = { input: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return 'answer'; }) };
    const ctxA = context('race-session', ui);
    const binding = bindSessionGeneration({
      sessionId: 'race-session', token: tokenA, pi: {}, ctx: ctxA, cwd: env.tmp,
      createManager: (access) => new SubagentManager(runner, undefined, undefined, undefined, access),
    });
    const manager = binding.entry.manager;
    const blocker = await manager.run({ agent: 'blocker', task: 'hold limiter', mode: 'background' }, ctxA);
    await waitForTask(manager, blocker.task_ids[0]!, 'running');
    const controller = new AbortController();
    const aborted = await manager.run({ agent: 'aborted', task: 'abort in limiter', mode: 'background' }, ctxA, controller.signal);
    expect(manager.getTask(aborted.task_ids[0]!)?.status).toBe('queued');
    expect(markReloading(binding.entry, 'race-session', tokenA)).toBe(true);
    controller.abort();
    releaseBlocker?.();
    await waitForTask(manager, aborted.task_ids[0]!, 'cancelled');
    expect(starts).toEqual(['blocker']);

    const ctxB = context('race-session', ui);
    bindSessionGeneration({
      sessionId: 'race-session', token: Symbol('race-b'), pi: {}, ctx: ctxB, cwd: env.tmp,
      createManager: () => { throw new Error('manager must be reused'); },
    });
    const next = await manager.run({ agent: 'next', task: 'use released limiter', mode: 'background' }, ctxB);
    await waitForTask(manager, next.task_ids[0]!, 'completed');
    expect(starts).toEqual(['blocker', 'next']);

    const timed = await manager.run({ agent: 'timed-interaction', task: 'two interactions', mode: 'task' }, ctxB);
    expect(timed.results?.[0]?.status).toBe('completed');
    expect(interactionAttempt).toBe(3);
    expect(ui.input).toHaveBeenCalledTimes(2);
  });

  it('keeps one close promise and the closing entry until runner cleanup settles', async () => {
    writeAgent('closing');
    let cleanupAllowed: (() => void) | undefined;
    const runner: SubagentRunner = async ({ signal }) => {
      await new Promise<void>((resolve) => {
        cleanupAllowed = resolve;
        signal.addEventListener('abort', () => undefined, { once: true });
      });
      throw new Error('aborted after cleanup');
    };
    const token = Symbol('closing-generation');
    const ctx = context('closing-session');
    const binding = bindSessionGeneration({
      sessionId: 'closing-session', token, pi: {}, ctx, cwd: env.tmp,
      createManager: (access) => new SubagentManager(runner, undefined, undefined, undefined, access),
    });
    const run = await binding.entry.manager.run({ agent: 'closing', task: 'close', mode: 'background' }, ctx);
    await waitForTask(binding.entry.manager, run.task_ids[0]!, 'running');

    const firstClose = beginClosing(binding.entry, 'closing-session', token, 'quit');
    const secondClose = beginClosing(binding.entry, 'closing-session', token, 'quit');
    expect(secondClose).toBe(firstClose);
    expect(getRuntimeEntryForTests('closing-session')?.state).toBe('closing');
    await expect(binding.entry.manager.run({ agent: 'closing', task: 'late run', mode: 'background' }, ctx)).rejects.toThrow('Subagent session is closing.');
    await expect(binding.entry.manager.continueTask({ task_id: run.task_ids[0]!, prompt: 'late continue' }, ctx)).rejects.toThrow('Subagent session is closing.');

    cleanupAllowed?.();
    await firstClose;
    expect(getRuntimeEntryForTests('closing-session')).toBeUndefined();
  });
});

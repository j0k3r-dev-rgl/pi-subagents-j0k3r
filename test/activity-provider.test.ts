import { beforeEach, describe, expect, it, vi } from 'vitest';
import extension, { getSubagentActivityProvider, watchSubagentActivityProvider } from '../index.js';
import { registerSubagentActivityProvider } from '../src/activity-provider.js';
import { installSubagentTestEnv } from './helpers/subagent-test-helpers.js';
import type { SubagentRunner } from '../src/types.js';

const { MockManager, instances } = vi.hoisted(() => {
  const instances: any[] = [];
  class MockManager {
    static initialTasks: any[] = [];
    readonly tasks = new Map<string, any>();
    readonly listeners = new Set<() => void>();
    listLiveTasksCalls = 0;
    historyReads = 0;
    constructor() { for (const task of MockManager.initialTasks) this.tasks.set(task.id, structuredClone(task)); MockManager.initialTasks = []; instances.push(this); }
    listLiveTasks(cwd?: string, sessionId?: string) { this.listLiveTasksCalls += 1; return [...this.tasks.values()].filter((task) => (!cwd || task.cwd === cwd) && (!sessionId || task.session_id === sessionId)); }
    subscribeTaskUpdates(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    listTasks() { this.historyReads += 1; return []; }
    listSessionTasks() { return []; }
    reconcileOrphanedTasks() { return []; }
    cancelRunning() { return []; }
    emit() { for (const listener of [...this.listeners]) listener(); }
    update(id: string, patch: Record<string, unknown>) { Object.assign(this.tasks.get(id), patch); this.emit(); }
  }
  return { MockManager, instances };
});
vi.mock('../src/manager.js', () => ({ SubagentManager: MockManager }));
type ActivityProvider = NonNullable<ReturnType<typeof getSubagentActivityProvider>>;
const env = installSubagentTestEnv();

function task(id: string, status = 'queued') {
  return {
    id, agent: 'analyst', mode: 'task', status,
    task: 'PROMPT_CANARY', context: 'CONTEXT_CANARY', prompt: 'PROMPT_CANARY', system_prompt: 'SYSTEM_CANARY',
    transcript: 'TRANSCRIPT_CANARY', output_preview: 'OUTPUT_CANARY', error: 'ERROR_CANARY', nested_session_path: '/SECRET_PATH_CANARY/session.jsonl',
    cwd: 'test-cwd', session_id: 'test-session', parent_task_id: 'INFERRED_PARENT_CANARY',
    created_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', last_activity_at: '2026-01-01T00:00:02.000Z',
    model: 'provider/model', effort: 'high', model_source: 'profile', effort_source: 'definition',
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.5, contextTokens: 14, turns: 2 },
    live_activity: { trail: [], current: { kind: 'tool_running', label: 'LABEL_CANARY /SECRET_PATH_CANARY ARG_CANARY OUTPUT_CANARY', tool_names: ['read', 'bash'] } },
  };
}
function makePi() {
  const handlers = new Map<string, Function>();
  const pi = { registerMessageRenderer: vi.fn(), registerShortcut: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn(), on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
  return { pi, handlers };
}
function start(initialTasks: any[] = []): { provider: ActivityProvider; manager: any; pi: any } {
  MockManager.initialTasks = initialTasks;
  const { pi, handlers } = makePi();
  extension(pi);
  handlers.get('session_start')?.({}, { cwd: 'test-cwd', sessionId: 'test-session', ui: {} });
  const manager = instances.at(-1)!;
  const provider = getSubagentActivityProvider(pi);
  if (!provider) throw new Error('provider was not registered');
  return { provider, manager, pi };
}

describe('public subagent activity provider', () => {
  beforeEach(() => { instances.length = 0; MockManager.initialTasks = []; });

  it('is root-discoverable, manager-backed, safe, and immutable', () => {
    const { provider, manager } = start([task('task-1')]);
    const snapshot = provider.getSnapshot();
    expect(snapshot).toMatchObject({ version: 1, revision: 0, tasks: [{ id: 'task-1', agent: 'analyst', mode: 'task', status: 'queued', model: 'provider/model', effort: 'high' }] });
    expect(snapshot.tasks[0]).toMatchObject({ created_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', last_activity_at: '2026-01-01T00:00:02.000Z', model_source: 'profile', effort_source: 'definition', activity: { kind: 'tool_running', tool_names: ['read', 'bash'] } });
    expect(snapshot.tasks[0]).toHaveProperty('usage.input', 10);
    expect(JSON.stringify(snapshot)).not.toMatch(/CANARY/);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.tasks)).toBe(true); expect(Object.isFrozen(snapshot.tasks[0])).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[0]?.usage)).toBe(true); expect(Object.isFrozen(snapshot.tasks[0]?.activity)).toBe(true);
    manager.tasks.set('unknown', { ...task('unknown'), model: 'bad model', effort: 'unknown', model_source: 'unknown', effort_source: 'unknown', usage: { input: 'bad', secret: 'SECRET_CANARY' }, live_activity: { current: { kind: 'unknown', tool_names: ['/SECRET_PATH_CANARY'] } } });
    manager.emit();
    expect(provider.getSnapshot().tasks.find((entry) => entry.id === 'unknown')).toMatchObject({ id: 'unknown' });
    expect(JSON.stringify(provider.getSnapshot().tasks.find((entry) => entry.id === 'unknown'))).not.toMatch(/bad model|SECRET_CANARY|SECRET_PATH_CANARY/);
    expect(manager.listLiveTasksCalls).toBe(2); expect(manager.historyReads).toBe(0); expect('cancel' in provider).toBe(false);
  });

  it('delivers synchronously with ordered revisions and idempotent unsubscribe', () => {
    const { provider, manager } = start([task('task-1')]);
    const received: any[] = []; const unsubscribe = provider.subscribe((snapshot) => received.push(snapshot));
    expect(received).toHaveLength(1); expect(received[0]).toBe(provider.getSnapshot());
    manager.update('task-1', { status: 'running', last_activity_at: '2026-01-01T00:00:03.000Z' });
    manager.update('task-1', { status: 'completed', ended_at: '2026-01-01T00:00:04.000Z', live_activity: undefined });
    expect(received.map((snapshot) => snapshot.tasks[0]?.status)).toEqual(['queued', 'running', 'completed']);
    expect(received.map((snapshot) => snapshot.revision)).toEqual([0, 1, 2]);
    expect(received.every((snapshot, index) => index === 0 || snapshot.revision > received[index - 1].revision)).toBe(true);
    unsubscribe(); unsubscribe(); manager.update('task-1', { status: 'failed', error: 'late update' }); expect(received).toHaveLength(3);
  });

  it('keeps concurrent tasks independent, accepts only existing statuses, and ignores terminal activity', () => {
    const { provider, manager } = start(['completed', 'failed', 'stopping', 'cancelled', 'interrupted', 'running', 'queued', 'waiting'].map((status) => task(status, status)));
    const received: any[] = []; provider.subscribe((snapshot) => received.push(snapshot));
    expect(received[0].tasks.map((entry: any) => entry.status)).toEqual(['completed', 'failed', 'stopping', 'cancelled', 'interrupted', 'running', 'queued']);
    manager.update('running', { status: 'completed', ended_at: '2026-01-01T00:00:05.000Z' }); const beforeLateActivity = provider.getSnapshot();
    manager.update('running', { live_activity: { current: { kind: 'tool_running', label: 'LATE_CANARY', tool_names: ['read'] } } });
    expect(provider.getSnapshot()).toBe(beforeLateActivity); expect(received).toHaveLength(2); expect(JSON.stringify(provider.getSnapshot())).not.toContain('LATE_CANARY');
    expect(provider.getSnapshot().tasks.find((entry) => entry.id === 'queued')?.status).toBe('queued'); expect(received.at(-1)?.tasks.find((entry: any) => entry.id === 'failed')?.status).toBe('failed');
  });

  it('keeps 100-task notification work bounded, lossless, monotonic, and history-free', () => {
    const { provider, manager } = start(Array.from({ length: 100 }, (_, index) => task(`task-${index}`)));
    const first: any[] = []; const second: any[] = []; provider.subscribe((snapshot) => first.push(snapshot)); provider.subscribe((snapshot) => second.push(snapshot));
    for (let round = 0; round < 3; round += 1) for (let index = 0; index < 100; index += 1) manager.update(`task-${index}`, { status: round === 2 ? 'completed' : 'running', last_activity_at: `2026-01-01T00:0${round}:00.${String(index).padStart(3, '0')}Z` });
    expect(first).toHaveLength(301); expect(second).toHaveLength(301); expect(first.at(-1)?.tasks).toHaveLength(100);
    expect(new Set(first.at(-1)?.tasks.map((entry: any) => entry.status))).toEqual(new Set(['completed']));
    expect(first.map((snapshot) => snapshot.revision)).toEqual(Array.from({ length: 301 }, (_, index) => index));
    expect(manager.listLiveTasksCalls).toBe(first.length); expect(manager.historyReads).toBe(0);
  });

  it('filters by the authoritative scope, uses live tasks only, and unregisters cleanly', () => {
    const { pi } = makePi(); const tasks = [
      { ...task('old', 'completed'), cwd: 'old-cwd', session_id: 'old-session' },
      { ...task('current', 'running'), cwd: 'current-cwd', session_id: 'current-session' },
    ]; const calls: any[] = []; const listeners = new Set<Function>();
    const manager = { listLiveTasks(cwd?: string, sessionId?: string) { calls.push([cwd, sessionId]); return cwd && sessionId ? tasks.filter((entry) => entry.cwd === cwd && entry.session_id === sessionId) : tasks; }, subscribeTaskUpdates(listener: Function) { listeners.add(listener); return () => listeners.delete(listener); } };
    const dispose = (registerSubagentActivityProvider as any)(pi, manager, { cwd: 'current-cwd', sessionId: 'current-session' }); const provider = getSubagentActivityProvider(pi)!;
    expect(provider.getSnapshot().tasks.map((entry) => entry.id)).toEqual(['current']); expect(calls[0]).toEqual(['current-cwd', 'current-session']);
    dispose?.(); expect(getSubagentActivityProvider(pi)).toBeUndefined(); expect(listeners.size).toBe(0); dispose?.();
  });

  it('registers only for a live session and replaces/disposes on session and extension reload', () => {
    const { pi, handlers } = makePi(); extension(pi); expect(getSubagentActivityProvider(pi)).toBeUndefined();
    handlers.get('session_start')?.({}, { cwd: 'cwd-a', sessionId: 'session-a', ui: {} }); const first = getSubagentActivityProvider(pi)!; const firstManager = instances.at(-1)!; const oldUpdates: any[] = []; first.subscribe((snapshot) => oldUpdates.push(snapshot));
    handlers.get('session_start')?.({}, { cwd: 'cwd-b', sessionId: 'session-b', ui: {} }); const second = getSubagentActivityProvider(pi)!;
    expect(second).not.toBe(first); expect(firstManager.listeners.size).toBe(1); firstManager.emit(); expect(oldUpdates).toHaveLength(1);
    extension(pi); expect(getSubagentActivityProvider(pi)).toBeUndefined(); expect(instances.at(-1)!.listeners.size).toBe(0);
    handlers.get('session_start')?.({}, { cwd: 'cwd-c', sessionId: 'session-c', ui: {} }); expect(getSubagentActivityProvider(pi)).not.toBeUndefined();
    handlers.get('session_shutdown')?.(); expect(getSubagentActivityProvider(pi)).toBeUndefined();
  });

  it('discovers a provider registered after a root consumer subscribes without stale replacement events', () => {
  const { pi } = makePi(); const received: Array<ActivityProvider | undefined> = []; const manager = { listLiveTasks: () => [], subscribeTaskUpdates: () => () => undefined };
  const unsubscribe = watchSubagentActivityProvider(pi, (provider) => received.push(provider)); expect(received).toEqual([undefined]);
  const disposeFirst = (registerSubagentActivityProvider as any)(pi, manager, { cwd: 'cwd-a', sessionId: 'session-a' }); const first = getSubagentActivityProvider(pi)!; expect(received).toEqual([undefined, first]);
  const disposeSecond = (registerSubagentActivityProvider as any)(pi, manager, { cwd: 'cwd-b', sessionId: 'session-b' }); const second = getSubagentActivityProvider(pi)!; expect(received).toEqual([undefined, first, second]);
  disposeFirst?.(); expect(received).toEqual([undefined, first, second]); disposeSecond?.(); expect(received).toEqual([undefined, first, second, undefined]); disposeSecond?.(); unsubscribe?.(); unsubscribe?.();
  (registerSubagentActivityProvider as any)(pi, manager, { cwd: 'cwd-c', sessionId: 'session-c' }); expect(received).toEqual([undefined, first, second, undefined]);
 });

 it('isolates discovery listener failures and cleans up Gentle-first reload and shutdown discovery', () => {
  const { pi, handlers } = makePi(); const received: Array<ActivityProvider | undefined> = []; const throwing = vi.fn(() => { throw new Error('observer failure'); });
  const stopThrowing = watchSubagentActivityProvider(pi, throwing); const stop = watchSubagentActivityProvider(pi, (provider) => received.push(provider)); expect(received).toEqual([undefined]);
  extension(pi); handlers.get('session_start')?.({}, { cwd: 'cwd-a', sessionId: 'session-a', ui: {} }); const first = getSubagentActivityProvider(pi)!; const firstManager = instances.at(-1)!;
  expect(received).toEqual([undefined, first]); extension(pi); expect(getSubagentActivityProvider(pi)).toBeUndefined(); expect(firstManager.listeners.size).toBe(0); expect(received.at(-1)).toBeUndefined();
  handlers.get('session_start')?.({}, { cwd: 'cwd-b', sessionId: 'session-b', ui: {} }); const second = getSubagentActivityProvider(pi)!; expect(received.at(-1)).toBe(second); handlers.get('session_shutdown')?.();
  expect(getSubagentActivityProvider(pi)).toBeUndefined(); expect(received.at(-1)).toBeUndefined(); expect(throwing).toHaveBeenCalled(); stop?.(); stop?.(); stopThrowing?.();
 });

 it('forwards real manager lifecycle events through the public seam', async () => {
    const { SubagentManager: RealManager } = await vi.importActual<typeof import('../src/manager.js')>('../src/manager.js');
    for (const name of ['completed', 'failed', 'cancelled', 'interrupted']) env.writeAgent(name);
    const runner: SubagentRunner = async ({ definition, onActivity, signal }) => {
      onActivity?.({ message: 'activity', live_activity: { trail: [], current: { kind: 'tool_running', label: 'safe activity', tool_names: ['read'] } } });
      if (definition.name === 'completed') return { result: 'done', model: 'mock/model' };
      if (definition.name === 'failed') throw new Error('failed');
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const manager = new RealManager(runner); const pi = makePi().pi;
    const dispose = (registerSubagentActivityProvider as any)(pi, manager, { cwd: env.tmp, sessionId: 'session-a' }); const provider = getSubagentActivityProvider(pi)!; const seen: any[] = [];
    provider.subscribe((snapshot) => seen.push(snapshot)); const ctx = { cwd: env.tmp, sessionId: 'session-a' };
    await manager.run({ agent: 'completed', task: 'done', mode: 'task' }, ctx); await manager.run({ agent: 'failed', task: 'fail', mode: 'task' }, ctx);
    const cancelled = await manager.run({ agent: 'cancelled', task: 'cancel', mode: 'background' }, ctx); await vi.waitFor(() => expect(manager.getTask(cancelled.task_ids[0]!)?.status).toBe('running')); manager.cancel(cancelled.task_ids[0]!, 'user request');
    const interrupted = await manager.run({ agent: 'interrupted', task: 'interrupt', mode: 'background' }, ctx); await vi.waitFor(() => expect(manager.getTask(interrupted.task_ids[0]!)?.status).toBe('running')); manager.cancel(interrupted.task_ids[0]!, 'Pi session shutdown');
    await vi.waitFor(() => expect(manager.getTask(interrupted.task_ids[0]!)?.status).toBe('interrupted'));
    const statuses = new Set(seen.flatMap((snapshot) => snapshot.tasks.map((entry: any) => entry.status)));
    expect(statuses).toEqual(new Set(['queued', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted']));
    expect(seen.some((snapshot) => snapshot.tasks.some((entry: any) => entry.activity?.kind === 'tool_running'))).toBe(true); expect(seen.at(-1)?.revision).toBeGreaterThan(0); dispose?.();
  });
});

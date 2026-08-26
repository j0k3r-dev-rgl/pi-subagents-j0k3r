import type { SubagentTask } from './types.js';

export const SUBAGENT_ACTIVITY_PROVIDER_VERSION = 1 as const;
export type SubagentActivityStatus = 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type SubagentActivityMode = 'task' | 'background';
export type SubagentActivityKind = 'thinking' | 'streaming_response' | 'tool_running' | 'tool_completed' | 'tool_failed';
export type SubagentActivityProfileSource = 'profile' | 'definition' | 'default' | 'orchestrator' | 'unresolved';
export type SubagentActivityEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SubagentActivityUsage = Readonly<Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number }>>;
export type SubagentActivity = Readonly<{ kind: SubagentActivityKind; tool_names?: readonly string[] }>;
export type SubagentActivityTask = Readonly<{
  id: string; agent: string; mode: SubagentActivityMode; status: SubagentActivityStatus;
  created_at?: string; started_at?: string; ended_at?: string; last_activity_at?: string;
  model?: string; effort?: SubagentActivityEffort; model_source?: SubagentActivityProfileSource; effort_source?: SubagentActivityProfileSource;
  usage?: SubagentActivityUsage; activity?: SubagentActivity;
}>;
export type SubagentActivitySnapshot = Readonly<{ version: typeof SUBAGENT_ACTIVITY_PROVIDER_VERSION; revision: number; tasks: readonly SubagentActivityTask[] }>;
export type SubagentActivityProvider = Readonly<{ version: typeof SUBAGENT_ACTIVITY_PROVIDER_VERSION; getSnapshot(): SubagentActivitySnapshot; subscribe(listener: (snapshot: SubagentActivitySnapshot) => void): () => void }>;
export type SubagentActivityScope = Readonly<{ cwd: string; sessionId: string }>;

type SubagentManagerActivitySource = {
  listLiveTasks(cwd: string, sessionId: string): readonly SubagentTask[];
  subscribeTaskUpdates(listener: (task: SubagentTask) => void): () => void;
};
type Registration = { provider: SubagentActivityProvider; dispose: () => void };
type PiHost = Record<PropertyKey, unknown>;
const REGISTRATION_KEY = Symbol.for('pi-subagents-j0k3r.activity-provider.v1');
const STATUSES = new Set<SubagentActivityStatus>(['queued', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted']);
const MODES = new Set<SubagentActivityMode>(['task', 'background']);
const KINDS = new Set<SubagentActivityKind>(['thinking', 'streaming_response', 'tool_running', 'tool_completed', 'tool_failed']);
const SOURCES = new Set<SubagentActivityProfileSource>(['profile', 'definition', 'default', 'orchestrator', 'unresolved']);
const EFFORTS = new Set<SubagentActivityEffort>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TERMINAL = new Set<SubagentActivityStatus>(['completed', 'failed', 'cancelled', 'interrupted']);
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'contextTokens', 'turns'] as const;

function hostFor(pi: unknown): PiHost | undefined { return pi && (typeof pi === 'object' || typeof pi === 'function') ? pi as PiHost : undefined; }
function safeText(value: unknown, limit: number): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined; }
function safeToken(value: unknown, limit: number): string | undefined { const text = safeText(value, limit); return text && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text) ? text : undefined; }
function safeTimestamp(value: unknown): string | undefined { const text = safeText(value, 64); return text && Number.isFinite(Date.parse(text)) ? text : undefined; }
function safeModel(value: unknown): string | undefined { const text = safeText(value, 256); return text && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(text) ? text : undefined; }
function copyUsage(value: unknown): SubagentActivityUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, number> = {};
  for (const field of USAGE_FIELDS) { const candidate = (value as Record<string, unknown>)[field]; if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) result[field] = candidate; }
  return Object.keys(result).length ? result as SubagentActivityUsage : undefined;
}
function copyActivity(value: unknown): SubagentActivity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const current = (value as { current?: unknown }).current;
  if (!current || typeof current !== 'object') return undefined;
  const kind = (current as { kind?: unknown }).kind as SubagentActivityKind;
  if (!KINDS.has(kind)) return undefined;
  const rawNames = (current as { tool_names?: unknown }).tool_names;
  const names = Array.isArray(rawNames) ? [...new Set(rawNames.map((name) => safeToken(name, 64)).filter((name): name is string => Boolean(name)))].slice(0, 8) : [];
  return names.length ? { kind, tool_names: names } : { kind };
}
function projectTask(task: SubagentTask): SubagentActivityTask | undefined {
  if (!STATUSES.has(task.status as SubagentActivityStatus) || !MODES.has(task.mode as SubagentActivityMode)) return undefined;
  const id = safeToken(task.id, 160); const agent = safeToken(task.agent, 128); if (!id || !agent) return undefined;
  const result: Record<string, unknown> = { id, agent, mode: task.mode, status: task.status };
  for (const [key, value] of [['created_at', task.created_at], ['started_at', task.started_at], ['ended_at', task.ended_at], ['last_activity_at', task.last_activity_at]] as const) { const date = safeTimestamp(value); if (date) result[key] = date; }
  const model = safeModel(task.model); if (model) result.model = model;
  if (EFFORTS.has(task.effort as SubagentActivityEffort)) result.effort = task.effort;
  if (SOURCES.has(task.model_source as SubagentActivityProfileSource)) result.model_source = task.model_source;
  if (SOURCES.has(task.effort_source as SubagentActivityProfileSource)) result.effort_source = task.effort_source;
  const usage = copyUsage(task.usage); if (usage) result.usage = usage;
  if (!TERMINAL.has(task.status as SubagentActivityStatus)) { const activity = copyActivity(task.live_activity); if (activity) result.activity = activity; }
  return result as SubagentActivityTask;
}
function freeze<T>(value: T): T { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const child of Object.values(value as Record<string, unknown>)) freeze(child); return Object.freeze(value); }
function makeSnapshot(manager: SubagentManagerActivitySource, scope: SubagentActivityScope, revision: number): SubagentActivitySnapshot { return freeze({ version: SUBAGENT_ACTIVITY_PROVIDER_VERSION, revision, tasks: manager.listLiveTasks(scope.cwd, scope.sessionId).map(projectTask).filter((task): task is SubagentActivityTask => Boolean(task)) }); }
function sameSnapshot(left: SubagentActivitySnapshot, right: SubagentActivitySnapshot): boolean { return left.version === right.version && JSON.stringify(left.tasks) === JSON.stringify(right.tasks); }
function createProvider(manager: SubagentManagerActivitySource, scope: SubagentActivityScope): Registration {
  let active = true; let revision = 0; let current = makeSnapshot(manager, scope, revision); const listeners = new Set<(snapshot: SubagentActivitySnapshot) => void>();
  const onManagerUpdate = () => {
    if (!active) return; const next = makeSnapshot(manager, scope, revision + 1); if (sameSnapshot(current, next)) return;
    revision += 1; current = next; for (const listener of [...listeners]) { try { listener(current); } catch { /* observers must not break delegation */ } }
  };
  const unsubscribeManager = manager.subscribeTaskUpdates(onManagerUpdate);
  const provider: SubagentActivityProvider = Object.freeze({
    version: SUBAGENT_ACTIVITY_PROVIDER_VERSION, getSnapshot: () => current,
    subscribe(listener) { if (!active) return () => undefined; let subscribed = true; listeners.add(listener); try { listener(current); } catch { /* keep subscription lifecycle deterministic */ } return () => { if (subscribed) { subscribed = false; listeners.delete(listener); } }; },
  });
  return { provider, dispose: () => { if (active) { active = false; listeners.clear(); unsubscribeManager(); } } };
}

export function disposeSubagentActivityProvider(pi: unknown): void { (hostFor(pi)?.[REGISTRATION_KEY] as Registration | undefined)?.dispose(); }
export function registerSubagentActivityProvider(pi: unknown, manager: SubagentManagerActivitySource, scope: SubagentActivityScope): (() => void) | undefined {
  const host = hostFor(pi); if (!host) return undefined; disposeSubagentActivityProvider(host);
  if (!scope || typeof scope.cwd !== 'string' || !scope.cwd || typeof scope.sessionId !== 'string' || !scope.sessionId || typeof manager?.listLiveTasks !== 'function' || typeof manager?.subscribeTaskUpdates !== 'function') return undefined;
  const created = createProvider(manager, scope); let registration: Registration;
  const dispose = () => { created.dispose(); if (host[REGISTRATION_KEY] === registration) delete host[REGISTRATION_KEY]; };
  registration = { provider: created.provider, dispose }; Object.defineProperty(host, REGISTRATION_KEY, { configurable: true, enumerable: false, value: registration, writable: true }); return dispose;
}
export function getSubagentActivityProvider(pi: unknown): SubagentActivityProvider | undefined { return (hostFor(pi)?.[REGISTRATION_KEY] as Registration | undefined)?.provider; }

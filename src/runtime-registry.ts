import { sendSubagentCompletionMessage } from './render/completion-message.js';
import type { SubagentManager } from './manager.js';
import type { SubagentTask } from './types.js';

export type RuntimeState = 'active' | 'reloading' | 'closing';
export type GenerationToken = symbol;

export interface RuntimeContextV1 {
  readonly cwd?: string;
  readonly sessionManager?: { getSessionId?: () => unknown };
  readonly [key: string]: unknown;
}

export interface RuntimePiV1 {
  sendMessage?: (...args: unknown[]) => unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeLinkV1 {
  readonly token: GenerationToken;
  readonly sessionId: string;
  readonly pi: RuntimePiV1;
  readonly ctx: RuntimeContextV1;
  readonly cwd: string;
}

export interface TerminalTaskDtoV1 {
  readonly version: 1;
  readonly kind: 'background-terminal';
  readonly sessionId: string;
  readonly cwd: string;
  readonly task: Readonly<{
    id: string;
    agent: string;
    status: string;
    mode: string;
    effective_mode?: string;
    model?: string;
    effort?: string;
    usage?: unknown;
    result?: string;
    error?: string;
    output_preview?: string;
    attempt: number;
    undelivered_message_count?: number;
    error_metadata?: unknown;
  }>;
}

type TerminalDeliveryRecordV1 =
  | { readonly key: string; state: 'queued'; readonly dto: TerminalTaskDtoV1; lastDeliveryToken?: GenerationToken }
  | { readonly key: string; state: 'delivering'; readonly dto: TerminalTaskDtoV1; deliveryToken: GenerationToken }
  | { readonly key: string; state: 'delivered' };

type LinkWaiter = {
  readonly resolve: (link: RuntimeLinkV1) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
};

export interface RuntimeManagerV1 {
  cancelRunning(reason?: string): unknown;
  awaitSettled(): Promise<void>;
}

export interface RuntimeEntryV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly manager: SubagentManager;
  state: RuntimeState;
  activeLink?: RuntimeLinkV1;
  generationToken?: GenerationToken;
  readonly terminalQueue: string[];
  readonly terminalDeliveries: Map<string, TerminalDeliveryRecordV1>;
  readonly linkWaiters: Set<LinkWaiter>;
  closePromise?: Promise<void>;
}

export interface RuntimeManagerAccessV1 {
  readonly version: 1;
  readonly sessionId: string;
  getState(): RuntimeState | 'closed';
  getActiveLink(): RuntimeLinkV1 | undefined;
  waitForActiveLink(signal?: AbortSignal): Promise<RuntimeLinkV1>;
}

export interface RuntimeResolutionV1 {
  readonly entry: RuntimeEntryV1;
  readonly manager: SubagentManager;
  readonly link: RuntimeLinkV1;
}

export type RuntimeManagerSourceV1 = RuntimeResolverV1 | SubagentManager;

export function resolveRuntimeManager(source: RuntimeManagerSourceV1, ctx: unknown): { manager: SubagentManager; link?: RuntimeLinkV1 } {
  const candidate = source as Partial<RuntimeResolverV1>;
  if (candidate.version === 1 && typeof candidate.resolve === 'function') return candidate.resolve(ctx);
  return { manager: source as SubagentManager };
}

export interface RuntimeResolverV1 {
  readonly version: 1;
  sessionId(ctx: unknown): string;
  resolve(ctx: unknown): RuntimeResolutionV1;
  resolveSession(sessionId: string): RuntimeResolutionV1;
}

interface RuntimeRegistryV1 {
  readonly version: 1;
  readonly entries: Map<string, RuntimeEntryV1>;
}

const RUNTIME_REGISTRY_SYMBOL = Symbol.for('pi-subagents-j0k3r.runtime-registry.v1');
const MISSING_SESSION_IDENTITY = 'Missing Pi session identity from ctx.sessionManager.getSessionId().';

type GlobalWithRuntimeRegistry = typeof globalThis & {
  [RUNTIME_REGISTRY_SYMBOL]?: RuntimeRegistryV1;
};

function runtimeRegistry(): RuntimeRegistryV1 {
  const root = globalThis as GlobalWithRuntimeRegistry;
  const existing = root[RUNTIME_REGISTRY_SYMBOL];
  if (existing) {
    if (existing.version !== 1 || !(existing.entries instanceof Map)) {
      throw new Error('Incompatible pi-subagents runtime registry version.');
    }
    return existing;
  }
  const created: RuntimeRegistryV1 = { version: 1, entries: new Map() };
  root[RUNTIME_REGISTRY_SYMBOL] = created;
  return created;
}

export function sessionIdFromContext(ctx: unknown): string {
  const candidate = ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined;
  const value = candidate?.sessionManager?.getSessionId?.();
  if (typeof value !== 'string' || value.length === 0) throw new Error(MISSING_SESSION_IDENTITY);
  return value;
}

function entryAccess(sessionId: string): RuntimeManagerAccessV1 {
  return {
    version: 1,
    sessionId,
    getState() {
      return runtimeRegistry().entries.get(sessionId)?.state ?? 'closed';
    },
    getActiveLink() {
      const entry = runtimeRegistry().entries.get(sessionId);
      return entry?.state === 'active' ? entry.activeLink : undefined;
    },
    waitForActiveLink(signal?: AbortSignal) {
      const entry = runtimeRegistry().entries.get(sessionId);
      if (!entry || entry.state === 'closing') return Promise.reject(new Error('Subagent session is closing.'));
      if (signal?.aborted) return Promise.reject(new Error('Subagent was aborted'));
      if (entry.state === 'active' && entry.activeLink) return Promise.resolve(entry.activeLink);
      return new Promise<RuntimeLinkV1>((resolve, reject) => {
        const waiter: LinkWaiter = { resolve, reject, signal };
        const onAbort = () => {
          entry.linkWaiters.delete(waiter);
          reject(new Error('Subagent was aborted'));
        };
        if (signal) {
          waiter.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        entry.linkWaiters.add(waiter);
      });
    },
  };
}

function settleWaiter(waiter: LinkWaiter): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
}

function wakeLinkWaiters(entry: RuntimeEntryV1, link: RuntimeLinkV1): void {
  for (const waiter of entry.linkWaiters) {
    entry.linkWaiters.delete(waiter);
    settleWaiter(waiter);
    waiter.resolve(link);
  }
}

function rejectLinkWaiters(entry: RuntimeEntryV1, error: Error): void {
  for (const waiter of entry.linkWaiters) {
    entry.linkWaiters.delete(waiter);
    settleWaiter(waiter);
    waiter.reject(error);
  }
}

function immutableCopy(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  const copy = structuredClone(value);
  const freeze = (candidate: unknown): unknown => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return candidate;
    for (const nested of Object.values(candidate as Record<string, unknown>)) freeze(nested);
    return Object.freeze(candidate);
  };
  return freeze(copy);
}

function terminalDto(sessionId: string, task: SubagentTask, cwd: string): TerminalTaskDtoV1 {
  const taskDto = Object.freeze({
    id: task.id,
    agent: task.agent,
    status: task.status,
    mode: task.mode,
    effective_mode: task.effective_mode,
    model: task.model,
    effort: task.effort,
    usage: immutableCopy(task.usage),
    result: task.result,
    error: task.error,
    output_preview: task.output_preview,
    attempt: task.attempt ?? 1,
    undelivered_message_count: task.undelivered_message_count,
    error_metadata: immutableCopy(task.error_metadata),
  });
  return Object.freeze({ version: 1, kind: 'background-terminal', sessionId, cwd, task: taskDto });
}

function terminalKey(dto: TerminalTaskDtoV1): string {
  return JSON.stringify([dto.sessionId, dto.task.id, dto.task.attempt, dto.kind]);
}

async function drainTerminalQueue(entry: RuntimeEntryV1, token: GenerationToken): Promise<void> {
  while (entry.state === 'active' && entry.activeLink?.token === token) {
    const key = entry.terminalQueue.find((candidate) => {
      const record = entry.terminalDeliveries.get(candidate);
      return record?.state === 'queued' && record.lastDeliveryToken !== token;
    });
    if (!key) return;
    const record = entry.terminalDeliveries.get(key);
    if (!record || record.state !== 'queued') continue;
    const delivering: TerminalDeliveryRecordV1 = { key, state: 'delivering', dto: record.dto, deliveryToken: token };
    entry.terminalDeliveries.set(key, delivering);
    try {
      sendSubagentCompletionMessage(entry.activeLink.pi, delivering.dto.task, delivering.dto.cwd);
      entry.terminalDeliveries.set(key, { key, state: 'delivered' });
      const index = entry.terminalQueue.indexOf(key);
      if (index >= 0) entry.terminalQueue.splice(index, 1);
    } catch {
      entry.terminalDeliveries.set(key, { key, state: 'queued', dto: delivering.dto, lastDeliveryToken: token });
      if (entry.activeLink?.token !== token && entry.state === 'active') {
        void drainTerminalQueue(entry, entry.activeLink.token);
      }
      return;
    }
  }
}

export function getRuntimeResolver(): RuntimeResolverV1 {
  runtimeRegistry();
  return {
    version: 1,
    sessionId: sessionIdFromContext,
    resolve(ctx: unknown) {
      return this.resolveSession(sessionIdFromContext(ctx));
    },
    resolveSession(sessionId: string) {
      const entry = runtimeRegistry().entries.get(sessionId);
      if (!entry || entry.state !== 'active' || !entry.activeLink) throw new Error(`No active subagent runtime for Pi session ${sessionId}.`);
      return { entry, manager: entry.manager, link: entry.activeLink };
    },
  };
}

export function bindSessionGeneration(input: {
  sessionId: string;
  token: GenerationToken;
  pi: RuntimePiV1;
  ctx: RuntimeContextV1;
  cwd: string;
  createManager: (access: RuntimeManagerAccessV1) => SubagentManager;
}): { entry: RuntimeEntryV1; created: boolean; link: RuntimeLinkV1 } {
  const registry = runtimeRegistry();
  let entry = registry.entries.get(input.sessionId);
  let created = false;
  if (!entry) {
    const manager = input.createManager(entryAccess(input.sessionId));
    entry = {
      version: 1,
      sessionId: input.sessionId,
      manager,
      state: 'active',
      terminalQueue: [],
      terminalDeliveries: new Map(),
      linkWaiters: new Set(),
    };
    registry.entries.set(input.sessionId, entry);
    created = true;
  } else if (entry.version !== 1) {
    throw new Error('Incompatible pi-subagents runtime entry version.');
  } else if (entry.state === 'closing') {
    throw new Error('Subagent session is closing.');
  }
  const link: RuntimeLinkV1 = Object.freeze({ token: input.token, sessionId: input.sessionId, pi: input.pi, ctx: input.ctx, cwd: input.cwd });
  entry.activeLink = link;
  entry.generationToken = input.token;
  entry.state = 'active';
  wakeLinkWaiters(entry, link);
  void drainTerminalQueue(entry, input.token);
  return { entry, created, link };
}

export function ownsGeneration(entry: RuntimeEntryV1, sessionId: string, token: GenerationToken): boolean {
  return runtimeRegistry().entries.get(sessionId) === entry && entry.sessionId === sessionId && entry.generationToken === token;
}

export function markReloading(entry: RuntimeEntryV1, sessionId: string, token: GenerationToken): boolean {
  if (!ownsGeneration(entry, sessionId, token) || entry.state === 'closing') return false;
  entry.state = 'reloading';
  if (entry.activeLink?.token === token) delete entry.activeLink;
  return true;
}

export function enqueueOrDeliverTerminal(entry: RuntimeEntryV1, task: SubagentTask, cwd: string): void {
  if (entry.state === 'closing' || task.session_id !== entry.sessionId) return;
  const dto = terminalDto(entry.sessionId, task, cwd);
  const key = terminalKey(dto);
  if (entry.terminalDeliveries.has(key)) return;
  entry.terminalDeliveries.set(key, { key, state: 'queued', dto });
  entry.terminalQueue.push(key);
  if (entry.state === 'active' && entry.activeLink) void drainTerminalQueue(entry, entry.activeLink.token);
}

export function beginClosing(entry: RuntimeEntryV1, sessionId: string, token: GenerationToken, reason: string): Promise<void> {
  if (!ownsGeneration(entry, sessionId, token)) return Promise.resolve();
  if (entry.closePromise) return entry.closePromise;
  entry.state = 'closing';
  if (entry.activeLink?.token === token) delete entry.activeLink;
  rejectLinkWaiters(entry, new Error('Subagent session is closing.'));
  entry.terminalQueue.length = 0;
  entry.terminalDeliveries.clear();
  const registry = runtimeRegistry();
  const manager = entry.manager as unknown as RuntimeManagerV1;
  let resolveClose: (() => void) | undefined;
  let rejectClose: ((error: unknown) => void) | undefined;
  entry.closePromise = new Promise<void>((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });
  try {
    manager.cancelRunning(`Pi session shutdown: ${reason}`);
    void manager.awaitSettled().then(() => {
      if (registry.entries.get(sessionId) === entry) registry.entries.delete(sessionId);
      resolveClose?.();
    }, (error: unknown) => rejectClose?.(error));
  } catch (error) {
    rejectClose?.(error);
  }
  return entry.closePromise;
}

export function getRuntimeEntryForTests(sessionId: string): RuntimeEntryV1 | undefined {
  return runtimeRegistry().entries.get(sessionId);
}

export function resetRuntimeRegistryForTests(): void {
  runtimeRegistry().entries.clear();
}

import { randomUUID } from 'node:crypto';
import { loadSubagents, readSubagentsConfig } from './config.js';
import { writeSubagentsDebugLog } from './debug.js';
import { sdkSubagentRunner } from './runner.js';
import { SubagentHistoryStore } from './history.js';
import { publishInteractionResponse, sanitizeInteractionTransportText } from './interaction-channel.js';
import { resolveEffectiveSubagentProfile } from './profile-resolver.js';
import { resolveCurrentSessionId } from './session-id.js';
import type { SubagentInteractionRequest, SubagentInteractionResponse } from './interaction-channel.js';
import type { ModelRef, SubagentDefinition, SubagentRunInput, SubagentsConfig, SubagentRunner, SubagentTask } from './types.js';

function nowIso(): string { return new Date().toISOString(); }
function taskId(agent: string): string { return `subtask_${agent}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`; }
function subagentAuditLog(cwd: string | undefined, event: string, data: Record<string, unknown>): void {
  writeSubagentsDebugLog(cwd, event, data);
}

function interactionLogFields(request: SubagentInteractionRequest | undefined): Record<string, unknown> {
  if (!request) return { hasInteractionRequest: false };
  return {
    hasInteractionRequest: true,
    requestId: request.requestId,
    kind: request.kind,
    origin: request.origin,
    reasonCode: request.reasonCode,
    riskLevel: request.riskLevel,
    requester: request.requester,
    hasPrompt: Boolean(request.prompt),
    hasPayload: request.payload !== undefined,
  };
}

function compactOutput(text: string, limit = 800): string {
  const normalized = sanitizeInteractionTransportText(text).replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `…${normalized.slice(-limit)}` : normalized;
}

function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
  return candidate.code === 'ERR_SQLITE_ERROR'
    && (candidate.errcode === 5 || candidate.errstr === 'database is locked' || candidate.message === 'database is locked');
}

function modelRefLabel(model: ModelRef | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function sanitizeUnknown<T>(value: T): T {
  if (typeof value === 'string') return sanitizeInteractionTransportText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeUnknown(entry)])) as T;
}

function interactionPromptMessage(request: SubagentInteractionRequest): string {
  const prompt = request.prompt ?? {};
  const lines = [prompt.title ?? `Subagent interaction: ${request.kind}`, '', prompt.message ?? request.reason ?? 'A subagent requested main-thread interaction.'];
  const requester = request.requester?.subagentName ?? request.requester?.subagentId;
  if (requester) lines.push('', `Requested by: ${requester}`);
  if (prompt.safeTarget) lines.push('', `Target: ${prompt.safeTarget}`);
  if (prompt.safeCommandSummary) lines.push('', `Command: ${prompt.safeCommandSummary}`);
  if (prompt.workspaceRoot) lines.push('', `Workspace: ${prompt.workspaceRoot}`);
  if (prompt.limitations?.length) lines.push('', ...prompt.limitations);
  if (request.payload !== undefined) lines.push('', 'Payload:', JSON.stringify(request.payload, null, 2));
  if (request.response?.instructions) lines.push('', 'Expected response:', request.response.instructions);
  return lines.join('\n');
}

function editorInitialValue(request: SubagentInteractionRequest): string {
  return JSON.stringify({
    kind: request.kind,
    prompt: request.prompt,
    payload: request.payload,
    response: request.response,
  }, null, 2);
}

function parseEditorResponse(raw: string, request: SubagentInteractionRequest): unknown {
  if (request.response?.expected === 'json') return JSON.parse(raw);
  return raw;
}

async function promptMainThreadForInteraction(ctx: any, request: SubagentInteractionRequest): Promise<SubagentInteractionResponse> {
  const prompt = request.prompt ?? {};
  const message = interactionPromptMessage(request);
  const choices = Array.isArray(prompt.choices) ? prompt.choices.filter((choice): choice is string => typeof choice === 'string') : [];

  if (choices.length && typeof ctx?.ui?.select === 'function') {
    const value = await ctx.ui.select(message, choices);
    return { type: 'interaction_response', requestId: request.requestId, status: value === undefined ? 'cancelled' : 'answered', value };
  }

  if (request.kind === 'confirm' && typeof ctx?.ui?.confirm === 'function') {
    const value = await ctx.ui.confirm(prompt.title ?? 'Subagent interaction', message);
    return { type: 'interaction_response', requestId: request.requestId, status: 'answered', value: Boolean(value) };
  }

  if (request.kind === 'input' && typeof ctx?.ui?.input === 'function') {
    const value = await ctx.ui.input(message, prompt.placeholder ?? prompt.defaultValue ?? '');
    return { type: 'interaction_response', requestId: request.requestId, status: value === undefined ? 'cancelled' : 'answered', value };
  }

  if (typeof ctx?.ui?.editor === 'function') {
    try {
      const value = await ctx.ui.editor(message, editorInitialValue(request));
      if (value === undefined) return { type: 'interaction_response', requestId: request.requestId, status: 'cancelled' };
      return { type: 'interaction_response', requestId: request.requestId, status: 'answered', value: parseEditorResponse(value, request) };
    } catch (error) {
      return { type: 'interaction_response', requestId: request.requestId, status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  throw new Error(`Subagent interaction ${request.requestId} (${request.kind}) requires main-thread UI support for select, confirm, input, or editor.`);
}

function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    async acquire() {
      if (active < max) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => queue.push(resolve));
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      queue.shift()?.();
    },
  };
}

const ACTIVITY_RECORD_FLUSH_MS = 250;
const ACTIVITY_UPDATE_FLUSH_MS = 150;
const SESSION_TASK_CACHE_MS = 1500;

type PendingRecord = { cwd: string; task: SubagentTask; activity: string; timer: NodeJS.Timeout };

export class SubagentManager {
  private tasks = new Map<string, SubagentTask>();
  private taskCwds = new Map<string, string>();
  private controllers = new Map<string, AbortController>();
  private limiters = new Map<string, ReturnType<typeof createLimiter>>();
  private pendingRecords = new Map<string, PendingRecord>();
  private pendingUpdates = new Map<string, NodeJS.Timeout>();
  private sessionTaskCache = new Map<string, { expiresAt: number; tasks: SubagentTask[] }>();

  constructor(
    private runner: SubagentRunner = sdkSubagentRunner,
    private history = new SubagentHistoryStore(),
    private onTerminalBackgroundTask?: (task: SubagentTask) => void,
  ) {}

  listAgents(cwd: string) {
    return loadSubagents(cwd).map((a) => ({ name: a.name, description: a.description, filePath: a.filePath, tools: a.tools, model: a.model, effort: a.effort }));
  }

  listTasks(cwd?: string) {
    const active = [...this.tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!cwd) return active;
    const activeIds = new Set(active.map((task) => task.id));
    const persisted = this.history.listTasks(cwd).filter((task) => !activeIds.has(task.id));
    return [...active, ...persisted].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  listSessionTasks(cwd?: string, sessionId?: string) {
    const active = [...this.tasks.values()]
      .filter((task) => (!cwd || this.taskCwds.get(task.id) === cwd) && (!sessionId || task.session_id === sessionId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!cwd || !sessionId) return active;
    const activeIds = new Set(active.map((task) => task.id));
    const persisted = this.cachedPersistedSessionTasks(cwd, sessionId).filter((task) => !activeIds.has(task.id));
    return [...active, ...persisted].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getTask(id: string, cwd?: string) {
    return this.tasks.get(id) ?? (cwd ? this.history.getTask(cwd, id) : undefined);
  }

  cancelRunning(reason = 'cancelled'): SubagentTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.status === 'queued' || task.status === 'running')
      .map((task) => this.cancel(task.id, reason));
  }

  sendToBackground(ids: string[]): SubagentTask[] {
    const changed: SubagentTask[] = [];
    for (const id of ids) {
      const task = this.tasks.get(id);
      const cwd = this.taskCwds.get(id);
      if (!task || !cwd) continue;
      if (task.mode === 'background') continue;
      if (task.status !== 'queued' && task.status !== 'running') continue;
      task.mode = 'background';
      this.record(cwd, task, task.last_activity ?? 'running', true);
      changed.push(task);
    }
    return changed;
  }

  hasRunning(): boolean {
    return [...this.tasks.values()].some((task) => task.status === 'queued' || task.status === 'running');
  }

  private limiter(cwd: string, maxConcurrency: number): ReturnType<typeof createLimiter> {
    const key = `${cwd}:${maxConcurrency}`;
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = createLimiter(maxConcurrency);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  async run(
    input: SubagentRunInput,
    ctx: any,
    parentSignal?: AbortSignal,
    onTaskUpdate?: (tasks: SubagentTask[]) => void,
  ): Promise<{ mode: 'task' | 'background'; task_ids: string[]; results?: SubagentTask[] }> {
    const cwd = ctx?.cwd ?? process.cwd();
    const agents = input.agents?.length ? input.agents : input.agent ? [input.agent] : [];
    if (!agents.length) throw new Error('subagent_run requires agent or agents.');
    const mode = input.mode ?? 'task';
    const config = readSubagentsConfig(cwd);
    const definitions = new Map(loadSubagents(cwd).map((definition) => [definition.name, definition]));
    const limiter = this.limiter(cwd, config.max_concurrency);
    let ids: string[] = [];
    const notifyUpdate = () => onTaskUpdate?.(ids.map((id) => this.tasks.get(id)!).filter(Boolean));
    ids = agents.map((agent) => {
      const definition = definitions.get(agent.toLowerCase());
      if (!definition) throw new Error(`Subagent not found: ${agent}`);
      return this.startOne(definition, input.task, input.context, mode, ctx, config, parentSignal, notifyUpdate, limiter);
    });
    notifyUpdate();
    if (mode === 'background') return { mode, task_ids: ids };
    await Promise.all(ids.map((id) => this.wait(id)));
    if (parentSignal?.aborted) throw new Error('Subagent run aborted');
    return { mode, task_ids: ids, results: ids.map((id) => this.tasks.get(id)!) };
  }

  cancel(id: string, reason = 'cancelled'): SubagentTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Subagent task not found: ${id}`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task;
    this.controllers.get(id)?.abort();
    task.status = 'cancelled';
    task.last_activity = task.output_preview ? `${reason}; partial output preserved` : reason;
    task.last_activity_at = nowIso();
    task.ended_at = task.last_activity_at;
    const cwd = this.taskCwds.get(id);
    if (cwd) this.record(cwd, task, task.last_activity, true);
    return task;
  }

  private startOne(
    definition: SubagentDefinition,
    taskText: string,
    context: string | undefined,
    mode: 'task' | 'background',
    ctx: any,
    config: SubagentsConfig,
    parentSignal?: AbortSignal,
    onTaskUpdate?: () => void,
    limiter = createLimiter(1),
  ): string {
    const cwd = ctx?.cwd ?? process.cwd();
    const session_id = resolveCurrentSessionId(ctx);
    const effectiveProfile = resolveEffectiveSubagentProfile({ agentName: definition.name, definition, config, ctx });
    const id = taskId(definition.name);
    const controller = new AbortController();
    const task: SubagentTask = {
      id,
      agent: definition.name,
      mode,
      status: 'queued',
      task: taskText,
      context,
      model: modelRefLabel(effectiveProfile.model.value),
      effort: effectiveProfile.effort.value,
      model_source: effectiveProfile.model.source,
      effort_source: effectiveProfile.effort.source,
      created_at: nowIso(),
      session_id,
      last_activity_at: nowIso(),
      last_activity: 'queued',
    };
    this.tasks.set(id, task);
    this.taskCwds.set(id, cwd);
    this.controllers.set(id, controller);
    const abortFromParent = () => this.cancel(id, 'cancelled by parent abort');
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    this.record(cwd, task, 'queued', true);
    this.notifyTaskUpdate(id, onTaskUpdate, true);

    const run = async () => {
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      let acquired = false;
      try {
        await limiter.acquire();
        acquired = true;
        if (controller.signal.aborted) return;
        task.status = 'running';
        task.started_at = nowIso();
        task.last_activity_at = task.started_at;
        task.last_activity = 'started';
        this.record(cwd, task, 'started', true);
        this.notifyTaskUpdate(id, onTaskUpdate, true);
        let interactionsHandled = 0;
        let result: Awaited<ReturnType<SubagentRunner>> | undefined;
        while (true) {
          const runnerPromise = this.runner({
            definition,
            task: taskText,
            taskId: id,
            parentPiSessionId: session_id,
            context,
            cwd,
            ctx,
            config,
            signal: controller.signal,
            effectiveProfile,
            onActivity: (activity) => {
              task.last_activity_at = nowIso();
              task.last_activity = activity.message;
              if (activity.output) task.output_preview = compactOutput(activity.output);
              if (activity.prompt) task.prompt = sanitizeInteractionTransportText(activity.prompt);
              if (activity.system_prompt) task.system_prompt = sanitizeInteractionTransportText(activity.system_prompt);
              if (activity.transcript) task.transcript = sanitizeInteractionTransportText(activity.transcript);
              if (activity.usage) task.usage = activity.usage;
              if (activity.effort) task.effort = activity.effort;
              if (activity.thread_snapshot) task.thread_snapshot = sanitizeUnknown(activity.thread_snapshot);
              if (activity.interaction_request) task.interaction_request = activity.interaction_request;
              const importantActivity = activity.message === 'interaction required'
                || Boolean(activity.interaction_request)
                || (Boolean(activity.thread_snapshot) && !activity.message.startsWith('streaming '));
              this.record(cwd, task, activity.message, importantActivity);
              this.notifyTaskUpdate(id, onTaskUpdate, importantActivity);
            },
          });
          runnerPromise.catch(() => {});
          const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error(`timed out after ${config.timeout_ms}ms`));
            }, config.timeout_ms);
          });
          const abortPromise = new Promise<never>((_resolve, reject) => {
            if (controller.signal.aborted) reject(new Error('Subagent was aborted'));
            else controller.signal.addEventListener('abort', () => reject(new Error('Subagent was aborted')), { once: true });
          });
          result = await Promise.race([runnerPromise, timeoutPromise, abortPromise]);
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          if ((task as SubagentTask).status === 'cancelled') return;

          const interactionRequest = result.interaction_request;
          if (!interactionRequest) break;
          subagentAuditLog(cwd, 'interaction_bridge_request_detected', { taskId: id, agent: definition.name, ...interactionLogFields(interactionRequest) });
          if (task.mode === 'background') {
            subagentAuditLog(cwd, 'interaction_bridge_background_blocked', { taskId: id, agent: definition.name, ...interactionLogFields(interactionRequest) });
            throw new Error('Subagent interaction requires main-thread handling; rerun in task mode to answer it.');
          }
          interactionsHandled += 1;
          if (interactionsHandled > 5) throw new Error('Subagent interaction retry limit exceeded.');

          task.result = sanitizeInteractionTransportText(result.result);
          task.output_preview = compactOutput(result.result);
          task.transcript = sanitizeInteractionTransportText(`${task.transcript ?? ''}\n\n# interaction request surfaced to orchestrator\n\n${result.result}`.trim());
          task.last_activity = 'interaction required; awaiting main-thread response';
          task.last_activity_at = nowIso();
          task.usage = result.usage ?? task.usage;
          if (result.system_prompt ?? task.system_prompt) task.system_prompt = sanitizeInteractionTransportText(result.system_prompt ?? task.system_prompt!);
          task.model = result.model;
          task.effort = result.effort ?? task.effort;
          task.fallback_used = result.fallback_used;
          if (result.thread_snapshot) task.thread_snapshot = sanitizeUnknown(result.thread_snapshot);
          task.interaction_request = interactionRequest;
          this.record(cwd, task, task.last_activity, true);
          this.notifyTaskUpdate(id, onTaskUpdate, true);

          subagentAuditLog(cwd, 'interaction_bridge_prompt_main_thread', { taskId: id, agent: definition.name, ...interactionLogFields(interactionRequest) });
          const response = publishInteractionResponse(await promptMainThreadForInteraction(ctx, interactionRequest));
          subagentAuditLog(cwd, 'interaction_bridge_user_response', { taskId: id, agent: definition.name, requestId: interactionRequest.requestId, status: response.status });
          if (response.status === 'cancelled') throw new Error(`Subagent interaction cancelled by main user: ${interactionRequest.requestId}`);
          if (response.status === 'failed') throw new Error(`Subagent interaction failed: ${response.error ?? interactionRequest.requestId}`);
          task.last_activity = `interaction answered by main user; retrying subagent`;
          delete task.interaction_request;
          task.last_activity_at = nowIso();
          this.record(cwd, task, task.last_activity, true);
          this.notifyTaskUpdate(id, onTaskUpdate, true);
        }

        if (!result) throw new Error('Subagent finished without a result.');
        const finalResult = sanitizeInteractionTransportText(result.result ?? '');
        if (!finalResult.trim()) throw new Error('Subagent finished without a final response.');
        task.status = 'completed';
        task.result = finalResult;
        task.output_preview = compactOutput(finalResult);
        task.transcript = sanitizeInteractionTransportText(`${task.transcript ?? ''}\n\n# response sent to orchestrator\n\n${finalResult}`.trim());
        task.last_activity = 'completed';
        task.last_activity_at = nowIso();
        task.usage = result.usage ?? task.usage;
        if (result.system_prompt ?? task.system_prompt) task.system_prompt = sanitizeInteractionTransportText(result.system_prompt ?? task.system_prompt!);
        task.model = result.model;
        task.effort = result.effort ?? task.effort;
        task.fallback_used = result.fallback_used;
        if (result.thread_snapshot) task.thread_snapshot = sanitizeUnknown(result.thread_snapshot);
        delete task.interaction_request;
        task.ended_at = task.last_activity_at;
        this.record(cwd, task, 'completed', true);
        this.notifyTaskUpdate(id, onTaskUpdate, true);
        if (task.mode === 'background') {
          ctx?.ui?.notify?.(`Subagent ${definition.name} completed: ${id}`, 'info');
          this.onTerminalBackgroundTask?.(task);
        }
      } catch (error) {
        if ((task as SubagentTask).status === 'cancelled') return;
        task.status = 'failed';
        task.error = timedOut ? `timed out after ${config.timeout_ms}ms` : error instanceof Error ? error.message : String(error);
        task.last_activity = `failed: ${task.error}`;
        task.last_activity_at = nowIso();
        task.ended_at = task.last_activity_at;
        this.record(cwd, task, task.last_activity, true);
        this.notifyTaskUpdate(id, onTaskUpdate, true);
        ctx?.ui?.notify?.(`Subagent ${definition.name} failed: ${task.error}`, 'warning');
        if (task.mode === 'background') this.onTerminalBackgroundTask?.(task);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (acquired) limiter.release();
        parentSignal?.removeEventListener('abort', abortFromParent);
        this.controllers.delete(id);
      }
    };
    void run();
    return id;
  }

  private cachedPersistedSessionTasks(cwd: string, sessionId: string): SubagentTask[] {
    const key = `${cwd}\0${sessionId}`;
    const cached = this.sessionTaskCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.tasks;
    try {
      const tasks = this.history.listSessionTasks(cwd, sessionId, 100, { includeSnapshots: false });
      this.sessionTaskCache.set(key, { expiresAt: Date.now() + SESSION_TASK_CACHE_MS, tasks });
      return tasks;
    } catch (error) {
      if (isSqliteBusyError(error)) return cached?.tasks ?? [];
      throw error;
    }
  }

  private invalidateSessionTaskCache(cwd: string, task: SubagentTask): void {
    if (task.session_id) this.sessionTaskCache.delete(`${cwd}\0${task.session_id}`);
  }

  private record(cwd: string, task: SubagentTask, activity: string, immediate = false): void {
    if (immediate) {
      this.flushRecord(task.id);
      this.recordNow(cwd, task, activity);
      return;
    }
    const pending = this.pendingRecords.get(task.id);
    if (pending) {
      pending.cwd = cwd;
      pending.task = task;
      pending.activity = activity;
      return;
    }
    const timer = setTimeout(() => this.flushRecord(task.id), ACTIVITY_RECORD_FLUSH_MS);
    timer.unref?.();
    this.pendingRecords.set(task.id, { cwd, task, activity, timer });
  }

  private flushRecord(taskId: string): void {
    const pending = this.pendingRecords.get(taskId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRecords.delete(taskId);
    this.recordNow(pending.cwd, pending.task, pending.activity);
  }

  private recordNow(cwd: string, task: SubagentTask, activity: string): void {
    try {
      this.invalidateSessionTaskCache(cwd, task);
      this.history.upsertTask(cwd, task);
      this.history.addEvent(cwd, task, activity);
    } catch {
      // History should never break delegation.
    }
  }

  private notifyTaskUpdate(taskId: string, onTaskUpdate: (() => void) | undefined, immediate = false): void {
    if (!onTaskUpdate) return;
    if (immediate) {
      const pending = this.pendingUpdates.get(taskId);
      if (pending) clearTimeout(pending);
      this.pendingUpdates.delete(taskId);
      onTaskUpdate();
      return;
    }
    if (this.pendingUpdates.has(taskId)) return;
    const timer = setTimeout(() => {
      this.pendingUpdates.delete(taskId);
      onTaskUpdate();
    }, ACTIVITY_UPDATE_FLUSH_MS);
    timer.unref?.();
    this.pendingUpdates.set(taskId, timer);
  }

  private async wait(id: string): Promise<void> {
    while (true) {
      const task = this.tasks.get(id);
      if (!task) throw new Error(`Subagent task not found: ${id}`);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

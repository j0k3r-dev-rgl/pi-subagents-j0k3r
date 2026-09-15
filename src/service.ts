import { describeAgentDefinition } from './capabilities.js';
import type { SubagentManager } from './manager.js';
import type {
  SubagentErrorCategory,
  SubagentMode,
  SubagentStatus,
  SubagentTask,
  ThinkingEffort,
  UsageStats,
} from './types.js';

/**
 * Stable version of the cross-extension subagent service contract.
 *
 * This is intentionally independent of the npm package version: release and
 * source-manifest versions can drift, but consumers negotiate compatibility
 * against this API version (ADR-003).
 */
export const SUBAGENTS_SERVICE_API_VERSION = 1 as const;

/** Namespaced, versioned process-local publication slot (ADR-002). */
const SERVICE_SLOT_KEY = 'pi-subagents-j0k3r.subagents-service/v1';
const SERVICE_SLOT = Symbol.for(SERVICE_SLOT_KEY);

export interface SubagentsServiceRunInputV1 {
  /** Name of a markdown-defined subagent (case-insensitive, as with subagent_run). */
  agent: string;
  /** Task prompt delegated to the named agent. */
  task: string;
  /** Optional additional context forwarded to the child session. */
  context?: string;
  /**
   * Execution mode. Defaults to 'task' (wait for completion).
   * 'background' launches without waiting and keeps j0k3r's existing
   * background completion notification behavior (ADR-006).
   */
  mode?: SubagentMode;
  /** Optional short display label for history/UI surfaces. */
  displayName?: string;
}

export interface SubagentsServiceRunOptionsV1 {
  /** Caller abort signal; aborts the delegated run through the live manager. */
  signal?: AbortSignal;
  /** Bounded by-value task snapshots emitted as the run progresses. */
  onUpdate?: (tasks: readonly SubagentTaskSnapshotV1[]) => void;
}

/**
 * Bounded by-value public task snapshot (ADR-004).
 *
 * Only consumer-useful state is admitted. Internal manager objects, abort
 * controllers, prompts, transcripts, thread snapshots, nested-session paths,
 * live bridges, and interaction requests are never exposed in V1.
 */
export interface SubagentTaskSnapshotV1 {
  id: string;
  agent: string;
  display_name?: string;
  mode: SubagentMode;
  effective_mode?: SubagentMode;
  status: SubagentStatus;
  task: string;
  context?: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  last_activity?: string;
  last_activity_at?: string;
  output_preview?: string;
  usage?: UsageStats;
  model?: string;
  effort?: ThinkingEffort;
  attempt?: number;
  result?: string;
  error?: string;
  error_category?: SubagentErrorCategory;
  retryable?: boolean;
  pending_message_count?: number;
  undelivered_message_count?: number;
}

/**
 * Narrow V1 facade over the live SubagentManager (ADR-001).
 *
 * The service never exposes the manager itself and never accepts per-call
 * tool/model overrides: the named agent definition plus j0k3r configuration
 * remain the authority for model, effort, mode, and tool policy (ADR-005).
 */
/**
 * Policy-aligned capability descriptor for a named agent (ADR-005).
 * `effectiveTools` is resolved by the exact logic that prepares the actual
 * child allowlist: defaults, wildcard expansion against active parent
 * tools, and blocked `subagent_*` removal. Declared-but-inactive
 * extension tools are not reported.
 */
export interface SubagentAgentDescriptorV1 {
  name: string;
  description: string;
  scope?: 'global' | 'project';
  declaredTools: readonly string[];
  effectiveTools: readonly string[];
  model?: string;
  effort?: string;
  defaultMode: SubagentMode;
}

export interface SubagentsServiceV1 {
  readonly apiVersion: 1;
  describeAgent(
    name: string,
    ctx: any,
  ): SubagentAgentDescriptorV1 | undefined;
  run(
    input: SubagentsServiceRunInputV1,
    ctx: any,
    options?: SubagentsServiceRunOptionsV1,
  ): Promise<SubagentTaskSnapshotV1>;
  getTask(id: string, cwd?: string): SubagentTaskSnapshotV1 | undefined;
  cancel(id: string, reason?: string): SubagentTaskSnapshotV1 | undefined;
}

/** Map an internal task to its admitted public snapshot (by value). */
export function toTaskSnapshotV1(task: SubagentTask): SubagentTaskSnapshotV1 {
  const snapshot: SubagentTaskSnapshotV1 = {
    id: task.id,
    agent: task.agent,
    mode: task.mode,
    status: task.status,
    task: task.task,
    created_at: task.created_at,
  };
  if (task.display_name !== undefined) snapshot.display_name = task.display_name;
  if (task.effective_mode !== undefined) snapshot.effective_mode = task.effective_mode;
  if (task.context !== undefined) snapshot.context = task.context;
  if (task.started_at !== undefined) snapshot.started_at = task.started_at;
  if (task.ended_at !== undefined) snapshot.ended_at = task.ended_at;
  if (task.last_activity !== undefined) snapshot.last_activity = task.last_activity;
  if (task.last_activity_at !== undefined) snapshot.last_activity_at = task.last_activity_at;
  if (task.output_preview !== undefined) snapshot.output_preview = task.output_preview;
  if (task.usage !== undefined) snapshot.usage = { ...task.usage };
  if (task.model !== undefined) snapshot.model = task.model;
  if (task.effort !== undefined) snapshot.effort = task.effort;
  if (task.attempt !== undefined) snapshot.attempt = task.attempt;
  if (task.result !== undefined) snapshot.result = task.result;
  if (task.error !== undefined) snapshot.error = task.error;
  if (task.error_metadata !== undefined) {
    snapshot.error_category = task.error_metadata.category;
    snapshot.retryable = task.error_metadata.retryable;
  }
  if (task.pending_message_count !== undefined) snapshot.pending_message_count = task.pending_message_count;
  if (task.undelivered_message_count !== undefined) snapshot.undelivered_message_count = task.undelivered_message_count;
  return snapshot;
}

/**
 * Create a V1 service facade backed by exactly the given live manager.
 * The caller (the extension) retains ownership of the manager; the facade
 * only delegates to existing manager execution so concurrency, history,
 * runner, and tool-policy semantics are unchanged.
 */
export function createSubagentsService(manager: SubagentManager): SubagentsServiceV1 {
  return {
    apiVersion: SUBAGENTS_SERVICE_API_VERSION,
    describeAgent(name: string, ctx: any) {
      return describeAgentDefinition(name, ctx) ?? undefined;
    },
    async run(input: SubagentsServiceRunInputV1, ctx: any, options: SubagentsServiceRunOptionsV1 = {}) {
      const agent = input?.agent?.trim();
      if (!agent) throw new Error('SubagentsServiceV1.run requires a named agent.');
      if (!input?.task?.trim()) throw new Error('SubagentsServiceV1.run requires a task.');
      const result = await manager.run(
        {
          agent,
          task: input.task,
          context: input.context,
          mode: input.mode,
          display_name: input.displayName,
        },
        ctx,
        options.signal,
        options.onUpdate
          ? (tasks) => {
              options.onUpdate!(tasks.map(toTaskSnapshotV1));
            }
          : undefined,
      );
      const primaryId = result.results?.[0]?.id ?? result.task_ids[0];
      const primary = result.results?.[0] ?? (primaryId ? manager.getTask(primaryId, ctx?.cwd) : undefined);
      if (!primary) throw new Error('SubagentsServiceV1.run finished without a task snapshot.');
      return toTaskSnapshotV1(primary);
    },
    getTask(id: string, cwd?: string) {
      const task = manager.getTask(id, cwd);
      return task ? toTaskSnapshotV1(task) : undefined;
    },
    cancel(id: string, reason = 'cancelled') {
      try {
        return toTaskSnapshotV1(manager.cancel(id, reason));
      } catch {
        return undefined;
      }
    },
  };
}

type ServiceSlotHolder = { current?: SubagentsServiceV1 };

function serviceSlot(): ServiceSlotHolder {
  const holder = globalThis as unknown as Record<symbol, ServiceSlotHolder | undefined>;
  let slot = holder[SERVICE_SLOT];
  if (!slot) {
    slot = {};
    holder[SERVICE_SLOT] = slot;
  }
  return slot;
}

/** Publish a live service for companion extensions to discover. */
export function publishSubagentsService(service: SubagentsServiceV1): void {
  serviceSlot().current = service;
}

/**
 * Retrieve the active compatible service, or undefined when j0k3r is absent,
 * inactive, shut down, or publishes an incompatible version. Absence is
 * normal and non-exceptional: consumers fall back gracefully.
 */
export function getSubagentsService(): SubagentsServiceV1 | undefined {
  const current = serviceSlot().current;
  return current && current.apiVersion === SUBAGENTS_SERVICE_API_VERSION ? current : undefined;
}

/**
 * Unpublish a service. When an instance is given, only that exact instance
 * is cleared: a stale shutdown/reload path can never remove a newer active
 * service that replaced it.
 */
export function unpublishSubagentsService(expected?: SubagentsServiceV1): void {
  const slot = serviceSlot();
  if (expected === undefined || slot.current === expected) slot.current = undefined;
}

import { loadSubagents, readSubagentsConfig } from './config.js';
import { resolveEffectiveSubagentProfile } from './profile-resolver.js';
import { expandToolPatterns } from './tool-patterns.js';
import { resolveEffectiveSubagentMode } from './config.js';
import type { SubagentDefinition, SubagentsConfig } from './types.js';

/**
 * Shared tool-resolution seam for child construction and capability
 * inspection (REQ-017).
 *
 * Both the SDK runner and `describeAgent` resolve through
 * {@link resolveEffectiveTools}, so the reported effective capabilities
 * cannot drift from what a child session actually receives.
 */

/** Pi core tools that exist without extension registration. */
const CORE_TOOL_NAMES = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

function isCoreTool(name: string): boolean {
  return CORE_TOOL_NAMES.has(name) || name.startsWith('memory_');
}

/** Names of tools active in the parent session, or undefined when unknown. */
export function activeToolNames(ctx: any): string[] | undefined {
  for (const source of [ctx?.pi, ctx]) {
    try {
      const tools = source?.getTools?.();
      if (!Array.isArray(tools)) continue;
      return tools
        .map((tool: unknown) => (typeof tool === 'string' ? tool : (tool as { name?: unknown })?.name))
        .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);
    } catch {}
  }
  return undefined;
}

/**
 * Resolve the exact tool allowlist a child session receives for a definition
 * under the given context: definition tools (or config defaults) with
 * wildcard expansion against active parent tools, blocked `subagent_*`
 * tools removed, and — when the active tool set is known — explicit
 * non-core tools dropped unless they are actually active. A child cannot
 * use an inactive extension tool, so reporting it would be a lie and
 * passing it to session creation is at best useless.
 */
export function resolveEffectiveTools(input: {
  definition: Pick<SubagentDefinition, 'tools'>;
  config: Pick<SubagentsConfig, 'default_tools'>;
  ctx: any;
}): string[] {
  const active = activeToolNames(input.ctx);
  const configured =
    input.definition.tools?.length ? input.definition.tools : input.config.default_tools;
  const expanded = expandToolPatterns(configured, active);
  if (!active) return expanded;
  const activeSet = new Set(active);
  return expanded.filter((tool) => activeSet.has(tool) || isCoreTool(tool));
}

export interface AgentCapabilityDescriptor {
  name: string;
  description: string;
  scope?: SubagentDefinition['scope'];
  declaredTools: string[];
  effectiveTools: string[];
  model?: string;
  effort?: string;
  defaultMode: 'task' | 'background';
}

/** Policy-aligned capability descriptor for one named agent, if defined. */
export function describeAgentDefinition(
  name: string,
  ctx: any,
  cwd = ctx?.cwd ?? process.cwd(),
): AgentCapabilityDescriptor | undefined {
  const definition = loadSubagents(cwd).find((candidate) => candidate.name === name.toLowerCase());
  if (!definition) return undefined;
  const config = readSubagentsConfig(cwd);
  const profile = resolveEffectiveSubagentProfile({ agentName: definition.name, definition, config, ctx });
  return {
    name: definition.name,
    description: definition.description,
    scope: definition.scope,
    declaredTools: [...definition.tools],
    effectiveTools: resolveEffectiveTools({ definition, config, ctx }),
    model: profile.model.value ? `${profile.model.value.provider}/${profile.model.value.id}` : undefined,
    effort: profile.effort.value,
    defaultMode: resolveEffectiveSubagentMode({ definition, config }),
  };
}

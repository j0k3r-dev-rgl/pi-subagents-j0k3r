import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelRef, SubagentDefinition, SubagentDefinitionScope, SubagentModelProfile, SubagentModelProfiles, SubagentSessionResources, SubagentsConfig, SubagentUiMode, ThinkingEffort } from './types.js';

const DEFAULT_TOOLS = ['read', 'memory_context', 'memory_search', 'memory_recall', 'memory_get'];
const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_STALL_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_BACKGROUND_HANDOFF_SHORTCUT = 'ctrl+h';
const DEFAULT_HISTORY_PANEL_SHORTCUT = 'ctrl+,';
const DEFAULT_DETAIL_CANCEL_SHORTCUT = 'x';
const DEFAULT_RENDER_DEBUG_LOG_PATH = path.join(os.tmpdir(), 'pi-subagents-render.jsonl');
const BLOCKED_SUBAGENT_TOOLS = new Set([
  'subagent_run',
  'subagent_list_agents',
  'subagent_status',
  'subagent_result',
  'subagent_list_tasks',
  'subagent_cancel',
]);

function sanitizeTools(tools: string[]): string[] {
  return tools.map(String).filter((tool) => !BLOCKED_SUBAGENT_TOOLS.has(tool) && !tool.startsWith('subagent_'));
}

function parseScalar(value: string): any {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^['"]|['"]$/g, '');
}

export function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data: Record<string, any> = {};
  let currentKey: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const list = line.match(/^\s*-\s+(.+)$/);
    if (list && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(parseScalar(list[1]));
      continue;
    }
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    currentKey = m[1];
    const value = m[2];
    if (!value) data[currentKey] = [];
    else data[currentKey] = parseScalar(value);
  }
  return { data, body };
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

function subagentsConfigPath(dir = agentDir()): string {
  return path.join(dir, 'subagents.json');
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveNumber(value: any, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: any, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

export function parseModel(value: any): ModelRef | undefined {
  if (!value || value === 'default') return undefined;
  if (typeof value === 'string') {
    const parts = value.split('/');
    if (parts.length !== 2) return undefined;
    const [provider, id] = parts.map((part) => part.trim());
    return provider && id ? { provider, id } : undefined;
  }
  if (isPlainObject(value) && typeof value.provider === 'string' && typeof value.id === 'string') {
    const provider = value.provider.trim();
    const id = value.id.trim();
    return provider && id ? { provider, id } : undefined;
  }
  return undefined;
}

const THINKING_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function parseEffort(value: any): ThinkingEffort | undefined {
  if (!value || value === 'default') return undefined;
  const effort = String(value).trim().toLowerCase();
  return THINKING_EFFORTS.has(effort) ? effort as ThinkingEffort : undefined;
}

function parseSessionResources(value: any): SubagentSessionResources {
  const resources = String(value ?? 'lean').trim().toLowerCase();
  return resources === 'full' ? 'full' : 'lean';
}

function parseMode(value: any): SubagentUiMode {
  const mode = String(value ?? 'opencode').trim().toLowerCase();
  return mode === 'claude' ? 'claude' : 'opencode';
}

function parseCtrlShortcut(value: any, fallback: string): string {
  const shortcut = String(value ?? fallback).trim().toLowerCase();
  return /^(?:ctrl\+(?:[a-z]|,)|ctrl\+shift\+[a-z])$/.test(shortcut) ? shortcut : fallback;
}

function parseDetailShortcut(value: any): string {
  const shortcut = String(value ?? DEFAULT_DETAIL_CANCEL_SHORTCUT).trim().toLowerCase();
  if (/^[a-z]$/.test(shortcut)) return shortcut;
  return /^(?:ctrl\+(?:[a-z]|,)|ctrl\+shift\+[a-z])$/.test(shortcut) ? shortcut : DEFAULT_DETAIL_CANCEL_SHORTCUT;
}

function parseBackgroundHandoffShortcut(value: any): string {
  return parseCtrlShortcut(value, DEFAULT_BACKGROUND_HANDOFF_SHORTCUT);
}

function parseBoolean(value: any, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseRenderDebugPartial(value: unknown): { enabled?: boolean; path?: string } {
  if (!isPlainObject(value)) return {};
  const partial: { enabled?: boolean; path?: string } = {};
  if (value.enabled === true) partial.enabled = true;
  else if (value.enabled === false) partial.enabled = false;
  if (typeof value.path === 'string' && value.path.trim()) partial.path = value.path.trim();
  return partial;
}

function parseRenderDebugConfig(globalRaw: Record<string, unknown>, projectRaw: Record<string, unknown>): SubagentsConfig['render_debug'] {
  const globalPartial = parseRenderDebugPartial(globalRaw.render_debug ?? globalRaw.renderDebug);
  const projectPartial = parseRenderDebugPartial(projectRaw.render_debug ?? projectRaw.renderDebug);
  const merged = { ...globalPartial, ...projectPartial };
  if (merged.enabled !== true) return undefined;
  return { enabled: true, path: merged.path ?? DEFAULT_RENDER_DEBUG_LOG_PATH };
}

function parseModelProfile(value: unknown): SubagentModelProfile | undefined {
  if (!isPlainObject(value)) return undefined;
  const profile: SubagentModelProfile = {};
  const model = parseModel(value.model);
  const effort = parseEffort(value.effort ?? value.thinking_level ?? value.thinkingLevel);
  if (model) profile.model = model;
  if (effort) profile.effort = effort;
  return Object.keys(profile).length ? profile : undefined;
}

function parseModelProfiles(value: unknown): SubagentModelProfiles {
  if (!isPlainObject(value)) return {};
  const profiles: SubagentModelProfiles = {};
  for (const [name, rawProfile] of Object.entries(value)) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) continue;
    const profile = parseModelProfile(rawProfile);
    if (profile) profiles[normalizedName] = profile;
  }
  return profiles;
}

function serializeModelRef(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

function cleanProfile(profile: SubagentModelProfile): Record<string, string> | undefined {
  const cleaned: Record<string, string> = {};
  if (profile.model) cleaned.model = serializeModelRef(profile.model);
  if (profile.effort) cleaned.effort = profile.effort;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

export function readSubagentsConfig(cwd: string): SubagentsConfig {
  const globalRaw = readJson(subagentsConfigPath());
  const projectRaw = readJson(path.join(cwd, '.pi', 'subagents.json'));
  const raw = { ...globalRaw, ...projectRaw };
  const globalModelProfiles = parseModelProfiles(globalRaw.model_profiles);
  const projectModelProfiles = parseModelProfiles(projectRaw.model_profiles);
  return {
    default_model: parseModel(raw.default_model),
    default_effort: parseEffort(raw.default_effort ?? raw.default_thinking_level ?? raw.thinkingLevel),
    model_profiles: { ...globalModelProfiles, ...projectModelProfiles },
    global_model_profiles: globalModelProfiles,
    project_model_profiles: projectModelProfiles,
    timeout_ms: positiveInteger(raw.timeout_ms, DEFAULT_TIMEOUT_MS),
    stall_timeout_ms: positiveInteger(raw.stall_timeout_ms, DEFAULT_STALL_TIMEOUT_MS),
    max_concurrency: positiveInteger(raw.max_concurrency, DEFAULT_MAX_CONCURRENCY),
    default_tools: sanitizeTools(Array.isArray(raw.default_tools) ? raw.default_tools.map(String) : DEFAULT_TOOLS),
    session_resources: parseSessionResources(raw.session_resources ?? raw.sessionResources),
    mode: parseMode(raw.mode),
    background_handoff_shortcut: parseBackgroundHandoffShortcut(raw.background_handoff_shortcut ?? raw.backgroundHandoffShortcut),
    history_panel_shortcut: parseCtrlShortcut(raw.history_panel_shortcut ?? raw.historyPanelShortcut, DEFAULT_HISTORY_PANEL_SHORTCUT),
    detail_cancel_shortcut: parseDetailShortcut(raw.detail_cancel_shortcut ?? raw.detailCancelShortcut),
    debug: parseBoolean(raw.debug, false),
    render_debug: parseRenderDebugConfig(globalRaw, projectRaw),
  };
}

function projectSubagentsConfigPath(cwd: string): string {
  return path.join(cwd, '.pi', 'subagents.json');
}

function subagentsConfigPathForScope(input: { scope?: SubagentDefinitionScope; cwd?: string; agentDir?: string }): string {
  return input.scope === 'project' && input.cwd ? projectSubagentsConfigPath(input.cwd) : subagentsConfigPath(input.agentDir);
}

export function saveSubagentModelProfile(input: { agentName: string; profile: SubagentModelProfile; scope?: SubagentDefinitionScope; cwd?: string; agentDir?: string }): void {
  const file = subagentsConfigPathForScope(input);
  const root = readJson(file);
  const writableRoot: Record<string, unknown> = isPlainObject(root) ? { ...root } : {};
  const modelProfiles = isPlainObject(writableRoot.model_profiles) ? { ...writableRoot.model_profiles } : {};
  const agentName = input.agentName.trim().toLowerCase();
  const cleaned = cleanProfile(input.profile);
  if (agentName && cleaned) modelProfiles[agentName] = cleaned;
  if (Object.keys(modelProfiles).length) writableRoot.model_profiles = modelProfiles;
  else delete writableRoot.model_profiles;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(writableRoot, null, 2)}\n`, 'utf8');
}

export function saveGlobalSubagentModelProfile(input: { agentName: string; profile: SubagentModelProfile; agentDir?: string }): void {
  saveSubagentModelProfile({ ...input, scope: 'global' });
}

export function resetSubagentModelProfileField(input: { agentName: string; field: 'model' | 'effort'; scope?: SubagentDefinitionScope; cwd?: string; agentDir?: string }): void {
  const file = subagentsConfigPathForScope(input);
  const root = readJson(file);
  const writableRoot: Record<string, unknown> = isPlainObject(root) ? { ...root } : {};
  const modelProfiles = isPlainObject(writableRoot.model_profiles) ? { ...writableRoot.model_profiles } : {};
  const agentName = input.agentName.trim().toLowerCase();
  const existing = isPlainObject(modelProfiles[agentName]) ? { ...modelProfiles[agentName] } : {};
  delete existing[input.field];
  if (Object.keys(existing).length) modelProfiles[agentName] = existing;
  else delete modelProfiles[agentName];
  if (Object.keys(modelProfiles).length) writableRoot.model_profiles = modelProfiles;
  else delete writableRoot.model_profiles;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(writableRoot, null, 2)}\n`, 'utf8');
}

export function resetGlobalSubagentModelProfileField(input: { agentName: string; field: 'model' | 'effort'; agentDir?: string }): void {
  resetSubagentModelProfileField({ ...input, scope: 'global' });
}

function loadSubagentsFromDir(dir: string, scope: SubagentDefinitionScope): SubagentDefinition[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const filePath = path.join(dir, file);
      const { data, body } = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
      const name = String(data.name || path.basename(file, '.md')).trim().toLowerCase();
      const description = String(data.description || `${name} subagent`).trim();
      const tools = sanitizeTools(Array.isArray(data.tools) ? data.tools.map(String) : DEFAULT_TOOLS);
      return { name, description, filePath, instructions: body.trim(), model: parseModel(data.model), effort: parseEffort(data.effort ?? data.thinking_level ?? data.thinkingLevel), tools, scope };
    });
}

function agentsDirSources(cwd: string): Array<{ scope: 'global' | 'project'; kind: 'agents' | 'subagents'; dir: string }> {
  const globalAgentDir = agentDir();
  return [
    { scope: 'global', kind: 'agents', dir: path.join(globalAgentDir, 'agents') },
    { scope: 'global', kind: 'subagents', dir: path.join(globalAgentDir, 'subagents') },
    { scope: 'project', kind: 'agents', dir: path.join(cwd, '.pi', 'agents') },
    { scope: 'project', kind: 'subagents', dir: path.join(cwd, '.pi', 'subagents') },
  ];
}

export function subagentSourceWarnings(cwd: string): string[] {
  const warnings: string[] = [];
  for (const scope of ['global', 'project'] as const) {
    const sources = agentsDirSources(cwd).filter((source) => source.scope === scope);
    const agentsSource = sources.find((source) => source.kind === 'agents')!;
    const subagentsSource = sources.find((source) => source.kind === 'subagents')!;
    const agents = loadSubagentsFromDir(agentsSource.dir, agentsSource.scope);
    const subagents = loadSubagentsFromDir(subagentsSource.dir, subagentsSource.scope);
    const subagentNames = new Map(subagents.map((definition) => [definition.name, definition]));
    for (const agent of agents) {
      const subagent = subagentNames.get(agent.name);
      if (!subagent) continue;
      warnings.push(`Duplicate subagent name "${agent.name}" found in ${scope} agents and subagents directories; using subagents definition (${subagent.filePath}).`);
    }
  }
  return warnings;
}

export function loadSubagents(cwd: string): SubagentDefinition[] {
  const byName = new Map<string, SubagentDefinition>();
  for (const source of agentsDirSources(cwd)) {
    for (const agent of loadSubagentsFromDir(source.dir, source.scope)) byName.set(agent.name, agent);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSubagent(cwd: string, name: string): SubagentDefinition | undefined {
  return loadSubagents(cwd).find((a) => a.name === name.toLowerCase());
}

---
name: subagents-configuration
description: "configuration-only guidance for Pi Subagents Extension, including markdown subagent definitions, .pi/subagents.json, model profiles, tool allowlists, background handoff shortcuts, history storage, and generic interaction handoff."
license: Apache-2.0
metadata:
  author: j0k3r
  version: "1.0"
---

# Subagents Configuration

## Registry Contract

Use this block as the machine-readable source for `.pi/skill-registry.json` generation. Keep it valid JSON.

```json
{
  "category": "workflow",
  "domains": ["subagents-configuration", "subagent-config", "model-profile-config", "tool-allowlist-config", "subagent-history-config", "subagent-shortcut-config"],
  "triggers": {
    "paths": [
      ".pi/agents/**/*.md",
      ".pi/subagents/**/*.md",
      ".pi/subagents.json",
      "agents/**/*.md",
      "subagents/**/*.md",
      "subagents.json",
      "~/.pi/agent/agents/**/*.md",
      "~/.pi/agent/subagents/**/*.md",
      "~/.pi/agent/subagents.json"
    ],
    "keywords": [
      "subagents configuration",
      "configure subagents",
      "configurar subagents",
      "configuro subagents",
      "como configurar subagents",
      "cómo configurar subagents",
      "como configuro subagents",
      "cómo configuro subagents",
      "como se configura subagents",
      "cómo se configura subagents",
      "configurar subagentes",
      "configuro subagentes",
      "como configurar subagentes",
      "cómo configurar subagentes",
      "como configuro subagentes",
      "cómo configuro subagentes",
      "como se configura subagentes",
      "cómo se configura subagentes",
      "configuracion subagents",
      "configuración subagents",
      "configuracion subagentes",
      "configuración subagentes",
      "subagent config",
      "subagents.json",
      "model profiles configuration",
      "tool allowlist configuration",
      "subagent history configuration",
      "background handoff shortcut",
      "background_handoff_shortcut",
      "interaction handoff configuration"
    ]
  },
  "sdd_phases": [],
  "related_skills": [],
  "priority": 88
}
```

Field conventions:

- `category`: short grouping such as `base`, `transversal`, `workflow`, `quality`, `security`, or `runtime`.
- `domains`: stable domain tags used for routing.
- `triggers.paths`: glob-like project paths that should activate this skill.
- `triggers.keywords`: configuration-only keywords that should activate this skill.
- `sdd_phases`: keep empty for configuration-only skills so phase routing alone does not load them.
- `related_skills`: configuration-adjacent skills only; do not add usage, implementation, or workflow skills.
- `priority`: routing priority from 0 to 100. Higher means consider earlier when multiple skills match.

## Activation Contract

Use this skill only when the user asks how to configure Pi Subagents or when editing/reviewing subagent configuration files: package installation/update settings, markdown subagent definitions, project/global `subagents.json`, model profiles, allowed tools, history settings, background task config, background handoff shortcuts, lean resources, runtime task/background behavior, and generic interaction handoff as configuration topics only.

Do not load this skill for ordinary subagent delegation/use (`subagent_run`, task status/result polling), extension implementation work, task history browsing, or editing this skill file; those are not configuration questions.

## Hard Rules

- The main agent remains the orchestrator; subagents must not delegate to other subagents.
- Never allow `subagent_*` tools in subagent tool allowlists; the extension filters them, but configs should not include them.
- Prefer narrow tool allowlists per subagent. Do not grant write/bash tools unless the subagent purpose requires them.
- For SDD/PRD phase agents, prefer deterministic active-flow memory tools only: `memory_search`, `memory_get`, `memory_add`, and `memory_update`; avoid `memory_context` and `memory_recall` in subagent allowlists unless there is a specific reviewed need.
- For SDD phase agents, memory write tools may be allowed only for active SDD flow memory/artifacts according to `sdd-workflow`.
- Project subagent definitions live in `.pi/agents/*.md` and `.pi/subagents/*.md`; global user definitions live in `$PI_CODING_AGENT_DIR/agents/*.md`, `$PI_CODING_AGENT_DIR/subagents/*.md`, `~/.pi/agent/agents/*.md`, or `~/.pi/agent/subagents/*.md`.
- Project definitions override global definitions with the same normalized name. Within the same scope, definitions in `subagents` override definitions in `agents` with the same normalized name, and Pi should warn at session startup so users can clean up the duplicate.
- Subagents config resolves as a cascade: project `.pi/subagents.json` overrides global `$PI_CODING_AGENT_DIR/subagents.json` or `~/.pi/agent/subagents.json`; missing project fields fall back to global config; fields missing from both fall back to built-in defaults. Communicate this precedence to users when explaining config behavior, with the explicit exception that `model_profiles` are global-only.
- `model_profiles` are read only from global `$PI_CODING_AGENT_DIR/subagents.json` or `~/.pi/agent/subagents.json`; project-local `.pi/subagents.json` must not set or override subagent model/effort routing.
- Prefer configuring subagent `model` and `effort` in global `subagents.json` under `model_profiles`, not in project-local config or in the subagent markdown frontmatter. Markdown definitions should usually contain identity, description, tool allowlist, and behavioral instructions only.
- Nested subagent sessions should use `session_resources: "lean"` by default so the subagent markdown body becomes the nested session system prompt, the delegated user prompt contains only orchestrator context/task, and workflow skills, prompt templates, themes, context files, and startup context injections are not auto-loaded.
- In lean mode, extensions are loaded for allowlisted tools and tool-safety hooks only; prompt/context lifecycle hooks such as `before_agent_start` and `context` must not inject hidden messages into subagent turns.
- Subagent task history is stored globally under data storage, but rows remain project-scoped by `cwd`; history stores delegated prompt and subagent system prompt separately.
- Debug logging is disabled by default with `debug: false`; when enabled in global or project `subagents.json`, logs are written to the executing project's `cwd/.pi/subagents-debug.log`.
- To install the published package globally, prefer `pi install npm:pi-subagents-j0k3r`. If the user wants future `pi update --extensions` / `pi update --all` to move to newer releases, keep the package source unpinned as `npm:pi-subagents-j0k3r` in `~/.pi/agent/settings.json`. Use `npm:pi-subagents-j0k3r@x.y.z` only when the user explicitly wants a fixed version.
- Runtime behavior to explain: `mode=task` waits and returns the full subagent response to the orchestrator; `mode=background` frees the chat, should not be polled just to wait, and sends an automatic completion/failure notification. `/subagents` opens the session history/detail panel; `ctrl+o` expands/collapses rendered tool output and responses; `subagent_result` reads a stored result when explicitly needed.
- After changing subagent markdown/config, package settings, or extension code, tell the user to `/reload` or restart Pi.

Recommended global package setting in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-subagents-j0k3r"
  ]
}
```

Recommended `subagents.json` starter:

```json
{
  "mode": "opencode",
  "timeout_ms": 600000,
  "stall_timeout_ms": 120000,
  "max_concurrency": 5,
  "debug": false,
  "session_resources": "lean",
  "history_panel_shortcut": "ctrl+,",
  "detail_cancel_shortcut": "x",
  "background_handoff_shortcut": "ctrl+h",
  "default_tools": [
    "read",
    "memory_context",
    "memory_search",
    "memory_recall",
    "memory_get"
  ],
  "model_profiles": {}
}
```

Markdown subagent frontmatter pattern:

```md
---
name: discovery
description: investigates isolated ideas, code, documentation, and context7 before deciding next workflow
tools:
  - read
  - memory_search
---

# Discovery Subagent

Instructions...
```

Configure model/effort routing separately in the global `subagents.json` when needed. If no global profile/default is configured, the subagent inherits the current orchestrator model and thinking effort.

```json
{
  "model_profiles": {
    "discovery": {
      "model": "anthropic/claude-sonnet-4-5",
      "effort": "low"
    }
  }
}
```

Model/effort resolution order:

1. Global `model_profiles[agentName]` in `$PI_CODING_AGENT_DIR/subagents.json` or `~/.pi/agent/subagents.json`.
2. Markdown frontmatter `model` / `effort` only for explicit per-file overrides.
3. `default_model` / `default_effort` from effective `subagents.json` config.
4. Current orchestrator model / effort.

## Decision Gates

- If the subagent will modify files, run bash, or write memory, ask whether a full SDD workflow or stricter review is required.
- If the subagent needs human input, require a structured `interaction_required` request with enough prompt, payload, and expected-response data for the parent to answer.
- If a project wants many subagents or broad tools, recommend starting with read-only discovery agents and expanding deliberately.
- If the user asks for project-local model profiles, explain that `model_profiles` are global-only and ask whether they want to update the global config instead.

## Execution Steps

1. Identify target scope: npm package install/update, global subagent, project subagent, global config, or project config, and explain the cascade when relevant: project-local config first, then global config for missing fields, then built-in defaults.
2. For package setup, inspect settings before editing; use `pi install npm:pi-subagents-j0k3r` when possible, or edit `~/.pi/agent/settings.json` only when the CLI is unavailable/broken. Prefer unpinned `npm:pi-subagents-j0k3r` unless the user asks for a fixed version.
3. Read existing subagent markdown/config before editing, checking both `agents` and `subagents` directories for the requested scope.
4. For new subagents, choose lowercase kebab-case names and clear trigger-focused descriptions. Prefer `subagents` for new definitions unless the user explicitly needs compatibility with an `agents` harness.
5. Set minimal tool allowlists; remove any `subagent_*` entries.
6. Configure `model_profiles` only in global `subagents.json` when the user wants explicit per-agent routing; project-local `model_profiles` are ignored. Configure `default_model` and `default_effort` in effective `subagents.json` only when the user wants defaults. Do not put model routing in subagent markdown unless the user explicitly asks for per-file overrides. Explain that unconfigured fields inherit from the orchestrator.
7. Configure `debug: true` only for temporary diagnostics; keep `debug: false` by default and remember logs are written under the executing project's `.pi` directory.
8. Validate JSON syntax for settings/subagents config and frontmatter/body structure for markdown agents.
9. When configuring OpenCode-mode history opening, prefer `history_panel_shortcut` with `ctrl+<letter>` or `ctrl+,` values and document any built-in shortcut conflicts.
10. When configuring history/detail cancellation, prefer `detail_cancel_shortcut` with `x` by default; it supports `ctrl+<letter>`, `ctrl+shift+<letter>`, `ctrl+,`, or one lowercase letter. It only cancels the selected queued/running task while the detail panel is active.
11. When configuring Claude-mode background handoff, prefer `background_handoff_shortcut` with `ctrl+<letter>` values and document any built-in shortcut conflicts.
12. Explain runtime behavior when relevant: use `mode=task` to wait; use `mode=background` to keep chat usable and wait for automatic notification; use `/subagents` and `ctrl+o` for detail/expanded rendering.
13. Tell the user to `/reload` or restart Pi.
14. If validating configuration after reload, use `subagent_list_agents` only when the user asks for runtime verification; do not run delegated tasks just to validate configuration.

## Output Contract

Return:

- Skill applied: `subagents-configuration`.
- Scope/path configured or reviewed, including whether definitions came from `agents` or `subagents`.
- Package settings and subagents/config fields added, changed, or preserved.
- Tool allowlist, system-prompt isolation, Context7 scope, memory-tool scope, debug logging, model/effort decisions, and inheritance behavior.
- Runtime behavior explained when relevant: task vs background, automatic notifications, `/subagents`, `ctrl+o`, and `subagent_result`.
- Related configuration skills considered or loaded.
- Validation executed, or the concrete reason it was not run.
- Required reload/restart note and open risks.

## References

- `extensions/subagents/README.md` — Subagents configuration, shortcuts, history settings, and model profiles.
- `extensions/subagents/src/config.ts` — subagent/config loading and tool filtering.
- `extensions/subagents/src/history.ts` — global history storage behavior.
- This package README — generic interaction handoff contract and runtime behavior.

# Pi Subagents Extension

Pi extension for delegating work to markdown-defined subagents. It registers tools for the orchestrator, runs subagents in isolated in-memory Pi sessions, tracks task history, provides a TUI history panel, and supports per-subagent model/thinking-effort profiles.

## What it provides

- Markdown-defined subagents loaded from global and project directories.
- `subagent_run` for task-mode or background delegation to one or many agents.
- Status/result/list/cancel tools for delegated tasks.
- Isolated in-memory agent sessions for each subagent run.
- Subagent markdown used as system prompt, with delegated task/context as the user prompt.
- Project-scoped task history in a global SQLite data/cache location.
- TUI history panel via `/subagents` or `ctrl+,`.
- Claude-mode background handoff via `ctrl+h` by default, configurable in `subagents.json`.
- TUI execution rendering can expand/collapse tool and rendered component output with `ctrl+o`.
- Model profile UI via `/subagent-models`.
- Per-agent/default model and thinking-effort configuration.
- Tool allowlist filtering that prevents subagents from delegating to other subagents.
- Generic subagent-to-parent interaction handoff so human decisions happen on the main thread.

## Install as a Pi package

This repository is an installable Pi package named `pi-subagents-j0k3r`.

Install from npm after publishing:

```bash
pi install npm:pi-subagents-j0k3r
```

Install from a Git repository or tag:

```bash
pi install git:https://github.com/<owner>/pi-subagents-j0k3r@<tag-or-commit>
```

Try a local checkout without installing it permanently:

```bash
pi -e ./path/to/pi-subagents-j0k3r
```

Install for one project instead of globally with `-l`:

```bash
pi install -l npm:pi-subagents-j0k3r
```

The package manifest exposes:

```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  }
}
```

The npm metadata includes the `pi-package` keyword required for Pi package gallery discovery. After publishing the npm package, it is eligible to appear on the Pi package page.

Use `/reload` after changing extension code, skill files, config, or markdown subagent definitions during an interactive session.

## Subagent definitions

Subagents are markdown files with optional YAML-like frontmatter.

Load order:

1. Global user subagents from `$PI_CODING_AGENT_DIR/subagents/*.md`.
2. Project subagents from `.pi/subagents/*.md`.

Project definitions override global definitions with the same normalized name.

Default global agent directory:

```txt
~/.pi/agent
```

Override with:

```bash
PI_CODING_AGENT_DIR=/path/to/pi-agent-dir
```

### Definition format

Example:

```md
---
name: discovery
description: investigates isolated ideas, code, documentation, and context7 before deciding whether to start prd/sdd
tools:
  - read
  - bash
  - context7_status
  - context7_search_library
model: anthropic/claude-sonnet-4-5
effort: low
---

# Discovery Subagent

You are an isolated research executor...
```

Supported frontmatter:

| Field | Description |
|---|---|
| `name` | Subagent name. Defaults to filename stem. Normalized to lowercase. |
| `description` | Short description shown by `subagent_list_agents`. |
| `tools` | Tool allowlist for the subagent. When omitted, the definition gets the built-in default tool list. Configured `default_tools` is used by the runner when a definition has an empty tool list. |
| `model` | Optional model as `provider/model-id`. |
| `effort`, `thinking_level`, `thinkingLevel` | Optional thinking effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |

The markdown body becomes the subagent instructions.

## Project and global config

Config files:

```txt
~/.pi/agent/subagents.json      # global
.pi/subagents.json              # project
```

Config resolves as a cascade: project `.pi/subagents.json` overrides global `~/.pi/agent/subagents.json`; missing project fields fall back to global config; fields missing from both fall back to built-in defaults. `model_profiles` are the explicit exception: per-agent model/effort routing is read only from the global `~/.pi/agent/subagents.json` or `$PI_CODING_AGENT_DIR/subagents.json`, and project-local `model_profiles` are ignored.

Example:

```json
{
  "default_model": "anthropic/claude-sonnet-4-5",
  "default_effort": "medium",
  "timeout_ms": 600000,
  "stall_timeout_ms": 120000,
  "max_concurrency": 5,
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
  "model_profiles": {
    "discovery": {
      "model": "anthropic/claude-haiku-4-5",
      "effort": "low"
    },
    "sdd-apply": {
      "model": "anthropic/claude-sonnet-4-5",
      "effort": "medium"
    }
  }
}
```

### Config fields

| Field | Default | Description |
|---|---:|---|
| `default_model` | current orchestrator model | Fallback model for all subagents. Format: `provider/model-id`. |
| `default_effort` | current orchestrator effort | Fallback thinking effort. Also accepts `default_thinking_level` or `thinkingLevel`. |
| `model_profiles` | `{}` | Global-only per-agent model/effort overrides. Project-local `.pi/subagents.json` `model_profiles` are ignored. |
| `timeout_ms` | `600000` | Total timeout per subagent task. |
| `stall_timeout_ms` | `120000` | Inactivity timeout for a subagent session. |
| `max_concurrency` | `5` | Max concurrent subagent tasks per cwd/config pair. |
| `session_resources` | `lean` | SDK resource loading mode. `lean` uses the subagent markdown body as the nested session system prompt, skips skills, prompt templates, themes, and context files, and loads extensions in tools-only/safety-hook mode so allowlisted extension tools remain available without startup context injection. Use explicit `full` only when a subagent intentionally needs the full Pi resource set. Also accepts camelCase `sessionResources`. |
| `history_panel_shortcut` | `ctrl+,` | OpenCode-mode shortcut used to open the subagents history/detail panel. Accepts `ctrl+<letter>` or `ctrl+,` and also accepts camelCase `historyPanelShortcut`. |
| `detail_cancel_shortcut` | `x` | Shortcut for the subagents history/detail panel to cancel only the currently selected queued/running subagent. `ctrl+...` values are also registered as a Pi shortcut scoped by the active panel, so they still work when the TUI captures control keys; single-letter values are handled by the panel input. Accepts `ctrl+<letter>`, `ctrl+shift+<letter>`, `ctrl+,`, or one lowercase letter, and also accepts camelCase `detailCancelShortcut`. It is ignored when the panel is not active or the selected subagent is already finished. |
| `background_handoff_shortcut` | `ctrl+h` | Claude-mode shortcut used to send a running task to the background. Accepts `ctrl+<letter>` and also accepts camelCase `backgroundHandoffShortcut`. |
| `default_tools` | see below | Fallback tool allowlist used by the runner when an agent definition has an empty tool list. Omitted frontmatter `tools` uses the built-in default list. |

Default tools:

```json
["read", "memory_context", "memory_search", "memory_recall", "memory_get"]
```

Subagent delegation tools are always blocked from subagent tool allowlists, even if listed:

```txt
subagent_run
subagent_list_agents
subagent_status
subagent_result
subagent_list_tasks
subagent_cancel
any tool starting with subagent_
```

## Model profile resolution

Effective model resolution order:

1. `model_profiles[agent].model`
2. subagent frontmatter `model`
3. `default_model`
4. current orchestrator model
5. unresolved

Effective effort resolution order:

1. `model_profiles[agent].effort`
2. subagent frontmatter `effort` / `thinking_level` / `thinkingLevel`
3. `default_effort`
4. current orchestrator thinking level
5. unresolved

If a configured model cannot be resolved, the runner reports an error. If a selected model fails or stalls and the current orchestrator model is different, the runner falls back to the current model.

## Debug and interaction bridge logs

Debug logging is disabled by default. Enable it in global or project `subagents.json`:

```json
{
  "debug": true
}
```

When enabled, subagents write local debug/audit breadcrumbs to the executing project's `.pi` directory:

```txt
.pi/subagents-debug.log
```

The log is intended for runtime debugging of delegated sessions and generic interaction handoff issues. Interaction bridge entries include safe metadata such as task id, agent name, request id, kind, requester, prompt presence, and payload presence. They intentionally avoid storing raw private data beyond the bounded task/history surfaces already captured for debugging.

Useful event names:

- `runner_event` — compact SDK event shape observed by the subagent runner.
- `interaction_bridge_payload_detected` — runner found a structured interaction request.
- `interaction_bridge_payload_recovered_from_channel` — runner recovered a request from the shared interaction channel.
- `interaction_bridge_request_detected` — manager received an interaction request from the runner.
- `interaction_bridge_prompt_main_thread` — manager is prompting the main user.
- `interaction_bridge_user_response` — main user response was published for the subagent to consume.

## Tools exposed to the orchestrator

| Tool | Purpose |
|---|---|
| `subagent_list_agents` | List loaded markdown-defined subagents. |
| `subagent_run` | Delegate a task to one or more subagents. Supports `task` and `background` mode. |
| `subagent_status` | Get status for a delegated task. |
| `subagent_result` | Read the result for a delegated task. |
| `subagent_list_tasks` | List active and persisted delegated tasks for the current cwd. |
| `subagent_cancel` | Cancel a running delegated task. |

Only the main orchestrator should call these tools. Subagents are explicitly prevented from calling `subagent_*` tools.

### `subagent_run`

Parameters:

```ts
{
  agent?: string;
  agents?: string[];
  task: string;
  context?: string;
  mode?: "task" | "background";
}
```

Behavior:

- `mode: "task"` waits for completion and returns compact task summaries.
- `mode: "background"` returns task IDs immediately; use status/result tools later.
- Multiple agents can run from one request with `agents`.
- Double Escape during task-mode execution cancels running subagents and aborts the main turn.

## Commands and shortcut

| Entry point | Description |
|---|---|
| `/subagents` | Open the session-focused TUI subagent history panel. |
| `/subagent-models` | Configure global subagent and SDD phase model profiles. |
| `ctrl+,` | Open the TUI subagent history panel in OpenCode mode by default. Configurable via `history_panel_shortcut` in `subagents.json`. |
| `x` | Cancel the currently selected queued/running subagent from the open history/detail panel by default. Configurable via `detail_cancel_shortcut` in `subagents.json`. |
| `ctrl+h` | Send the running Claude-mode subagent task to the background by default. Configurable via `background_handoff_shortcut` in `subagents.json`. |

`/subagent-models` writes global profile changes to:

```txt
~/.pi/agent/subagents.json
```

or `$PI_CODING_AGENT_DIR/subagents.json` when `PI_CODING_AGENT_DIR` is set.

In non-TUI environments, edit `model_profiles` manually in that JSON file.

## Task history

Task history is stored in a global data/cache location, while each row remains scoped by project `cwd`:

```txt
$XDG_DATA_HOME/pi/subagents/subagents-history.sqlite
```

Fallback:

```txt
~/.local/share/pi/subagents/subagents-history.sqlite
```

Environment overrides:

```bash
PI_SUBAGENTS_HISTORY_DB_PATH=/absolute/path/to/subagents-history.sqlite
PI_SUBAGENTS_HISTORY_HOME=/absolute/path/to/subagents-history-home
```

The history DB stores:

- task metadata;
- status and timestamps;
- model/effort used;
- usage stats when available;
- result/error/output preview;
- delegated user prompt and subagent system prompt separately;
- compact thread snapshots;
- task events.

When `debug: true` is configured, the extension also may write debug diagnostics to:

```txt
.pi/subagents-debug.log
```

History and debug logging are best-effort: failures to persist them should not break delegation.

## Generic interaction handling

Subagents run in isolated sessions, but any human interaction must happen on the main thread. The extension uses one generic protocol for all such cases.

A subagent-side tool or extension can publish or return an interaction request:

```json
{
  "type": "interaction_required",
  "requestId": "req-123",
  "kind": "operator-decision",
  "origin": "subagent",
  "requester": { "subagentName": "analyst", "taskId": "subtask_..." },
  "prompt": {
    "title": "Choose strategy",
    "message": "How should the subagent continue?",
    "choices": ["safe", "fast"]
  },
  "payload": { "any": "structured data needed to answer" },
  "response": { "expected": "choice" }
}
```

The parent manager surfaces the request to the main thread, collects a response with `select`, `confirm`, `input`, or `editor`, publishes:

```json
{
  "type": "interaction_response",
  "requestId": "req-123",
  "status": "answered",
  "value": "safe"
}
```

Then the subagent is retried so the subagent-side tool/extension can consume the response and continue. For unknown or rich interaction kinds, the parent falls back to an editor with the request payload so the user can return arbitrary text or JSON.

Background subagent tasks cannot request interactive main-thread handling. Rerun in `task` mode if human interaction is needed.

## Prompt and memory behavior

In the default `lean` mode, the runner treats the subagent markdown body as the nested session system prompt. The delegated user prompt contains only the orchestrator-provided context and task. The runner does not inject `AGENTS.md`, workflow skills, memory startup context, or generated memory constraints into the delegated user prompt.

Extensions are loaded in an isolated tools-only/safety-hook mode for subagents: allowlisted extension tools remain available, while context/prompt lifecycle hooks such as `before_agent_start` and `context` are removed so extensions cannot add hidden startup messages. Tool-safety hooks (`tool_call`, `tool_result`, and `user_bash`) are preserved for runtime guards and interaction handoff.

Memory behavior should be specified in each subagent markdown definition. A subagent can use memory only when its tool allowlist includes the relevant memory tools. SDD/PRD phase agents use deterministic `memory_search`/`memory_get` plus `memory_add`/`memory_update` for active-flow state; they intentionally do not receive `memory_context` or `memory_recall`.

Context7 access is limited to `discovery`, `tool-smoke`, and `sdd-explore`; downstream SDD phase agents should consume curated evidence from artifacts or orchestrator context instead of performing broad external-doc discovery.

## Bundled resources

This package bundles:

- `index.ts` and `src/**` — the Pi extension runtime.
- `skills/subagents-configuration/SKILL.md` — configuration guidance for agents that need to create or edit subagent definitions.

Subagent definitions are intentionally user/project configuration, not hard-coded package behavior. Add them globally in `$PI_CODING_AGENT_DIR/subagents/*.md` or project-locally in `.pi/subagents/*.md`.

## Development

Install dependencies once:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run typecheck:

```bash
npm run typecheck
```

Verify the npm package contents:

```bash
npm run pack:dry-run
```

Run the full local check:

```bash
npm run check
```

## Related project docs

- `README.md` — package usage, configuration, and development notes.
- `skills/subagents-configuration/SKILL.md` — subagent configuration policy.
- Pi package docs — `docs/packages.md` in the Pi coding-agent distribution.

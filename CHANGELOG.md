# Changelog

## 1.4.1 - 2026-07-15

### Fixed
- Moved resumed tasks to the top of `/subagents`, background widgets, and task listings by sorting on recent activity instead of original creation time.
- Kept recent-task ordering deterministic and consistent after SQLite history reloads, including equal-timestamp tie cases.
- Matched `subagent_continue` call, live progress, and final rendering with task-mode `subagent_run`, including agent, attempt, model, effort, and current activity.
- Restored live double-Escape cancellation and Claude-mode `ctrl+h` background handoff for continued tasks.

## 1.4.0 - 2026-07-15

### Added
- Added `subagent_continue` so completed, failed, and cancelled tasks can resume under the same task ID and exact persisted Pi conversation.
- Added per-attempt history, optional user-approved model and effort overrides, and migration-safe nested-session persistence.

### Improved
- Grouped delegated tasks, continuation prompts, thinking, tools, and responses chronologically by attempt in `/subagents`.
- Added English resume guidance to failed and cancelled agent-facing responses while keeping completed responses unchanged.
- Serialized timeout and cancellation cleanup before reopening sessions and hardened private nested-session storage.

## 1.3.2 - 2026-07-15

### Fixed
- Separated provider inactivity stalls, native tool timeouts, and total task timeouts so long-running tools are no longer misclassified as stalled providers.
- Suppressed provider stall detection while tools are active and preserved precise structured timeout and cancellation errors.
- Rendered subagent bash execution through Pi's native tool component and exposed timeout, stall, cancel, and context-consumption details in `/subagents`.
- Removed automatic model fallback so failures return the selected model's exact error to the orchestrator.

## 1.3.1 - 2026-07-13

### Fixed
- Fixed `/subagents` live rendering so `toolcall_delta` argument JSON is no longer displayed as assistant text before native tool cards.
- Preserved streamed thinking output while routing only `text_delta` events into assistant text, matching Pi's main-thread rendering behavior.

## 1.3.0 - 2026-07-12

### Changed
- Modularized extension composition, tools, renderers, UI, runner, and model-profile code into cohesive modules.
- Split each registered subagent tool into a dedicated file and separated complex rendering responsibilities.
- Reorganized monolithic tests into 24 domain-focused files with 206 passing scenarios.
- Preserved root exports, historical deep imports, runtime behavior, tool contracts, package contents, and privacy boundaries.

## 1.2.1 - 2026-07-12

### Fixed
- Stabilized `/subagents` rendering with a full-screen overlay that prevents parent-chat flicker and reserves space for the panel border.

## 1.2.0 - 2026-07-12

### Added
- Added opt-in render diagnostics with bounded JSONL logging for subagent UI and completion rendering.
- Added structured, versioned subagent execution errors covering provider failures, context limits, timeouts, stalls, cancellations, fallback attempts, persistence, tool responses, and history UI.

### Fixed
- Fixed manual task-mode background handoff so it frees the chat only when the user explicitly sends the running subagent to background.
- Fixed background completion delivery so notifications arrive while the main agent continues working without triggering an extra follow-up turn.
- Increased the default task timeout to 20 minutes and inactivity timeout to 4 minutes.
- Preserved machine-readable failure details while retaining backward-compatible human-readable error messages.

### Documentation
- Added rendering investigation and solution notes covering terminal synchronization, viewport stability, and renderer trade-offs.

## 1.1.0 - 2026-06-27

### Added
- Added support for loading markdown-defined subagents from both `agents` and `subagents` directories globally and project-locally.
- Added startup warnings when duplicate names exist in `agents` and `subagents` at the same scope, while preserving `subagents` as the winning source.
- Enabled project Skill Registry configuration and ignored generated registry cache outputs.

### Fixed
- Made `model_profiles` global-only so project-local `.pi/subagents.json` cannot override per-agent model/effort routing.

### Documentation
- Updated README and Subagents configuration skill guidance for `agents`/`subagents` source precedence and global-only model profiles.

## 1.0.1 - 2026-06-27

### Fixed
- Expanded Subagents configuration guidance so agents can explain npm installation/update setup, model/effort inheritance, and task/background runtime behavior.
- Clarified that subagent model and effort routing should live in `subagents.json` `model_profiles` by default, with unconfigured agents inheriting the orchestrator model and effort.

## 1.0.0 - 2026-06-27

### Added
- Initial Pi package for markdown-defined subagents, delegated task tools, session history, model profiles, and background handoff UX.
- GitHub Actions CI and Semantic Release publishing workflow for npm release automation.
- Package verification script to ensure published package resources are complete.

### Improved
- Background subagent completions notify automatically, stay collapsed by default, expand with `ctrl+o`, and keep the chat available while tasks run.
- Subagent result and task-mode output keep full responses available to the orchestrator while rendering compactly for users.
- Subagent task lists default to current-session collapsed summaries.
- Subagent detail views reuse Pi runtime tool renderers for tools executed inside subagent sessions.

### Changed
- Default detail cancel shortcut is `x` for reliable terminal cancellation.
- Peer dependencies use wildcard ranges for Pi package compatibility while dev dependencies remain pinned.

# Changelog

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

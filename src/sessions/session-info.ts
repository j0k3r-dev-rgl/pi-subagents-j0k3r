/**
 * SessionInfo shape produced by Pi's `SessionManager.list` / `SessionManager.listAll`.
 *
 * Ported from `packages/coding-agent/src/core/session-manager.ts` so the extracted
 * search/tree helpers stay self-contained without importing Pi internals.
 */
export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

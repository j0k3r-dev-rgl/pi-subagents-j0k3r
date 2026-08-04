/**
 * Session tree + display helpers — extracted from
 * `packages/coding-agent/src/modes/interactive/components/session-selector.ts`
 * (buildSessionTree / flattenSessionTree / formatSessionDate / deleteSessionFile)
 * so the Subagents Sessions selector can render the same threaded view as `/resume`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionInfo } from './session-info.js';

/** Minimal path canonicalization (Pi's version also resolves symlinks). */
function canonicalizePath(p: string | undefined): string | undefined {
	if (!p) return p;
	try {
		return resolve(p);
	} catch {
		return p;
	}
}

/** A session tree node for hierarchical display. */
export interface SessionTreeNode {
	session: SessionInfo;
	children: SessionTreeNode[];
	latestActivity: number;
}

/** Flattened node for display with tree structure info. */
export interface FlatSessionNode {
	session: SessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it. */
	ancestorContinues: boolean[];
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending). Ported verbatim from Pi.
 */
export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [], latestActivity: session.modified.getTime() });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const updateLatestActivity = (node: SessionTreeNode): number => {
		let latestActivity = node.session.modified.getTime();
		for (const child of node.children) {
			latestActivity = Math.max(latestActivity, updateLatestActivity(child));
		}
		node.latestActivity = latestActivity;
		return latestActivity;
	};

	for (const root of roots) {
		updateLatestActivity(root);
	}

	// Sort children and roots by latest activity in each subtree (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/** Flatten tree into display list with tree structure metadata. Ported verbatim from Pi. */
export function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

/** Tree prefix for a flattened node (└─ ├─ │). Ported verbatim from Pi. */
export function buildTreePrefix(node: FlatSessionNode): string {
	if (node.depth === 0) {
		return '';
	}
	const parts = node.ancestorContinues.map((continues) => (continues ? '│  ' : '   '));
	const branch = node.isLast ? '└─ ' : '├─ ';
	return parts.join('') + branch;
}

/** Relative date label matching Pi's session-selector buckets. Ported verbatim from Pi. */
export function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return 'now';
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

export interface DeleteSessionResult {
	ok: boolean;
	method: 'trash' | 'unlink';
	error?: string;
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Ported verbatim from Pi.
 */
export async function deleteSessionFile(sessionPath: string): Promise<DeleteSessionResult> {
	// Try `trash` first (if installed)
	const trashArgs = sessionPath.startsWith('-') ? ['--', sessionPath] : [sessionPath];
	const trashResult = spawnSync('trash', trashArgs, { encoding: 'utf-8' });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split('\n')[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(' · ').slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: 'trash' };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: 'unlink' };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: 'unlink', error };
	}
}

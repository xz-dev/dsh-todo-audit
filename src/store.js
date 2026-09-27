/**
 * Per-session task store + durable replay.
 *
 * Pi's rpiv-todo persists through tool-result `details` snapshots on the
 * session branch (last-write-wins, no disk writes). The DSH equivalent is the
 * `tool/result` session event's `meta` slot: defineTool's
 * `output.presentationMeta` is persisted verbatim. Replay walks the session
 * log (`session.snapshotEvents()`) and takes the latest valid envelope.
 */

import { EMPTY_STATE } from "./state.js";

/** Duck-type check mirroring rpiv-todo's isTaskDetails discriminator. */
export function isTaskEnvelope(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Last snapshot wins. Walks session events chronologically; returns a fresh
 * EMPTY_STATE copy when no valid envelope exists on the log.
 */
export function replayState(events) {
	let result = { tasks: [], nextId: 1 };
	for (const e of events) {
		if (e.type !== "tool/result") continue;
		if (!isTaskEnvelope(e.data?.meta)) continue;
		result = {
			tasks: e.data.meta.tasks.map((t) => ({ ...t })),
			nextId: e.data.meta.nextId,
		};
	}
	return result;
}

/**
 * Same last-write-wins replay, plus the loop index (assistant/message count)
 * at which each task last transitioned to in_progress. Re-entries restamp;
 * completed/deleted tasks drop their stamp. Port of pi-jev-todo-audit
 * board.ts replayBoardWithAges onto DSH session events.
 */
export function replayBoardWithAges(events) {
	let result = { tasks: [], nextId: 1 };
	const inProgressSince = new Map();
	const prevStatus = new Map();
	let loops = 0;
	for (const e of events) {
		if (e.type === "assistant/message") {
			loops++;
			continue;
		}
		if (e.type !== "tool/result") continue;
		if (!isTaskEnvelope(e.data?.meta)) continue;
		result = {
			tasks: e.data.meta.tasks.map((t) => ({ ...t })),
			nextId: e.data.meta.nextId,
		};
		const seen = new Set();
		for (const t of result.tasks) {
			seen.add(t.id);
			const was = prevStatus.get(t.id);
			if (t.status === "in_progress" && was !== "in_progress") {
				inProgressSince.set(t.id, loops);
			} else if (t.status !== "in_progress") {
				inProgressSince.delete(t.id);
			}
			prevStatus.set(t.id, t.status);
		}
		for (const id of prevStatus.keys()) {
			if (!seen.has(id)) {
				prevStatus.delete(id);
				inProgressSince.delete(id);
			}
		}
	}
	return { ...result, inProgressSince };
}

/**
 * Live per-session store. The `todo` tool is the only writer; the map is
 * lazily seeded from the durable log on first access, so session resume,
 * plugin reload and compaction all rebuild from the same snapshots.
 */
export class TodoStore {
	constructor() {
		this.states = new Map(); // sessionId -> TaskState
	}

	/** Current state for a session, replaying the log on first touch. */
	get(session) {
		let state = this.states.get(session.id);
		if (!state) {
			state = replayState(session.snapshotEvents());
			this.states.set(session.id, state);
		}
		return state;
	}

	commit(session, state) {
		this.states.set(session.id, state);
	}

	drop(sessionId) {
		this.states.delete(sessionId);
	}
}

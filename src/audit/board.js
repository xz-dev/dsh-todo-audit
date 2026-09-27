/**
 * Board read helpers over the replayed todo state — port of pi-jev-todo-audit
 * board.ts (MIT, Xiangzhe). Replay itself lives in ../store.js
 * (replayBoardWithAges over DSH session events).
 */

export const EMPTY_BOARD = { tasks: [], nextId: 1 };

/** Visible (non-deleted) tasks. */
export function visibleTasks(board) {
	return board.tasks.filter((t) => t.status !== "deleted");
}

/**
 * Render the board the same way `/todos`/`todo list` presents it, so jev sees
 * the same rows the model does: `[status] #id subject (activeForm) ⛓ #deps`.
 */
export function renderBoardLines(board) {
	const tasks = visibleTasks(board);
	if (tasks.length === 0) return [];
	return tasks.map((t) => {
		const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
		const deps = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
		return `[${t.status}] #${t.id} ${t.subject}${form}${deps}`;
	});
}

/** In-progress tasks currently claimed on the board. */
export function inProgressTasks(board) {
	return visibleTasks(board).filter((t) => t.status === "in_progress");
}

/** Visible tasks that are not finished: pending or in_progress. */
export function unfinishedTasks(board) {
	return visibleTasks(board).filter((t) => t.status === "pending" || t.status === "in_progress");
}

/**
 * Task ids that have been in_progress for more than `staleSpans` audit
 * intervals. Missing stamp (task was in_progress before the first snapshot we
 * saw) counts as age 0 — conservative. Diagnostic only, never a split trigger.
 */
export function staleTaskIds(board, currentLoops, interval, staleSpans) {
	const out = [];
	for (const t of inProgressTasks(board)) {
		const since = board.inProgressSince.get(t.id) ?? currentLoops;
		const ageLoops = currentLoops - since;
		if (ageLoops > staleSpans * interval) out.push(t.id);
	}
	return out;
}

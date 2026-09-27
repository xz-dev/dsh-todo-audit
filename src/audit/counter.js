/**
 * Loop counting, reconstructed from the DSH session log.
 *
 * Pi counted finalized assistant messages on the branch; DSH finalizes them
 * as `assistant/message` log events (aborted attempts are `assistant/attempt`
 * and never count). Real human input is `user/message` with
 * `source.kind === "user"` — injected context, steering, compaction
 * checkpoints and this plugin's own audit messages carry other kinds and do
 * NOT reset the cooldown.
 *
 * In-memory counters are authoritative between reconstructs; session
 * discovery replays both counters from the log.
 */

export function freshCounter() {
	return { totalLoops: 0, lastUserMsgAt: 0 };
}

/** Recompute both counters from a session event snapshot. */
export function replayCounter(events) {
	const c = freshCounter();
	for (const e of events) {
		if (e.type === "assistant/message") c.totalLoops++;
		else if (e.type === "user/message" && e.data?.source?.kind === "user") c.lastUserMsgAt = c.totalLoops;
	}
	return c;
}

/** One more loop completed (assistant/message observed live). */
export function onAssistantMessage(c) {
	c.totalLoops++;
}

/** A finalized human message: the cooldown reference becomes the current loop count. */
export function onUserMessage(c) {
	c.lastUserMsgAt = c.totalLoops;
}

/** Loops completed since the most recent human message. */
export function loopsSinceUserMsg(c) {
	return c.totalLoops - c.lastUserMsgAt;
}

/** Should an audit fire for the just-completed loop? */
export function shouldAudit(c, interval, cooldownLoops) {
	if (c.totalLoops <= 0 || c.totalLoops % interval !== 0) return false;
	return loopsSinceUserMsg(c) > cooldownLoops;
}

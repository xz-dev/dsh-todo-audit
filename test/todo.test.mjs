import assert from "node:assert/strict";
import test from "node:test";
import { staleTaskIds } from "../src/audit/board.js";
import { resolveApiKey, resolveAuditConfig } from "../src/audit/config.js";
import { collectContext, entriesFromMessages, redact, reduceContext } from "../src/audit/context.js";
import { replayCounter, shouldAudit } from "../src/audit/counter.js";
import { buildAuditRequest, isContextOverflow, lifecycleKey, retryableError, runAudit } from "../src/audit/typesafe.js";
import { decide } from "../src/audit/verdict.js";
import { applyTaskMutation, buildEnvelope, isTransitionValid } from "../src/state.js";
import { replayBoardWithAges, replayState } from "../src/store.js";
import { formatTodosCommand, mirrorPanel } from "../src/todo.js";
import { parseUserReady } from "../src/audit/stops.js";

test("4-state machine rejects completed → pending and accepts completed → deleted", () => {
	assert.equal(isTransitionValid("completed", "pending"), false);
	assert.equal(isTransitionValid("completed", "deleted"), true);
	assert.equal(isTransitionValid("pending", "in_progress"), true);
	let state = { tasks: [], nextId: 1 };
	state = applyTaskMutation(state, "create", { subject: "Research tool" }).state;
	const bad = applyTaskMutation(state, "update", { id: 1, status: "completed" });
	assert.equal(bad.op.kind, "update");
	const back = applyTaskMutation(bad.state, "update", { id: 1, status: "pending" });
	assert.equal(back.op.kind, "error");
	assert.match(back.op.message, /illegal transition/);
});

test("blockedBy rejects missing ids, self-edges, and cycles", () => {
	let state = { tasks: [], nextId: 1 };
	state = applyTaskMutation(state, "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "create", { subject: "B", blockedBy: [1] }).state;
	const self = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] });
	assert.match(self.op.message, /itself/);
	const cycle = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [2] });
	assert.match(cycle.op.message, /cycle/);
	const missing = applyTaskMutation(state, "create", { subject: "C", blockedBy: [9] });
	assert.match(missing.op.message, /not found/);
});

test("metadata null deletes a key; list hides tombstones; clear resets ids", () => {
	let state = { tasks: [], nextId: 1 };
	state = applyTaskMutation(state, "create", { subject: "A", metadata: { k: 1, drop: true } }).state;
	const updated = applyTaskMutation(state, "update", { id: 1, metadata: { drop: null, k: 2 } });
	assert.deepEqual(updated.state.tasks[0].metadata, { k: 2 });
	state = applyTaskMutation(updated.state, "delete", { id: 1 }).state;
	const listed = buildEnvelope("list", {}, state, applyTaskMutation(state, "list", {}).op);
	assert.equal(listed.text, "No tasks");
	const shown = buildEnvelope("list", { includeDeleted: true }, state, applyTaskMutation(state, "list", { includeDeleted: true }).op);
	assert.match(shown.text, /\[deleted\] #1/);
	const cleared = applyTaskMutation(state, "clear", {});
	assert.deepEqual(cleared.state, { tasks: [], nextId: 1 });
	assert.equal(buildEnvelope("clear", {}, cleared.state, cleared.op).text, "Cleared 1 tasks");
});

test("completedSeq stamps only the completing transition", () => {
	let state = applyTaskMutation({ tasks: [], nextId: 1 }, "create", { subject: "A" }).state;
	state = applyTaskMutation(state, "update", { id: 1, status: "completed" }).state;
	assert.equal(state.tasks[0].completedSeq, 1);
	const again = applyTaskMutation(state, "update", { id: 1, subject: "A2" });
	assert.equal(again.state.tasks[0].completedSeq, 1);
	assert.match(buildEnvelope("update", {}, again.state, again.op).text, /Updated #1/);
});

test("replay is last tool/result meta; in_progress age restamps", () => {
	const events = [
		{ type: "assistant/message" },
		{ type: "tool/result", data: { meta: { tasks: [{ id: 1, subject: "A", status: "pending" }], nextId: 2 } } },
		{ type: "assistant/message" },
		{ type: "tool/result", data: { meta: { tasks: [{ id: 1, subject: "A", status: "in_progress" }], nextId: 2 } } },
		{ type: "assistant/message" },
	];
	assert.equal(replayState(events).tasks[0].status, "in_progress");
	const board = replayBoardWithAges(events);
	assert.equal(board.inProgressSince.get(1), 2);
	assert.deepEqual(staleTaskIds({ ...board, inProgressSince: board.inProgressSince }, 3, 10, 3), []);
	board.inProgressSince.set(1, 0);
	assert.deepEqual(staleTaskIds(board, 40, 10, 3), [1]);
});

test("audit fires every 10th loop only after the user cooldown", () => {
	const events = [];
	for (let i = 0; i < 10; i++) events.push({ type: "assistant/message" });
	let c = replayCounter(events);
	assert.equal(shouldAudit(c, 10, 10), false);
	events.push({ type: "user/message", data: { source: { kind: "user" } } });
	c = replayCounter(events);
	assert.equal(c.lastUserMsgAt, 10);
	for (let i = 0; i < 10; i++) events.push({ type: "assistant/message" });
	c = replayCounter(events);
	assert.equal(shouldAudit(c, 10, 10), false);
	events.push({ type: "assistant/message" });
	c = replayCounter(events);
	assert.equal(c.totalLoops, 21);
	assert.equal(shouldAudit(c, 10, 10), false);
	for (let i = 0; i < 9; i++) events.push({ type: "assistant/message" });
	c = replayCounter(events);
	assert.equal(c.totalLoops, 30);
	assert.equal(shouldAudit(c, 10, 10), true);
	events.push({ type: "user/message", data: { source: { kind: "jev-todo-audit" } } });
	assert.equal(replayCounter(events).lastUserMsgAt, 10);
});

test("redact strips bearer and configured secrets; overflow is not quota", () => {
	assert.equal(redact("Authorization: Bearer sk-live-secret-value"), "Authorization: [REDACTED]");
	assert.equal(isContextOverflow(422, JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } })), true);
	assert.equal(isContextOverflow(400, JSON.stringify({ error: { code: "insufficient_quota", message: "quota exceeded" } })), false);
	assert.equal(isContextOverflow(500, "context length exceeded"), false);
	assert.equal(retryableError("HTTP 429: quota exceeded"), false);
	assert.equal(retryableError("socket hang up"), true);
});

test("assistant-only completion is not a correction; a pending match can be claimed", () => {
	const board = {
		tasks: [{ id: 1, subject: "Ship", status: "pending" }],
		nextId: 2,
		inProgressSince: new Map(),
	};
	const user = { id: "u1", kind: "user", text: "ship it", complete: true, advice: false, protected: true };
	const tool = { id: "t1", kind: "tool_result", text: "tests passed for Ship", complete: true, advice: false, toolName: "bash" };
	const assistant = { id: "a1", kind: "assistant", text: "I finished Ship", complete: true, advice: false };
	const base = { records: [user, tool], globalComplete: true, reduced: false, userBoundary: "u1", omissions: [] };
	const done = decide({
		lifecycle: { [lifecycleKey(1)]: { choice: "actually_completed", confidence: 0.9 } },
		evidence: { [`task_evidence_1`]: { choice: "a1", confidence: 0.9 } },
	}, board, 0.5, 20, [], { context: { ...base, records: [user, assistant] } });
	assert.equal(done.kind, "notify");
	const claim = decide({
		alignment: { choice: "no_in_progress_task", confidence: 0.9 },
		current_match: { choice: "1", confidence: 0.9 },
		drift: { choice: "on_track", confidence: 0.9 },
		interaction: { choice: "working", confidence: 0.9 },
		work_evidence: { choice: "t1", confidence: 0.9 },
		board_warranted: { choice: "warranted", confidence: 0.9 },
		lifecycle: { [lifecycleKey(1)]: { choice: "actionable_now", confidence: 0.9 } },
		evidence: { task_evidence_1: { choice: "t1", confidence: 0.9 } },
	}, board, 0.5, 20, [], { context: base });
	assert.equal(claim.kind, "inject");
	assert.match(claim.text, /in_progress/);
	assert.equal(claim.mayWake, true);
	const again = decide({
		alignment: { choice: "no_in_progress_task", confidence: 0.9 },
		current_match: { choice: "1", confidence: 0.9 },
		drift: { choice: "on_track", confidence: 0.9 },
		interaction: { choice: "working", confidence: 0.9 },
		work_evidence: { choice: "t1", confidence: 0.9 },
		board_warranted: { choice: "warranted", confidence: 0.9 },
		lifecycle: { [lifecycleKey(1)]: { choice: "actionable_now", confidence: 0.9 } },
		evidence: { task_evidence_1: { choice: "t1", confidence: 0.9 } },
	}, board, 0.5, 20, [], { context: base, suppressed: new Set(claim.corrections.map((c) => c.key)) });
	assert.equal(again.kind, "silent");
});

test("request asks one lifecycle question per unfinished task and recovers once on overflow", async () => {
	const board = { tasks: [{ id: 3, subject: "Audit", status: "in_progress", activeForm: "reading" }], nextId: 4, inProgressSince: new Map() };
	const req = buildAuditRequest(board, "did the work", "jev-latest");
	assert.ok(req.questions.task_status_3);
	assert.ok(req.questions.task_granularity_3);
	assert.equal(req.questions.board_warranted, undefined);
	let calls = 0;
	const fetchFn = async () => {
		calls++;
		if (calls === 1) {
			return { ok: false, status: 422, text: async () => JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), json: async () => ({}) };
		}
		return { ok: true, status: 200, json: async () => ({ answers: { alignment: { choice: "aligned", confidence: 0.8 } } }) };
	};
	const context = collectContext([{ id: "u", type: "message", message: { role: "user", content: "go" } }], [], true, []);
	const reducedProbe = reduceContext({ ...context, records: [...context.records, { id: "h", kind: "tool_result", text: "old", protected: false, complete: true }] });
	assert.equal(reducedProbe.reduced, true);
	const out = await runAudit(req, { apiUrl: "https://example.invalid", apiKey: "sek", timeoutMs: 1000, maxRetries: 0, fetchFn });
	assert.equal(out.ok, false);
	assert.equal(out.contextOverflow, true);
});

test("DSH messages become the same entry kinds the collector already scored", () => {
	const entries = entriesFromMessages([
		{ id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "fix #1" }] },
		{ id: "a", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "todo", arguments: "{\"action\":\"list\"}" }, { type: "text", text: "looking" }] },
		{ id: "r", role: "tool", toolCallId: "c1", content: [{ type: "text", text: "No tasks" }], isError: false },
		{ id: "adv", role: "user", source: { kind: "jev-todo-audit" }, content: [{ type: "text", text: "prior advice" }] },
	]);
	const ctx = collectContext(entries, [], true, []);
	assert.ok(ctx.records.some((r) => r.kind === "user" && r.text.includes("fix #1")));
	assert.ok(ctx.records.some((r) => r.kind === "tool_result" && r.toolName === "todo"));
	assert.ok(ctx.records.some((r) => r.advice === true));
});

test("/todos groups like Pi and the panel mirror drops tombstones", () => {
	const state = {
		tasks: [
			{ id: 1, subject: "Wait", status: "pending", blockedBy: [2] },
			{ id: 2, subject: "Run", status: "in_progress", activeForm: "running tests" },
			{ id: 3, subject: "Gone", status: "deleted" },
			{ id: 4, subject: "Done", status: "completed" },
		],
		nextId: 5,
	};
	const text = formatTodosCommand(state);
	assert.match(text, /1\/3 completed/);
	assert.match(text, /◐ #2 Run \(running tests\)/);
	assert.match(text, /⛓ #2/);
	assert.doesNotMatch(text, /Gone/);
	const writes = [];
	mirrorPanel({ append: (type, data) => writes.push({ type, data }) }, state);
	assert.equal(writes[0].type, "todo/write");
	assert.equal(writes[0].data.todos.length, 3);
	assert.equal(writes[0].data.todos.find((t) => t.content.startsWith("#2")).status, "in_progress");
	const padded = {
		tasks: [{ id: 1, subject: "  padded  ", status: "pending", activeForm: "  x  " }],
		nextId: 2,
	};
	writes.length = 0;
	mirrorPanel({ append: (type, data) => writes.push({ type, data }) }, padded);
	assert.equal(writes[0].data.todos[0].content, "#1   padded");
	assert.equal(writes[0].data.todos[0].content.trim(), writes[0].data.todos[0].content);
});

test("config defaults and key order: credentials, env without service, config", async () => {
	const cfg = resolveAuditConfig({});
	assert.equal(cfg.interval, 10);
	assert.equal(cfg.cooldownLoops, 10);
	assert.equal(cfg.maxRetries, 10);
	assert.equal(cfg.model, "jev-latest");
	assert.equal(await resolveApiKey({ ...cfg, apiKey: "cfg-key" }, undefined, { TYPESAFE_API_KEY: " env-key " }), "env-key");
	assert.equal(await resolveApiKey({ ...cfg, apiKey: "cfg-key" }, undefined, {}), "cfg-key");
	const creds = { resolve: async (ref) => (ref === "TYPESAFE_API_KEY" ? { value: "stored" } : undefined) };
	assert.equal(await resolveApiKey(cfg, creds, { TYPESAFE_API_KEY: "ignored" }), "stored");
	assert.equal(await resolveApiKey(cfg, { resolve: async () => undefined }, {}), undefined);
	assert.equal(parseUserReady({ stopKind: "AI_UNLOCK", reason: "done" }).stopKind, "AI_UNLOCK");
	assert.equal(parseUserReady({ stopKind: "HUMAN_ABORT" }), undefined);
});

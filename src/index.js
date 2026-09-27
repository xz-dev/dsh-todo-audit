/**
 * dsh-todo-audit — Cordis plugin.
 *
 * Registers the rpiv-todo `todo` tool (the TUI bundle disables built-in
 * `todo_write`) and the jev board audit. Advisory only: audit failures never
 * throw into the agent loop.
 */

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { inProgressTasks, staleTaskIds, unfinishedTasks, visibleTasks } from "./audit/board.js";
import { replayBoardWithAges } from "./store.js";
import { resolveApiKey, resolveAuditConfig } from "./audit/config.js";
import { collectContext, digest, entriesFromMessages, redact, ADVICE_CUSTOM_TYPE } from "./audit/context.js";
import { replayCounter, shouldAudit } from "./audit/counter.js";
import { parseUserReady } from "./audit/stops.js";
import { auditWithContext } from "./audit/typesafe.js";
import { decide } from "./audit/verdict.js";
import { TodoStore } from "./store.js";
import { registerTodoPromptSection, registerTodosCommand, registerTodoTool } from "./todo.js";

export const name = "dsh-todo-audit";
export const inject = ["tools", "commands", "systemPrompt", "agents"];

const ADVICE_SOURCE = ADVICE_CUSTOM_TYPE;

export { parseUserReady };

function adviceMessage(text, auditKeys) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: {
			kind: ADVICE_SOURCE,
			form: "notice",
			summary: "todo board audit",
			auditKeys,
		},
	});
}

export function apply(ctx, config = {}) {
	const todoCfg = {
		enabled: config.todo?.enabled !== false,
		panelMirror: config.todo?.panelMirror !== false,
	};
	const auditCfg = resolveAuditConfig(config.audit ?? {});
	const store = new TodoStore();

	if (todoCfg.enabled) {
		registerTodoTool(ctx, store, todoCfg);
		registerTodosCommand(ctx, store);
		registerTodoPromptSection(ctx);
	}
	if (!auditCfg.enabled) return;

	const flight = new Map(); // agentId -> AbortController
	const sentKeys = new Map(); // agentId -> Set
	const noticeKeys = new Set();
	const lastStopKey = new Map();
	const pendingStop = new Map();
	let warnedBudget = false;
	let warnedKey = false;

	const log = (level, text) => {
		try { ctx.logger?.[level]?.(text); } catch { /* logger optional in tests */ }
	};

	if (auditCfg.activityBudgetChars !== undefined && !warnedBudget) {
		warnedBudget = true;
		log("warn", "[jev-todo-audit] activityBudgetChars is deprecated and ignored; only provider context admission limits evidence size.");
	}

	function keysFor(id) {
		let set = sentKeys.get(id);
		if (!set) { set = new Set(); sentKeys.set(id, set); }
		return set;
	}

	function restoreKeys(session) {
		const set = keysFor(session.id);
		for (const e of session.snapshotEvents()) {
			if (e.type !== "user/message") continue;
			const src = e.data?.source;
			if (src?.kind !== ADVICE_SOURCE) continue;
			for (const key of Array.isArray(src.auditKeys) ? src.auditKeys : []) {
				if (typeof key === "string") set.add(key);
			}
		}
	}

	function contextFor(session, board, apiKey) {
		let messages = [];
		let globalComplete = true;
		try {
			messages = session.deriveMessages();
		} catch {
			globalComplete = false;
			messages = [];
		}
		return collectContext(
			entriesFromMessages(messages),
			visibleTasks(board).map((task) => ({ id: `task:${task.id}`, value: task })),
			globalComplete,
			[apiKey ?? ""],
		);
	}

	async function auditNow(agent, label, opts = {}) {
		if (!auditCfg.enabled || !agent?.session) return "skipped";
		const id = agent.session.id ?? agent.id;
		if (flight.has(id)) return "in-flight";
		const apiKey = resolveApiKey(auditCfg);
		if (!apiKey) {
			if (!warnedKey) {
				warnedKey = true;
				log("warn", `[jev-todo-audit] no API key: set ${auditCfg.apiKeyEnvVar} or apiKey (Pi jev-todo-audit.json is read when present)`);
			}
			return "no-key";
		}
		const ac = new AbortController();
		flight.set(id, ac);
		const session = agent.session;
		const boundary = () => digest({
			id,
			board: replayBoardWithAges(session.snapshotEvents()).tasks,
		});
		const started = boundary();
		try {
			const board = replayBoardWithAges(session.snapshotEvents());
			if (opts.terminalStop && unfinishedTasks(board).length === 0) return "empty-board";
			const c = replayCounter(session.snapshotEvents());
			const initial = contextFor(session, board, apiKey);
			const staleIds = staleTaskIds(board, c.totalLoops, auditCfg.interval, auditCfg.staleAuditSpans);
			for (const task of inProgressTasks(board)) {
				const record = initial.records.find((r) => r.id === `task:${task.id}`);
				if (record) record.text += `\nAge review: ${c.totalLoops - (board.inProgressSince.get(task.id) ?? c.totalLoops)} loops; review flag=${staleIds.includes(task.id)}. Age alone does not justify splitting.`;
			}
			const { result: res, context } = await auditWithContext(
				board,
				initial,
				auditCfg.model,
				{
					apiUrl: auditCfg.apiUrl,
					apiKey,
					timeoutMs: auditCfg.timeoutMs,
					signal: ac.signal,
					maxRetries: auditCfg.maxRetries,
					baseDelayMs: auditCfg.baseDelayMs,
				},
				opts.terminalStop,
			);
			if (ac.signal.aborted || boundary() !== started || ctx.agents?.get?.(id) !== agent && ctx.agents?.get?.(agent.id) !== agent) {
				return "stale";
			}
			if (!res.ok) {
				log("warn", `[jev audit ${label}] failed: ${redact(res.error, [apiKey])}`);
				return "failed";
			}
			restoreKeys(session);
			const action = decide(res.answers, board, auditCfg.confidenceThreshold, c.totalLoops, staleIds, {
				terminalStop: !!opts.terminalStop,
				context,
				suppressed: keysFor(id),
				scopeKey: id,
			});
			if (action.kind === "notify") {
				const key = digest([id, action.text]);
				if (!noticeKeys.has(key)) {
					log("info", action.text);
					noticeKeys.add(key);
				}
				return "notify";
			}
			if (action.kind === "inject") {
				if (ac.signal.aborted) return "stale";
				const auditKeys = action.corrections.map((item) => item.key);
				const message = adviceMessage(action.text, auditKeys);
				// Pi: steer without triggerTurn on periodic/manual; wake only for a
				// terminal stop that may execute or bookkeep. DSH inject queues
				// without starting an idle turn; steer wakes an idle driver.
				const wake = !!(opts.terminalStop && action.mayWake);
				if (wake) agent.steer(message);
				else agent.inject(message);
				for (const key of auditKeys) keysFor(id).add(key);
				log("info", `[jev audit ${label}] correction injected`);
				return "inject";
			}
			if (auditCfg.notifyOnAligned && res.answers.alignment?.choice === "aligned" &&
				(res.answers.alignment.confidence ?? 0) >= auditCfg.confidenceThreshold) {
				log("info", `[jev audit ${label}] board aligned`);
			}
			return "silent";
		} catch (err) {
			if (!ac.signal.aborted) log("warn", `[jev audit ${label}] error: ${redact(err instanceof Error ? err.message : String(err), [apiKey])}`);
			return "error";
		} finally {
			flight.delete(id);
			const queued = pendingStop.get(id);
			if (queued && ctx.agents?.get?.(id) === agent) {
				pendingStop.delete(id);
				lastStopKey.set(id, queued.key);
				void auditNow(agent, "terminal-stop", { terminalStop: queued.stop });
			}
		}
	}

	function onAssistant(session) {
		const agent = ctx.agents?.get?.(session.id);
		if (!agent) return;
		const c = replayCounter(session.snapshotEvents());
		if (!shouldAudit(c, auditCfg.interval, auditCfg.cooldownLoops) || flight.has(session.id)) return;
		void auditNow(agent, `@ loop ${c.totalLoops}`);
	}

	ctx.on("session/event", (session, event) => {
		if (event.type === "user/message" && event.data?.source?.kind === "user") {
			flight.get(session.id)?.abort();
			lastStopKey.delete(session.id);
			pendingStop.delete(session.id);
			return;
		}
		if (event.type === "assistant/message") onAssistant(session);
	});

	ctx.on("agent/created", ({ agent }) => {
		flight.get(agent.id)?.abort();
		sentKeys.delete(agent.id);
		lastStopKey.delete(agent.id);
		pendingStop.delete(agent.id);
		try { restoreKeys(agent.session); } catch { /* session not readable yet */ }
		if (!resolveApiKey(auditCfg) && !warnedKey) {
			warnedKey = true;
			log("warn", `[jev-todo-audit] no API key: set ${auditCfg.apiKeyEnvVar} or apiKey (Pi jev-todo-audit.json is read when present)`);
		}
	});

	// No DSH equivalent of pi:semantic-hook:v1. A later watchdog port emits this.
	ctx.on("todo-audit/user-ready", (payload) => {
		try {
			const stop = parseUserReady(payload);
			const agent = payload?.agent ?? ctx.agents?.get?.(payload?.agentId);
			if (!stop || !agent?.session) return;
			const id = agent.session.id ?? agent.id;
			const board = replayBoardWithAges(agent.session.snapshotEvents());
			const key = digest([id, board.tasks]);
			if (key === lastStopKey.get(id) || key === pendingStop.get(id)?.key) return;
			if (flight.has(id)) {
				pendingStop.set(id, { key, stop });
				return;
			}
			lastStopKey.set(id, key);
			void auditNow(agent, "terminal-stop", { terminalStop: stop });
		} catch {
			// Malformed payloads must never disturb the agent lifecycle.
		}
	});

	ctx.commands.register({
		name: "jev-audit",
		description: "Run a jev todo-board audit now (ignores interval and cooldown)",
		handler: async ({ agent }) => {
			const status = await auditNow(agent, "manual");
			return { kind: "success", text: `jev audit: ${status}` };
		},
	});
}


/**
 * Evidence collection for the audit — pi-jev-todo-audit context.ts (MIT,
 * Xiangzhe) with the input seam adapted: Pi walked branch entries; DSH's
 * compaction-aware effective context is `session.deriveMessages()`, so an
 * adapter (`entriesFromMessages`) first translates derived messages into the
 * same entry shapes the unchanged selection algorithm consumes.
 *
 * Role mapping: human prompts (user/message, source.kind "user") stay "user";
 * compaction checkpoints become "compaction" summaries; injected/steered
 * user-role messages (including this plugin's own advice) become visible
 * "custom_message" entries keyed by source kind; assistant text/tool-call
 * blocks and tool results map to their Pi counterparts.
 */

import { createHash } from "node:crypto";

/** customType marking this plugin's own advice — same literal as Pi. */
export const ADVICE_CUSTOM_TYPE = "jev-todo-audit";

export const object = (v) =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};

/** Redact recognizable secrets, not arbitrary prose that happens to say "token". */
export function redact(text, secrets = []) {
	return secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join("[REDACTED]"), text)
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
		.replace(/\bBearer\s+[^\s"'`,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
		.replace(/(\b(?:[A-Z_]+_)?(?:api[_-]?key|api[_-]?token|password|passwd|access[_-]?token|refresh[_-]?token|secret(?:[_-]?access[_-]?key)?|clientSecret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}]+)/gi, "$1[REDACTED]")
		.replace(/((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
		.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

/** Session data is JSON; also contain malformed/cyclic supplemental values. */
export function safeJson(value, secrets = []) {
	const ancestors = [];
	try {
		return JSON.stringify(value, function (key, v) {
			if (/(?:^|[_-])(?:api[_-]?key|api[_-]?token|token|authorization|proxy-authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key|secret[_-]?access[_-]?key|cookie|set-cookie)$|^clientSecret$/i.test(key)) return "[REDACTED]";
			if (/^(?:thinking|chain_of_thought)$/i.test(key) || ["thinking", "reasoning", "image", "audio", "video", "Buffer"].includes(object(v).type) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return "[unavailable: non-text/private content]";
			if (typeof v === "object" && v !== null) {
				while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
				if (ancestors.includes(v)) return "[unavailable: circular value]";
				ancestors.push(v);
			}
			return typeof v === "string" ? redact(v, secrets) : typeof v === "bigint" ? String(v) : v;
		}) ?? "null";
	} catch {
		return "[unavailable: serialization failed]";
	}
}

function visibleText(content) {
	if (typeof content === "string") return redact(content);
	if (!Array.isArray(content)) return "";
	return content.map((raw) => {
		const b = object(raw);
		if (b.type === "text") return typeof b.text === "string" ? redact(b.text) : "[unavailable: invalid text]";
		if (b.type === "thinking" || b.type === "toolCall") return "";
		return "[unavailable: unsupported content]";
	}).filter(Boolean).join("\n");
}

export const digest = (v) => createHash("sha256").update(safeJson(v)).digest("hex");

/**
 * Translate DSH derived messages (`session.deriveMessages()`) into the
 * Pi-style entry stream the collector below was built against. Tool names on
 * tool results are resolved from earlier assistant tool-call blocks.
 */
export function entriesFromMessages(messages) {
	const entries = [];
	const callNames = new Map(); // callId -> tool name
	for (const m of messages) {
		const id = typeof m.id === "string" ? m.id : `msg-${entries.length}`;
		const sourceKind = m.source?.kind;
		if (m.role === "system") continue; // Pi: role system skipped without omission
		if (m.role === "developer") {
			entries.push({ id, type: "developer", message: { role: "developer" } });
			continue;
		}
		if (m.role === "user") {
			if (sourceKind === "compact-checkpoint") {
				entries.push({ id, type: "compaction", summary: visibleText(m.content) });
			} else if (sourceKind === "user") {
				entries.push({ id, type: "message", message: { role: "user", content: m.content } });
			} else {
				entries.push({
					id,
					type: "custom_message",
					content: m.content,
					customType: typeof sourceKind === "string" ? sourceKind : "unknown",
					display: true,
				});
			}
			continue;
		}
		if (m.role === "assistant") {
			const content = (Array.isArray(m.content) ? m.content : []).map((b) => {
				const block = object(b);
				if (block.type === "text") return { type: "text", text: block.text };
				if (block.type === "reasoning") return { type: "thinking" };
				if (block.type === "tool-call") {
					callNames.set(block.id, block.name);
					let args = block.arguments;
					try { args = JSON.parse(block.arguments); } catch { /* keep raw string */ }
					return { type: "toolCall", id: block.id, name: block.name, arguments: args };
				}
				return { type: block.type };
			});
			entries.push({ id, type: "message", message: { role: "assistant", content } });
			continue;
		}
		if (m.role === "tool") {
			entries.push({
				id,
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: m.toolCallId,
					toolName: callNames.get(m.toolCallId),
					content: m.content,
					isError: m.isError === true,
				},
			});
			continue;
		}
		entries.push({ id, type: "message", message: { role: "unknown", content: m.content } });
	}
	return entries;
}

/** Generic public session collector. Supplements are data, not a tool schema. */
export function collectContext(
	entries,
	supplements = [],
	globalComplete = true,
	secrets = [],
) {
	const candidates = [];
	const omissions = [];
	const calls = new Map();
	let lastAssistant = "", lastAssistantText = "", lastToolGroup = "", lastUser = "", lastCustom = "";
	const decisionGroups = new Set();
	let index = 0;
	const add = (id, kind, text, group = id, extra = {}) => {
		if (!text.trim()) return;
		text = redact(text, secrets);
		candidates.push({ id, kind, text, group, view: "global", protected: false, request: lastUser,
			complete: !/\[REDACTED\]|\[unavailable:/.test(text), ...extra });
	};
	for (const raw of entries) {
		const e = object(raw);
		const id = typeof e.id === "string" ? e.id : `entry-${index}`;
		index++;
		if (e.type === "compaction" || e.type === "branch_summary") {
			if (typeof e.summary !== "string" || !e.summary.trim()) {
				globalComplete = false;
				omissions.push({ id, reason: "summary unavailable" });
			} else add(id, "summary", redact(e.summary), id, { protected: true });
			continue;
		}
		if (e.type === "custom_message") {
			if (e.display !== false) {
				lastCustom = id;
				add(id, "custom", visibleText(e.content), id, { advice: e.customType === ADVICE_CUSTOM_TYPE, producer: e.customType });
			}
			continue;
		}
		if (e.type !== "message") {
			omissions.push({ id, reason: e.type === "custom" ? "private extension state" : "unsupported/non-conversation entry" });
			continue;
		}
		const m = object(e.message);
		if (m.role === "user") {
			lastUser = id;
			if (lastAssistantText) decisionGroups.add(`${lastAssistantText}:text`); // Preserve the question answered by "yes", not unrelated tool payloads.
			add(id, "user", visibleText(m.content), id, { protected: true });
		} else if (m.role === "assistant") {
			lastAssistant = id;
			const text = visibleText(m.content);
			if (text) lastAssistantText = id;
			add(id, "assistant", text, `${id}:text`);
			for (const [n, rawBlock] of (Array.isArray(m.content) ? m.content : []).entries()) {
				const b = object(rawBlock);
				if (b.type !== "toolCall") continue;
				const callId = typeof b.id === "string" ? b.id : `${id}-${n}`;
				calls.set(callId, id);
				add(`${id}:call:${callId}`, "tool_call", safeJson({ name: b.name, arguments: b.arguments }), id,
					{ callId, toolName: b.name, complete: false });
			}
		} else if (m.role === "toolResult") {
			const callId = typeof m.toolCallId === "string" ? m.toolCallId : "";
			const group = calls.get(callId) ?? id;
			lastToolGroup = group;
			add(id, "tool_result", visibleText(m.content), group, { callId, toolName: m.toolName, isError: m.isError === true });
		} else if (m.role === "custom" && m.display !== false) {
			lastCustom = id;
			add(id, "custom", visibleText(m.content), id, { advice: m.customType === ADVICE_CUSTOM_TYPE, producer: m.customType });
		} else if (m.role === "bashExecution" && !m.excludeFromContext) {
			lastToolGroup = id;
			add(id, "shell", safeJson({ command: m.command, output: m.output, exitCode: m.exitCode, cancelled: m.cancelled }), id,
				{ isError: m.cancelled === true || (typeof m.exitCode === "number" && m.exitCode !== 0) });
		} else if (m.role !== "system") omissions.push({ id, reason: "unsupported or context-excluded message" });
	}
	const latestUser = candidates.find((r) => r.id === lastUser)?.text ?? "";
	// Exact artifact/task references, never a title-similarity score or tool allowlist.
	const references = (text) => text.match(/https?:\/\/[^\s"<>]+|\b(?:[\w@.-]+\/)*[\w@.-]+\.[a-zA-Z0-9]+\b|#\d+\b/g) ?? [];
	const refs = new Set(references(safeJson(supplements.map((s) => s.value)) + "\n" + latestUser));
	const linkedRequests = new Set(candidates.filter((r) => r.kind === "user" &&
		(r.id === lastUser || !references(r.text).length || references(r.text).some((ref) => refs.has(ref)))).map((r) => r.id));
	const recentGroups = new Set([lastUser, lastAssistant, lastAssistant && `${lastAssistant}:text`, lastToolGroup, lastCustom].filter(Boolean));
	const groups = new Map();
	for (const r of candidates) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
	const selected = new Set(), protectedGroups = new Set();
	const selections = new Map();
	for (const [group, rows] of groups) {
		const required = recentGroups.has(group) || decisionGroups.has(group) || rows.some((r) => r.protected);
		const related = rows.some((r) => [...refs].some((ref) => r.text.includes(ref)));
		const inputs = rows.filter((r) => r.kind === "tool_call" || r.kind === "shell");
		const inputRefs = references(inputs.map((r) => r.text).join("\n"));
		const request = inputs[0]?.request ?? rows[0].request;
		// A generic result can inherit its retained user request's scope. An
		// explicitly unrelated artifact is not pulled in merely by proximity.
		const conversationLinked = rows.some((r) => ["tool_call", "tool_result", "shell", "custom"].includes(r.kind)) &&
			linkedRequests.has(request ?? "") && (!inputRefs.length || inputRefs.some((ref) => refs.has(ref)));
		const failure = rows.some((r) => r.isError) && (related || conversationLinked);
		if (required || related || conversationLinked) selected.add(group);
		if (required || failure) protectedGroups.add(group);
		selections.set(group, required ? "current interaction or retained decision/summary" : related ? "explicit task/artifact link" :
			"retained request/call chain; exact task relationship uncertain");
	}
	const signatures = new Map();
	for (const [group, rows] of [...groups].reverse()) {
		if (!selected.has(group) || rows.some((r) => r.kind === "user")) continue;
		const key = digest(rows.map(({ kind, text, isError }) => ({ kind, text, isError })));
		if (signatures.has(key) && !protectedGroups.has(group)) {
			selected.delete(group);
			for (const r of rows) omissions.push({ id: r.id, reason: `duplicate of ${signatures.get(key)}` });
		} else signatures.set(key, group);
	}
	const records = candidates.filter((r) => {
		if (selected.has(r.group)) return true;
		if (!omissions.some((o) => o.id === r.id)) omissions.push({ id: r.id, reason: "unlinked historical background; not proof of absence" });
		return false;
	}).map((r) => ({ ...r, view: recentGroups.has(r.group) ? "recent" : "global",
		protected: protectedGroups.has(r.group), selection: selections.get(r.group) }));
	for (const r of records.filter((r) => r.kind === "tool_call")) {
		const result = records.find((x) => x.kind === "tool_result" && x.callId === r.callId);
		// Calls are intentions, not proof that their execution succeeded.
		if (!result) omissions.push({ id: r.id, reason: "tool result unavailable" });
	}
	for (const s of supplements) {
		const text = safeJson(s.value, secrets);
		records.push({ id: s.id, kind: "supplement", text, group: s.id, view: "task", protected: true,
			complete: !/\[REDACTED\]|\[unavailable:/.test(text) });
	}
	for (const r of [...candidates, ...records.filter((r) => r.kind === "supplement")]) {
		if (!r.complete && r.kind !== "tool_call") omissions.push({ id: r.id, reason: r.text.includes("[REDACTED]") ? "redacted evidence" : "unavailable: unsupported/serialization gap" });
	}
	if (!globalComplete) omissions.push({ id: "global", reason: "effective compaction-aware context unavailable" });
	return { records, omissions, globalComplete, reduced: false, userBoundary: lastUser };
}

/** One coherent recovery packet, only after the server explicitly rejects context size. */
export function reduceContext(context) {
	const removed = context.records.filter((r) => !r.protected);
	if (context.reduced || !removed.length) return undefined;
	return {
		...context,
		records: context.records.filter((r) => r.protected),
		omissions: [...context.omissions, ...removed.map((r) => ({ id: r.id, reason: "provider hard-limit recovery" }))],
		globalComplete: false,
		reduced: true,
	};
}

/** Advice/acknowledgments and board bookkeeping are not new execution evidence. */
export function workVersion(context, bookkeepingTools = new Set()) {
	return digest({ userBoundary: context.userBoundary, records: context.records.filter((r) => r.kind === "user" ||
		(r.kind === "tool_result" && !bookkeepingTools.has(r.toolName ?? "")) || r.kind === "shell" ||
		(r.kind === "custom" && !r.advice)).map(({ id, text, isError }) => ({ id, text, isError })) });
}

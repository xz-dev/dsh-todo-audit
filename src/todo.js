/**
 * `todo` tool + `/todos` command + system-prompt guidance section.
 *
 * Semantic port of rpiv-todo (MIT, juicesharp) onto DSH seams:
 * - tool registration: ctx.tools.register(defineTool(...))
 * - durable snapshot: output.presentationMeta -> persisted `tool/result` meta
 * - live panel: a flattened compat `todo/write` event mirrors every mutation,
 *   so the dsh-tui goal/todo panel (which folds raw `todo/write` log events)
 *   renders the same list the model maintains.
 * - guidance: Pi's promptSnippet/promptGuidelines ride a system-prompt
 *   section (Pi shows them next to the tool listing; DSH defineTool carries
 *   description only).
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { applyTaskMutation, buildEnvelope, sanitizeTerminalText } from "./state.js";

export const TOOL_NAME = "todo";
export const COMMAND_NAME = "todos";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Several tasks may be in_progress at once when work runs in parallel.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

const TOOL_DESCRIPTION =
	"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.";

const STATUS_ENUM = ["pending", "in_progress", "completed", "deleted"];
const ACTION_ENUM = ["create", "update", "list", "get", "delete", "clear"];

const TASK_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: "integer", required: true },
		subject: { type: "string", required: true },
		status: { type: "string", required: true, enum: STATUS_ENUM },
		description: { type: "string" },
		activeForm: { type: "string" },
		owner: { type: "string" },
		blockedBy: { type: "array", items: { type: "integer" } },
		metadata: { type: "object", additionalProperties: true },
		completedSeq: { type: "integer" },
	},
};

const ENVELOPE_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", required: true, enum: ACTION_ENUM },
		params: { type: "object", required: true, additionalProperties: true },
		tasks: { type: "array", required: true, items: TASK_VALUE_SCHEMA },
		nextId: { type: "integer", required: true },
		error: { type: "string" },
	},
};

const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		text: { type: "string", required: true },
		envelope: { ...ENVELOPE_VALUE_SCHEMA, required: true },
	},
};

const ACTION_GLYPH = { create: "+", update: "→", delete: "×", get: "›", list: "☰", clear: "∅" };

/** Flatten one task to the `{content, status}` row the dsh-tui todo panel folds. */
function panelContent(t) {
	let text = `#${t.id} ${sanitizeTerminalText(t.subject)}`;
	if (t.status === "in_progress" && t.activeForm) text += ` (${sanitizeTerminalText(t.activeForm)})`;
	if (t.blockedBy?.length) text += ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`;
	// dsh-tool-todo invariant: content must be trimmed, non-empty, unique.
	text = text.trim();
	return text.length > 0 ? text : `#${t.id}`;
}

/**
 * Mirror the visible board to a `todo/write` whole-list snapshot so the
 * dsh-tui goal/todo panel updates live. `deleted` tombstones are hidden;
 * `completed` rows stay (the panel owns folding). Statuses map 1:1 except
 * `deleted`, which has no todo/write equivalent and is simply omitted.
 */
export function mirrorPanel(session, state) {
	const todos = state.tasks
		.filter((t) => t.status !== "deleted")
		.map((t) => ({ content: panelContent(t), status: t.status }));
	session.append("todo/write", { todos });
}

export function registerTodoTool(ctx, store, config) {
	ctx.tools.register(
		defineTool({
			name: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			parameters: {
				action: { type: "string", required: true, enum: ACTION_ENUM, description: "Action to perform" },
				subject: { type: "string", description: "Task subject line (required for create)" },
				description: { type: "string", description: "Long-form task description" },
				activeForm: {
					type: "string",
					description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
				},
				status: {
					type: "string",
					enum: STATUS_ENUM,
					description:
						"Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
				},
				blockedBy: { type: "array", items: { type: "integer" }, description: "Initial blockedBy ids (create only)" },
				addBlockedBy: {
					type: "array",
					items: { type: "integer" },
					description: "Task ids to add to blockedBy (update only, additive merge)",
				},
				removeBlockedBy: {
					type: "array",
					items: { type: "integer" },
					description: "Task ids to remove from blockedBy (update only, additive merge)",
				},
				owner: { type: "string", description: "Agent/owner assigned to this task" },
				metadata: {
					type: "object",
					additionalProperties: true,
					description: "Arbitrary metadata; pass null value for a key to delete that key on update",
				},
				id: { type: "integer", description: "Task id (required for update, get, delete)" },
				includeDeleted: {
					type: "boolean",
					description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
				},
			},
			output: {
				schema: OUTPUT_SCHEMA,
				render: (_args, value) => [{ type: "text", text: value.text }],
				// The full envelope (tasks + nextId + error) is the replay snapshot.
				presentationMeta: (_args, value) => value.envelope,
			},
			async execute(args, exec) {
				if (!exec.agent) throw new Error("todo requires an owning agent session");
				const session = exec.agent.session;
				const { action, ...rest } = args;
				const params = {};
				for (const [k, v] of Object.entries(rest)) if (v !== undefined) params[k] = v;
				const result = applyTaskMutation(store.get(session), action, params);
				store.commit(session, result.state);
				const { text, envelope } = buildEnvelope(action, params, result.state, result.op);
				if (config.panelMirror !== false && result.op.kind !== "error") {
					try {
						mirrorPanel(session, result.state);
					} catch {
						// Panel mirror is best-effort; the durable envelope is authoritative.
					}
				}
				return { text, envelope };
			},
			presentCall: (args) => ({
				card: "generic",
				title: `todo ${ACTION_GLYPH[args?.action] ?? args?.action ?? ""}`.trim(),
				kind: "other",
				rawInput: args,
			}),
		}),
	);
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

const STATUS_LABEL = { pending: "pending", in_progress: "in progress", completed: "completed", deleted: "deleted" };

function formatCommandTaskLine(t, glyph) {
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	return `  ${glyph} #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

/** /todos body text for one task state — the same text Pi's handler notified. */
export function formatTodosCommand(state) {
	const visible = state.tasks.filter((t) => t.status !== "deleted");
	if (visible.length === 0) return MSG_NO_TODOS;
	const counts = {
		pending: visible.filter((t) => t.status === "pending").length,
		inProgress: visible.filter((t) => t.status === "in_progress").length,
		completed: visible.filter((t) => t.status === "completed").length,
	};
	const groups = {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
	const header = [];
	if (counts.completed > 0) header.push(`${counts.completed}/${visible.length} ${STATUS_LABEL.completed}`);
	if (counts.inProgress > 0) header.push(`${counts.inProgress} ${STATUS_LABEL.in_progress}`);
	if (counts.pending > 0) header.push(`${counts.pending} ${STATUS_LABEL.pending}`);
	const lines = [header.join(" · ")];
	if (groups.pending.length > 0) {
		lines.push(SECTION_PENDING);
		for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
	}
	if (groups.inProgress.length > 0) {
		lines.push(SECTION_IN_PROGRESS);
		for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
	}
	if (groups.completed.length > 0) {
		lines.push(SECTION_COMPLETED);
		for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
	}
	return lines.join("\n");
}

export function registerTodosCommand(ctx, store) {
	ctx.commands.register({
		name: COMMAND_NAME,
		description: "Show all todos on the current branch, grouped by status",
		handler: ({ agent }) => {
			return { kind: "success", text: formatTodosCommand(store.get(agent.session)) };
		},
	});
}

// ---------------------------------------------------------------------------
// System-prompt guidance (Pi's promptSnippet + promptGuidelines)
// ---------------------------------------------------------------------------

export function registerTodoPromptSection(ctx) {
	ctx.systemPrompt.section({
		name: "todo-guidance",
		order: 900,
		interpolate: false,
		text: `## Todo tool\n\n${DEFAULT_PROMPT_SNIPPET}.\n\n${DEFAULT_PROMPT_GUIDELINES.map((g) => `- ${g}`).join("\n")}`,
	});
}

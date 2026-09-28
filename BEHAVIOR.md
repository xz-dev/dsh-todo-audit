# Behaviour checklist

Sources: `~/Code/ai/rpiv-todo-release` (rpiv-todo), `~/.pi/agent/git/github.com/xz-dev/pi-jev-todo-audit`, `~/.pi/agent/git/github.com/xz-dev/rpiv-mono` `ask_user_question`. User config: packages include those three; `~/.pi/agent/jev-todo-audit.json` is `{ apiKey }` only; `settings.retry` is enabled, `maxRetries` 10, no `baseDelayMs` (Pi default 2000).

| item | Pi evidence | DSH mapping | status | test |
| --- | --- | --- | --- | --- |
| `todo` create/update/list/get/delete/clear | `rpiv-todo` `tool/` + `index.ts` tool name `todo` | `src/todo.js` `defineTool` name `todo`. Built-in `todo_write` is a whole-list replace (`dsh-tool-todo` `lib/index.js`) and is **disabled** by `@deepseek-harness-tui/dsh-tui/cordis.patch.yml` id `tool-todo` `disabled: true` | ported | `test/todo.test.mjs` |
| 4-state machine pending → in_progress → completed, deleted tombstone; illegal transitions rejected | `state/invariants.ts` | `src/state.js` `VALID_TRANSITIONS` | ported | illegal completed→pending |
| `blockedBy` on create; `addBlockedBy`/`removeBlockedBy` merge; cycle, self, missing, deleted rejected | `state/task-graph.ts`, `state-reducer.ts` | `src/state.js` `detectCycle` | ported | cycle/self/missing |
| `activeForm`, `owner`, `metadata` null-deletes a key, `completedSeq` | reducer + envelope | `src/state.js` | ported | metadata + completedSeq |
| list hides deleted unless `includeDeleted`; optional `status` filter | response envelope | `formatContent` | ported | list tombstone |
| clear resets tasks and `nextId` | reducer `clear` | `src/state.js` | ported | clear |
| durable last-write-wins snapshot, no separate db | tool-result `details` | `output.presentationMeta` → `tool/result.meta` (`dsh-agent-loop` `appendToolResult` copies `result.meta`). Replay in `src/store.js` | ported | replayState |
| `/todos` grouped pending / in progress / completed | `todo.command` handler | `ctx.commands` name `todos` | ported | formatTodosCommand |
| prompt snippet + guidelines | `promptSnippet` / `promptGuidelines` | `ctx.systemPrompt.section` `todo-guidance` | ported | not asserted (static string) |
| TUI panel shows the live list | Pi overlay widget `todo-overlay.ts` (shortcut, lazy render) | mirror `session.append("todo/write", {todos})` so the dsh-tui goal panel, which folds `todo/write`, updates. Statuses map 1:1; deleted omitted. Rich fields flattened into `content` | ported (panel) | mirrorPanel |
| overlay keyboard shortcut / widget lifecycle | `todo-overlay.shortcut.test.ts` | no dsh-tui extension seam that registers a Pi-style overlay without patching `@deepseek-harness-tui/dsh-tui` | gap | — |
| in_progress age for stale review | `board.ts` `replayBoardWithAges` | `replayBoardWithAges` counts `assistant/message` (not `assistant/attempt`) | ported | age restamp |
| audit every Nth finalized assistant loop; skip when loops since latest human message ≤ cooldown | `counter.ts`, `index.ts` `turn_end` / `message_end` | `session/event`: `assistant/message` increments, `user/message` with `source.kind === "user"` resets. Advice messages use kind `jev-todo-audit` and do not reset | ported | shouldAudit |
| `/jev-audit` ignores interval and cooldown | `registerCommand` | `ctx.commands` `jev-audit` | ported | wiring only |
| jev Choice request: per unfinished task lifecycle/evidence/reconciliation; granularity only if in_progress; `board_warranted` only if nothing active | `typesafe.ts` `buildAuditRequest` | `src/audit/typesafe.js` | ported | buildAuditRequest |
| one overflow recovery, quota is not overflow, transient retry, abort | `typesafe.ts` | same, `maxRetries` 10 `baseDelayMs` 2000 from user `settings.retry` | ported | isContextOverflow + runAudit overflow flag |
| verdict gates: assistant/summary cannot prove completion; suppression keys; terminal board-only vs wake | `verdict.ts` | `src/audit/verdict.js`. Inject via `agent.inject` (no idle wake). Terminal `mayWake` uses `agent.steer` | ported | decide claim + suppress |
| advice persisted and reloaded as audit keys | custom message `details.auditKeys` | user message `source.kind = jev-todo-audit`, `source.auditKeys`, `form: notice`. Session validation allows any user source kind (`dsh-session` `assertMessageEventShape`) | ported | entriesFromMessages marks advice |
| context selection / redaction | `context.ts` | `src/audit/context.js` over `session.deriveMessages()` | ported | entries + redact |
| API key: env `TYPESAFE_API_KEY` then file `apiKey` | `config.ts` | DSH credentials ref `TYPESAFE_API_KEY` (launch env > `.credentials.yaml` > `.env`), then cordis `audit.apiKey`. Pi's `jev-todo-audit.json` is not read. Key never logged | ported | env beats file |
| trusted project `.pi/jev-todo-audit.json` tuning | `loadConfig` + `isProjectTrusted` | no DSH project-trust seam; project file not loaded | gap | — |
| terminal user-ready (`AI_UNLOCK`, `ERROR_UNLOCK`, `EXHAUSTED`, `DECISION_FAILED`) | `pi.events` `pi:semantic-hook:v1` from pi-continue-watchdog | no such hook in `dsh-hook-protocol`. Listener `todo-audit/user-ready` is implemented; nothing in this lane emits it | gap | parseUserReady rejects human abort |
| aligned/failure toasts | `ctx.ui.notify` | `ctx.logger` info/warn only. No TUI toast seam found | gap | — |
| `ask_user_question` 1–4 questions, 2–4 options, reserved labels, multiSelect, previews, Pi questionnaire widget | `rpiv-mono/tool/validate-questionnaire.ts` (`MAX_QUESTIONS=4`, `MIN_OPTIONS=2`, `MAX_OPTIONS=4`) | built-in `dsh-tool-ask-user` `lib/index.js` tool name `ask_user_question`: questions[], options[].label/description, `multi_select`, answer `selected` + `custom`. Pauses on `ctx.userQuestions`. Options are optional, no 2–4 cap, no reserved-label rejection, no preview row. UI is dsh-tui's answerer, not the Pi widget | built-in (core tool) / gap (caps, reserved labels, previews, Pi widget) | not ported; would duplicate the built-in tool and still cannot change the TUI widget |

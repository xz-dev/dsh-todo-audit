# dsh-todo-audit

DSH plugin for the Pi todo stack the user actually runs:

- [`rpiv-todo`](https://github.com/juicesharp/rpiv-todo) `todo` tool — create / update / list / get / delete / clear, 4-state machine, `blockedBy`, `activeForm`. MIT, juicesharp.
- [pi-jev-todo-audit](https://github.com/xz-dev/pi-jev-todo-audit) — periodic jev board audit. MIT, Xiangzhe.

The dsh-tui bundle already **disables** built-in `todo_write` (`cordis.patch.yml` id `tool-todo`). This plugin puts the rich tool back and mirrors each mutation to a `todo/write` snapshot so the TUI goal panel still renders.

`ask_user_question` is the built-in `@deepseek-ai/dsh-tool-ask-user`. Not reimplemented. See [BEHAVIOR.md](BEHAVIOR.md).

## Install

```sh
node ~/.local/share/dsh/npm/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile tui add file:/absolute/path/dsh-todo-audit-0.1.0.tgz --ignore-scripts
```

The package `cordis.patch.yml` inserts plugin id `todo-audit`. Keep built-in `tool-todo` disabled.

API key: `TYPESAFE_API_KEY` through the DSH credentials service (`$DSH_HOME/.credentials.yaml`, launch environment, or `.env`), or cordis `audit.apiKey` as a last resort. Never logged. Defaults: interval 10, cooldown 10, confidence 0.5, model `jev-latest`, retry 10 / 2000 ms.

## Commands

- `/todos` — board grouped by status
- `/jev-audit` — audit now, ignores interval and cooldown

## Licence

MIT. rpiv-todo © juicesharp. Audit and this port © Xiangzhe.

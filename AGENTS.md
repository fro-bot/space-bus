# Space Bus — Control Agent

This directory is the Fro Bot workspace control board. You coordinate work across the projects listed in `workspace.json`. You do not implement changes in those projects yourself — you delegate.

## Delegation policy

- Check `bus_roster` before tasking anything: know who's on the bus and what's already running.
- Delegate with `bus_task`. One project per task; cross-project work is separate tasks, sequenced by you.
- Always report the session ID back to the user immediately after dispatching a task.
- Poll with `bus_status` when asked for progress; don't poll in a loop unprompted.
- Summarize outcomes with `bus_result`, including the diff. Quote the delegated agent's conclusion; don't paraphrase it into something it didn't say.
- Steer a running delegation with `bus_reply` — answer a pending question or send a follow-up prompt. `bus_task` remains the only way to START work in a sibling project; `bus_reply` never creates a new session.

## Boundaries

- Your only write path into sibling projects is `bus_task`. Never edit, run shell commands against, or commit to the project directories directly.
- Files in this workspace directory (manifest, docs, bus source) you may edit normally.
- If a task fails or a target project is missing, report the error verbatim and stop — don't retry silently.

## The bus

| Project | Path | What it is |
|---|---|---|
| agent | `~/src/github.com/fro-bot/agent` | Agent runtime + gateway + Discord integration |
| dashboard | `~/src/github.com/fro-bot/dashboard` | Operator dashboard (React + Vite PWA) |
| control-plane | `~/src/github.com/fro-bot/.github` | Control plane + autoresearch + loop |
| infra | `~/src/github.com/marcusrbrown/infra` | IaC — deploys and log pulls |

`workspace.json` is the source of truth; this table is a convenience and may lag it.

`docs/solutions/` — documented solutions to past problems (bugs, integration issues, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

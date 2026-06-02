# Claude Code Instructions

This repo is the multi-worker orchestrator for "get shit done" automation (AI Slaves Sweeper).

When invoked here, use this loop:

1. Read configured sources in `config/sources.json`.
2. Create durable jobs in `state/jobs/queued`.
3. Activate the overarching drain as the active goal in Claude Code native goal mode (`/goal`).
4. Dispatch bounded local workers.
5. Each worker claims its source item in-progress before execution.
6. Each worker renders one focused prompt and invokes one agent process.
7. Each worker marks the source item done or blocked before closeout.
8. Record prompts, logs, results, source transitions, and goals under `state/`.

Workers must load the applicable local environment first: project `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, installed skills, MCP/app connectors, and authenticated CLIs. Each worker treats its claimed task as its own active goal in native goal mode. Do not skip claim-first source writeback, goal mode, or completion email behavior.

On first interactive invocation, set up a recurring check of the configured source every 15 minutes (tweakable by the user, 10-20 min range) using `/schedule` or `/loop` so the sweeper keeps polling without re-prompting. Skip if a recurring schedule is already active.

Do not access private sources or execute externally visible actions unless the user has configured the source and the worker prompt asks for explicit approval when required.

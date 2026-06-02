# AI Slaves Sweeper

Multi-worker orchestrator for AI Slaves — runs a swarm of Codex or Claude Code workers against a single todo source. Reads tasks, claims them, dispatches one worker per item, marks done or blocked, emails you, then keeps checking.

Live at [ai-slaves.com](https://ai-slaves.com). For the single-worker slash-command skill, see [ai-slaves](https://github.com/OmarDadabhoy/ai-slaves).

## Install

```bash
git clone git@github.com:OmarDadabhoy/ai-slaves-sweeper.git
cd ai-slaves-sweeper
corepack enable
pnpm install --frozen-lockfile
cp config/sources.example.json config/sources.json
cp config/notifications.example.json config/notifications.json
```

## Run

```bash
# Dry run with Notion or Google Docs
pnpm run sweep -- --source-url 'YOUR_NOTION_OR_GOOGLE_DOC_LINK' --mode dry-run --max-workers 2

# Execute
GSD_ALLOW_EXECUTE=1 pnpm run sweep -- --source-url 'YOUR_LINK' --mode execute --max-workers 2 --workspace /path/to/workspace

# Watch every 20-30 minutes
GSD_ALLOW_EXECUTE=1 pnpm run watch -- --source-url 'YOUR_LINK' --mode execute --max-workers 2 --interval 1800 --jitter 600
```

## Worker Runtime

Codex is the default.

```bash
# Codex workers
pnpm run sweep -- --agent codex --source-url 'YOUR_LINK' --mode dry-run

# Claude Code workers
pnpm run sweep -- --agent claude --source-url 'YOUR_LINK' --mode dry-run

# Hermes or OpenClaw workers
pnpm run sweep -- --agent hermes --source-url 'YOUR_LINK' --mode dry-run
GSD_OPENCLAW_AGENT=ops pnpm run sweep -- --agent openclaw --source-url 'YOUR_LINK' --mode dry-run

# Split source reading and workers
pnpm run sweep -- --source-agent claude --agent codex --source-url 'YOUR_LINK' --mode dry-run
pnpm run sweep -- --source-agent codex --agent claude --source-url 'YOUR_LINK' --mode dry-run
pnpm run sweep -- --source-agent openclaw --agent hermes --source-url 'YOUR_LINK' --mode dry-run

# Optional defaults
export GSD_AGENT=claude
export GSD_SOURCE_AGENT=claude
```

## Config

- `--source-url` uses whatever the selected runtime can already access: MCP/app connectors, installed skills, browser tools, and authenticated CLIs.
- For wrapper-managed sources, edit `config/sources.json` using `config/sources.example.json`.
- For email, edit `config/notifications.json` or set:

```bash
export GSD_EMAIL_TO='you@example.com'
```

## Rules

Uses a drain goal plus one goal per worker, defaults workers to the best available model unless overridden, claims items before work, appends useful suggestions under `Suggested Changes`, marks done or blocked, opens an HTML handoff report, emails on completion, and skips in-progress/done/blocked items.

Real config files are gitignored. Commit only `config/*.example.json`.

## Naming

GitHub repo renamed from `GetShitDoneSweeper` → `ai-slaves-sweeper` on 2026-05-13 to align with the `ai-slaves.com` brand. The legacy `GSD_*` env vars are kept as-is for backwards compatibility.

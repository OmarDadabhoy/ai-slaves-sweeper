import fs from "node:fs";
import path from "node:path";

export function renderWorkerPrompt({ root, job, mode, workspace }) {
  const systemPath = path.join(root, "prompts", "worker-system.md");
  const system = fs.readFileSync(systemPath, "utf8").trim();
  const currentGoalPath = path.join(root, "state", "current_goal.md");
  const overarchingGoalPath = path.join(root, "state", "overarching_goal.md");

  return `${system}

## Mode

${mode}

## Workspace

${workspace}

## Job

\`\`\`json
${JSON.stringify(job, null, 2)}
\`\`\`

## Goal Mode

Before doing any task work, activate goal mode for this job:

- Treat ${overarchingGoalPath} as the parent drain goal.
- In Codex, call create_goal with the task title as the concrete objective when goal tools are available.
- In Claude Code, use Claude Code native goal mode with the task title as the active objective.
- In Hermes, OpenClaw, or other agents, use the already-written fallback goal file at ${currentGoalPath} unless that runtime exposes native goal mode.

After the task is complete or blocked, clearly state done, blocked, or needs_human with verification so the wrapper can close the goal.

## Source Claiming

- If \`job.task.writeback.type\` is \`agent_link\`, the wrapper can only delegate source updates. Use your runtime Notion/Google Docs/Sheets/MCP/app tools to mark the exact item in-progress before doing task work.
- For \`agent_link\`, also mark the exact source item done or blocked before your final response. Use the writeback hints in the job JSON.
- For \`agent_link\`, append any useful suggestions to the source under \`Suggested Changes\` before your final response.
- If you cannot update the source status, stop with status \`needs_human\`.

## Execution Notes

- First load the local operating context that applies to ${workspace}: AGENTS.md, CLAUDE.md, SKILL.md, user-level agent instructions, installed skills, MCP/app connectors, and authenticated CLIs.
- Prefer the user's existing tools and skills over duplicate credentials or local source config.
- If this task is about code, inspect the workspace before editing.
- If this task is about GitHub, use the provided source ref and local/CLI context available to you.
- If this task came from Google Docs, Notion, Sheets, Gmail, GitHub, or another connected system, use existing runtime capabilities when available: MCP servers, app connectors, installed skills, first-party tools, browser tools, or authenticated CLIs.
- Do not attempt source write-back unless explicit editing tools are available and the user/source policy allows it; the wrapper normally owns claim/done/blocked source updates.
- Write your result in plain text with status, summary, verification, needs_from_user, and suggested_changes when useful. The wrapper stores this run's prompt, logs, and result.
`;
}

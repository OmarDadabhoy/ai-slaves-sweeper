const BEST_MODEL_BY_AGENT = {
  codex: "gpt-5.5",
  claude: "opus",
  hermes: "opus",
};

export function defaultModel(agent) {
  if (agent === "claude") return process.env.GSD_CLAUDE_MODEL ?? BEST_MODEL_BY_AGENT.claude;
  if (agent === "hermes") return process.env.GSD_HERMES_MODEL ?? BEST_MODEL_BY_AGENT.hermes;
  if (agent === "openclaw") return undefined;
  return process.env.GSD_CODEX_MODEL ?? BEST_MODEL_BY_AGENT.codex;
}

export function hermesArgs(prompt, model = process.env.GSD_HERMES_MODEL) {
  const args = ["chat"];
  const skills = (process.env.GSD_HERMES_SKILLS ?? "")
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
  for (const skill of skills) args.push("-s", skill);
  if (model) args.push("--model", model);
  args.push("-q", prompt);
  return args;
}

export function openClawArgs(prompt) {
  const agent = process.env.GSD_OPENCLAW_AGENT ?? process.env.OPENCLAW_AGENT;
  const target = process.env.GSD_OPENCLAW_TO ?? process.env.OPENCLAW_TO;
  const sessionId = process.env.GSD_OPENCLAW_SESSION_ID ?? process.env.OPENCLAW_SESSION_ID;
  const timeout = process.env.GSD_OPENCLAW_TIMEOUT ?? process.env.OPENCLAW_TIMEOUT;
  const thinking = process.env.GSD_OPENCLAW_THINKING ?? process.env.OPENCLAW_THINKING ?? "xhigh";
  const local = truthy(process.env.GSD_OPENCLAW_LOCAL ?? process.env.OPENCLAW_LOCAL);
  const json = truthy(process.env.GSD_OPENCLAW_JSON ?? process.env.OPENCLAW_JSON);

  if (!agent && !target && !sessionId) {
    throw new Error("OpenClaw requires GSD_OPENCLAW_AGENT, GSD_OPENCLAW_TO, or GSD_OPENCLAW_SESSION_ID.");
  }

  const args = ["agent"];
  if (agent) args.push("--agent", agent);
  if (target) args.push("--to", target);
  if (sessionId) args.push("--session-id", sessionId);
  if (timeout) args.push("--timeout", timeout);
  if (thinking) args.push("--thinking", thinking);
  if (local) args.push("--local");
  if (json) args.push("--json");
  args.push("--message", prompt);
  return args;
}

export function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

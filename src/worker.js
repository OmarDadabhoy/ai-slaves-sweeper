#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { repoRoot, readJson, writeJson } from "./fs-utils.js";
import { makeRunDir, transitionJob } from "./jobs.js";
import { renderWorkerPrompt } from "./prompt.js";
import { appendTaskSuggestions, markTaskStatus } from "./writeback.js";
import { sendNotification } from "./notify.js";
import { activateGoal, closeGoal } from "./goals.js";
import { writeHandoffReport } from "./handoff-report.js";
import { defaultModel, hermesArgs, openClawArgs } from "./runtimes.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root ?? repoRoot());
  const jobFile = args._[0];
  const mode = args.mode ?? "dry-run";
  const workspace = path.resolve(args.workspace ?? root);
  const agent = args.agent ?? process.env.GSD_AGENT ?? "codex";
  const model = args.model ?? defaultModel(agent);
  const agentCommand = args["agent-command"] ?? process.env.GSD_AGENT_CMD ?? "";

  if (!jobFile) throw new Error("usage: node src/worker.js <job.json> [--mode dry-run|execute]");
  if (!["dry-run", "execute"].includes(mode)) throw new Error("mode must be dry-run or execute");
  if (mode === "execute" && process.env.GSD_ALLOW_EXECUTE !== "1") {
    throw new Error("Refusing execute mode unless GSD_ALLOW_EXECUTE=1 is set.");
  }

  const running = transitionJob(jobFile, "running", { worker_started_at: new Date().toISOString() });
  activateGoal(root, running.job);
  const runDir = makeRunDir(root, running.job);
  const prompt = renderWorkerPrompt({ root, job: running.job, mode, workspace });
  const promptPath = path.join(runDir, "prompt.md");
  const resultPath = path.join(runDir, "result.json");
  fs.writeFileSync(promptPath, prompt);

  if (mode === "dry-run") {
    const result = {
      status: "planned",
      summary: "dry run only; prompt rendered but no agent was invoked",
      prompt_path: promptPath,
      job_id: running.job.job_id,
    };
    writeJson(resultPath, result);
    closeGoal(root, "planned", {
      summary: result.summary,
      verification: "prompt rendered",
      run_dir: runDir,
      job_id: running.job.job_id,
    });
    transitionJob(running.file, "queued", { last_run_dir: runDir, last_result: result.status });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let claim;
  try {
    claim = await markTaskStatus(running.job.task, "in-progress");
  } catch (error) {
    const result = {
      status: "blocked",
      summary: `failed to claim source task: ${error.message}`,
      verification: "",
      follow_up: "check source write permissions",
    };
    result.handoff_report = writeHandoffReport({ runDir, job: running.job, result });
    writeJson(resultPath, result);
    closeGoal(root, "needs_human", {
      summary: result.summary,
      verification: "",
      run_dir: runDir,
      job_id: running.job.job_id,
    });
    transitionJob(running.file, "blocked", {
      last_run_dir: runDir,
      last_result: result.status,
      worker_finished_at: new Date().toISOString(),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await runAgent({ prompt, promptPath, runDir, resultPath, workspace, agent, model, agentCommand });
  result.claim = claim;
  result.suggested_changes = extractSuggestions(result);
  if (result.suggested_changes.length > 0) {
    try {
      result.suggestions_writeback = await appendTaskSuggestions(running.job.task, result.suggested_changes);
      writeJson(resultPath, result);
    } catch (error) {
      result.suggestions_writeback = { status: "failed", error: error.message };
      writeJson(resultPath, result);
    }
  }
  if (result.status === "done") {
    try {
      result.writeback = await markTaskStatus(running.job.task, "done");
      writeJson(resultPath, result);
    } catch (error) {
      result.status = "blocked";
      result.writeback = {
        status: "failed",
        error: error.message,
      };
      writeJson(resultPath, result);
    }
  } else {
    try {
      result.writeback = await markTaskStatus(running.job.task, "blocked");
      writeJson(resultPath, result);
    } catch (error) {
      result.writeback = { status: "failed", error: error.message };
      writeJson(resultPath, result);
    }
  }
  try {
    result.notification = await sendNotification({
      root,
      event: result.status === "done" ? "done" : "needs_human",
      task: running.job.task.title,
      body: result.verification || result.summary || JSON.stringify(result),
    });
    writeJson(resultPath, result);
  } catch (error) {
    result.notification = { status: "failed", error: error.message };
    result.status = "blocked";
    result.summary = `task completed but notification failed: ${error.message}`;
    writeJson(resultPath, result);
  }
  result.handoff_report = writeHandoffReport({ runDir, job: running.job, result });
  writeJson(resultPath, result);
  const nextState = result.status === "done" ? "done" : "blocked";
  closeGoal(root, nextState === "done" ? "done" : "needs_human", {
    summary: result.summary ?? "",
    verification: result.verification ?? "",
    run_dir: runDir,
    job_id: running.job.job_id,
  });
  transitionJob(running.file, nextState, {
    last_run_dir: runDir,
    last_result: result.status,
    worker_finished_at: new Date().toISOString(),
  });
  console.log(JSON.stringify(result, null, 2));
}

function runAgent({ prompt, promptPath, runDir, resultPath, workspace, agent, model, agentCommand }) {
  if (agentCommand) {
    const command = agentCommand
      .replaceAll("{prompt_file}", promptPath)
      .replaceAll("{run_dir}", runDir)
      .replaceAll("{workspace}", workspace);
    return spawnShell(command, "", runDir, resultPath);
  }

  if (agent === "claude") {
    const args = [
      "-p",
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      workspace,
      "--output-format",
      "text",
    ];
    if (model) args.push("--model", model);
    args.push(prompt);
    const env = model ? { CLAUDE_CODE_SUBAGENT_MODEL: model } : {};
    return spawnCommand("claude", args, "", runDir, resultPath, { env });
  }

  if (agent === "hermes") {
    return spawnCommand("hermes", hermesArgs(prompt, model), "", runDir, resultPath);
  }

  if (agent === "openclaw") {
    try {
      return spawnCommand("openclaw", openClawArgs(prompt), "", runDir, resultPath);
    } catch (error) {
      const result = {
        status: "blocked",
        summary: error.message,
        verification: "configure OpenClaw routing env vars or use --agent-command",
        follow_up: "",
      };
      writeJson(resultPath, result);
      return Promise.resolve(result);
    }
  }

  if (agent !== "codex") {
    const result = {
      status: "blocked",
      summary: `unsupported agent "${agent}"`,
      verification: "use --agent codex, --agent claude, --agent hermes, --agent openclaw, or --agent-command",
      follow_up: "",
    };
    writeJson(resultPath, result);
    return Promise.resolve(result);
  }

  const outputLastMessage = path.join(runDir, "agent.final.md");
  const args = [
    "exec",
    "--cd",
    workspace,
    "--sandbox",
    "danger-full-access",
    "-c",
    'approval_policy="never"',
    "--output-last-message",
    outputLastMessage,
    "--json",
  ];
  if (model) args.push("--model", model);
  args.push("-");
  return spawnCommand("codex", args, prompt, runDir, resultPath, { finalMessagePath: outputLastMessage });
}

function spawnShell(command, input, cwd, resultPath) {
  return spawnCommand(process.env.SHELL ?? "/bin/sh", ["-lc", command], input, cwd, resultPath);
}

function spawnCommand(command, args, input, cwd, resultPath, options = {}) {
  return new Promise((resolve) => {
    const stdoutPath = path.join(cwd, "agent.stdout.log");
    const stderrPath = path.join(cwd, "agent.stderr.log");
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      const result = { status: "blocked", summary: error.message, verification: "", follow_up: "" };
      writeJson(resultPath, result);
      resolve(result);
    });
    child.on("close", (code) => {
      fs.writeFileSync(stdoutPath, stdout);
      fs.writeFileSync(stderrPath, stderr);
      const status = code === 0 ? "done" : "blocked";
      const agentOutput = usefulOutput(stdout, stderr, options.finalMessagePath);
      const result = {
        status,
        exit_code: code,
        summary: status === "done" ? firstLine(agentOutput, "agent completed") : "agent failed",
        verification: agentOutput || (status === "done" ? "agent process exited 0" : stderr || stdout),
        follow_up: extractFollowUp(agentOutput),
      };
      writeJson(resultPath, result);
      resolve(result);
    });
    child.stdin.end(input);
  });
}

function usefulOutput(stdout, stderr, finalMessagePath) {
  const finalMessage =
    finalMessagePath && fs.existsSync(finalMessagePath) ? fs.readFileSync(finalMessagePath, "utf8").trim() : "";
  const combined = [finalMessage, stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n").trim();
  return combined.slice(-8000);
}

function firstLine(value, fallback) {
  const line = String(value ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? line.slice(0, 240) : fallback;
}

function extractFollowUp(value) {
  const match = /(?:needs_from_(?:user|omar)|follow_up)\s*:\s*(.+)/i.exec(String(value ?? ""));
  return match ? match[1].trim().slice(0, 2000) : "";
}

function extractSuggestions(result) {
  if (Array.isArray(result.suggested_changes)) return result.suggested_changes.map(String).filter(Boolean);
  const text = [result.summary, result.verification, result.follow_up].filter(Boolean).join("\n");
  const match = /(?:suggested[_ ]changes|suggestions)\s*:?\s*([\s\S]*)/i.exec(text);
  if (!match) return [];
  const suggestions = [];
  for (const line of match[1].split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) {
      if (suggestions.length) break;
      continue;
    }
    if (/^(status|summary|verification|needs_from_user|follow_up)\s*:/i.test(stripped)) break;
    const cleaned = stripped.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
    if (cleaned && !["none", "n/a", "nothing"].includes(cleaned.toLowerCase())) suggestions.push(cleaned);
  }
  return suggestions;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

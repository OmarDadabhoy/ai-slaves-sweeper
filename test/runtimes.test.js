import assert from "node:assert/strict";
import test from "node:test";
import { defaultModel, hermesArgs, openClawArgs } from "../src/runtimes.js";

test("default model selects best model by agent", () => {
  const previousCodex = process.env.GSD_CODEX_MODEL;
  const previousClaude = process.env.GSD_CLAUDE_MODEL;
  const previousHermes = process.env.GSD_HERMES_MODEL;
  try {
    delete process.env.GSD_CODEX_MODEL;
    delete process.env.GSD_CLAUDE_MODEL;
    delete process.env.GSD_HERMES_MODEL;
    assert.equal(defaultModel("codex"), "gpt-5.5");
    assert.equal(defaultModel("claude"), "opus");
    assert.equal(defaultModel("hermes"), "opus");
  } finally {
    restore("GSD_CODEX_MODEL", previousCodex);
    restore("GSD_CLAUDE_MODEL", previousClaude);
    restore("GSD_HERMES_MODEL", previousHermes);
  }
});

test("default model honors user overrides", () => {
  const previousCodex = process.env.GSD_CODEX_MODEL;
  const previousClaude = process.env.GSD_CLAUDE_MODEL;
  const previousHermes = process.env.GSD_HERMES_MODEL;
  try {
    process.env.GSD_CODEX_MODEL = "gpt-custom";
    process.env.GSD_CLAUDE_MODEL = "sonnet";
    process.env.GSD_HERMES_MODEL = "openrouter/custom";
    assert.equal(defaultModel("codex"), "gpt-custom");
    assert.equal(defaultModel("claude"), "sonnet");
    assert.equal(defaultModel("hermes"), "openrouter/custom");
  } finally {
    restore("GSD_CODEX_MODEL", previousCodex);
    restore("GSD_CLAUDE_MODEL", previousClaude);
    restore("GSD_HERMES_MODEL", previousHermes);
  }
});

test("hermes runtime command includes skills and model", () => {
  const previousSkills = process.env.GSD_HERMES_SKILLS;
  process.env.GSD_HERMES_SKILLS = "codex,github";
  try {
    assert.deepEqual(hermesArgs("Do task", "anthropic/claude-sonnet-4"), [
      "chat",
      "-s",
      "codex",
      "-s",
      "github",
      "--model",
      "anthropic/claude-sonnet-4",
      "-q",
      "Do task",
    ]);
  } finally {
    if (previousSkills === undefined) delete process.env.GSD_HERMES_SKILLS;
    else process.env.GSD_HERMES_SKILLS = previousSkills;
  }
});

test("openclaw runtime command requires routing and supports local timeout", () => {
  const previousAgent = process.env.GSD_OPENCLAW_AGENT;
  const previousLocal = process.env.GSD_OPENCLAW_LOCAL;
  const previousTimeout = process.env.GSD_OPENCLAW_TIMEOUT;
  const previousThinking = process.env.GSD_OPENCLAW_THINKING;
  const previousOpenClawThinking = process.env.OPENCLAW_THINKING;
  process.env.GSD_OPENCLAW_AGENT = "ops";
  process.env.GSD_OPENCLAW_LOCAL = "1";
  process.env.GSD_OPENCLAW_TIMEOUT = "120";
  delete process.env.GSD_OPENCLAW_THINKING;
  delete process.env.OPENCLAW_THINKING;
  try {
    assert.deepEqual(openClawArgs("Do task"), [
      "agent",
      "--agent",
      "ops",
      "--timeout",
      "120",
      "--thinking",
      "xhigh",
      "--local",
      "--message",
      "Do task",
    ]);
  } finally {
    restore("GSD_OPENCLAW_AGENT", previousAgent);
    restore("GSD_OPENCLAW_LOCAL", previousLocal);
    restore("GSD_OPENCLAW_TIMEOUT", previousTimeout);
    restore("GSD_OPENCLAW_THINKING", previousThinking);
    restore("OPENCLAW_THINKING", previousOpenClawThinking);
  }
});

test("openclaw runtime command honors thinking override", () => {
  const previousAgent = process.env.GSD_OPENCLAW_AGENT;
  const previousThinking = process.env.GSD_OPENCLAW_THINKING;
  process.env.GSD_OPENCLAW_AGENT = "ops";
  process.env.GSD_OPENCLAW_THINKING = "medium";
  try {
    assert.deepEqual(openClawArgs("Do task"), ["agent", "--agent", "ops", "--thinking", "medium", "--message", "Do task"]);
  } finally {
    restore("GSD_OPENCLAW_AGENT", previousAgent);
    restore("GSD_OPENCLAW_THINKING", previousThinking);
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

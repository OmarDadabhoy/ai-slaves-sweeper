import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseTodoText, parseTodoLine, fingerprint } from "./task-parser.js";
import { defaultModel, hermesArgs, openClawArgs } from "./runtimes.js";

const googleDocIdRe = /\/document\/d\/([a-zA-Z0-9_-]+)/;
const notionPageIdRe =
  /([a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})/;

export async function collectTasks(configPath, options = {}) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const sources = Array.isArray(config.sources) ? config.sources : [];
  if (options.sourceUrl) {
    sources.push({
      id: "agent-link",
      type: "agent_link",
      enabled: true,
      url: options.sourceUrl,
      agent: options.sourceAgent,
      agent_command: options.sourceAgentCommand,
    });
  }
  const tasks = [];

  for (const source of sources) {
    if (source.enabled === false) continue;
    if (!source.id) throw new Error("Every source needs an id.");

    if (source.type === "text_file") {
      tasks.push(...readTextFileSource(source, configPath));
    } else if (source.type === "google_docs") {
      tasks.push(...(await readGoogleDocsSource(source)));
    } else if (source.type === "notion_page") {
      tasks.push(...(await readNotionPageSource(source)));
    } else if (source.type === "github_issues") {
      tasks.push(...readGitHubIssuesSource(source));
    } else if (source.type === "agent_link") {
      tasks.push(...readAgentLinkSource(source, options.root ?? path.dirname(configPath)));
    } else {
      throw new Error(`Unsupported source type: ${source.type}`);
    }
  }

  return tasks;
}

function readAgentLinkSource(source, root) {
  if (!source.url) throw new Error(`Agent link source ${source.id} needs url.`);
  const prompt = renderAgentLinkPrompt(source);
  const output = runSourceAgent({ source, root, prompt });
  const items = extractJsonArray(output);
  return items.map((entry, index) => {
    const title = String(entry.title ?? "").trim();
    if (!title) throw new Error(`Agent link source ${source.id} returned a task without title.`);
    const itemRef = String(entry.source_item_ref ?? entry.item_ref ?? entry.location ?? `${index + 1}`);
    const sourceRef = String(entry.source_ref ?? source.url);
    return {
      task_id: fingerprint([source.id, source.url, itemRef, title]),
      source_id: source.id,
      source_type: source.type,
      title,
      body: String(entry.body ?? ""),
      location: String(entry.location ?? `${source.url}#${index + 1}`),
      source_ref: sourceRef,
      created_from: "agent_link",
      writeback: {
        type: "agent_link",
        source_id: source.id,
        url: source.url,
        source_ref: sourceRef,
        item_ref: itemRef,
        claim_hint: entry.claim_hint ?? "",
        done_hint: entry.done_hint ?? "",
        blocked_hint: entry.blocked_hint ?? "",
      },
    };
  });
}

function renderAgentLinkPrompt(source) {
  return `Read this todo source using the tools already available in this agent runtime:

${source.url}

Use existing MCP servers, app connectors, installed skills, browser tools, and authenticated CLIs before asking for credentials.

Return JSON only. Return an array of actionable incomplete tasks. Each item must have:
- title
- location
- source_item_ref: a stable block/line/task reference if visible
- claim_hint: how to mark this exact item in-progress
- done_hint: how to mark this exact item done
- blocked_hint: how to mark this exact item blocked

Skip anything already marked in-progress, done, blocked, waiting, or not actionable.
Use [] if there are no actionable tasks.`;
}

function runSourceAgent({ source, root, prompt }) {
  const commandTemplate = source.agent_command ?? process.env.GSD_SOURCE_AGENT_CMD;
  const promptFile = path.join(os.tmpdir(), `gsd-source-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(promptFile, prompt);
  try {
    if (commandTemplate) {
      const command = commandTemplate
        .replaceAll("{prompt_file}", promptFile)
        .replaceAll("{url}", source.url)
        .replaceAll("{source_id}", source.id);
      const result = spawnSync(command, { cwd: root, shell: true, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `Source agent command failed for ${source.id}.`);
      }
      return `${result.stdout}\n${result.stderr}`;
    }

    const agent = source.agent ?? process.env.GSD_SOURCE_AGENT ?? "codex";
    if (agent === "claude") {
      const args = [
        "-p",
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        root,
        "--output-format",
        "text",
      ];
      const model = defaultModel("claude");
      if (model) args.push("--model", model);
      args.push(prompt);
      const result = spawnSync("claude", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `Claude source read failed for ${source.id}.`);
      }
      return result.stdout;
    }

    if (agent === "hermes") {
      const result = spawnSync("hermes", hermesArgs(prompt, defaultModel("hermes")), { cwd: root, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `Hermes source read failed for ${source.id}.`);
      }
      return result.stdout;
    }

    if (agent === "openclaw") {
      const result = spawnSync("openclaw", openClawArgs(prompt), { cwd: root, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `OpenClaw source read failed for ${source.id}.`);
      }
      return result.stdout;
    }

    if (agent !== "codex") {
      throw new Error(`Unsupported source agent "${agent}". Use "codex", "claude", "hermes", "openclaw", or source_agent_command.`);
    }

    const outputFile = path.join(os.tmpdir(), `gsd-source-output-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const codexArgs = [
      "exec",
      "--cd",
      root,
      "--sandbox",
      "danger-full-access",
      "-c",
      'approval_policy="never"',
      "--output-last-message",
      outputFile,
    ];
    const model = defaultModel("codex");
    if (model) codexArgs.push("--model", model);
    codexArgs.push("-");
    const result = spawnSync("codex", codexArgs, { cwd: root, input: prompt, encoding: "utf8" });
    const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
    fs.rmSync(outputFile, { force: true });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || output || `Codex source read failed for ${source.id}.`);
    }
    return output || result.stdout;
  } finally {
    fs.rmSync(promptFile, { force: true });
  }
}

function extractJsonArray(output) {
  const text = String(output ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("Source agent JSON must be an array.");
    return parsed;
  } catch {
    const match = /\[[\s\S]*\]/.exec(text);
    if (!match) throw new Error(`Source agent did not return a JSON array. Output: ${text.slice(0, 500)}`);
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error("Source agent JSON must be an array.");
    return parsed;
  }
}

function resolveConfigPath(configPath, value) {
  const expanded = String(value).replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(path.dirname(configPath), expanded);
}

function readTextFileSource(source, configPath) {
  const file = resolveConfigPath(configPath, source.path);
  if (!fs.existsSync(file)) return [];
  return parseTodoText(fs.readFileSync(file, "utf8"), {
    id: source.id,
    type: source.type,
    location: file,
    ref: file,
  });
}

function googleDocId(source) {
  if (source.document_id) return String(source.document_id);
  const match = googleDocIdRe.exec(String(source.url ?? ""));
  if (!match) throw new Error(`Google Docs source ${source.id} needs document_id or a valid url.`);
  return match[1];
}

function googleDocsExportUrl(source) {
  if (source.export_url) return String(source.export_url);
  return `https://docs.google.com/document/d/${googleDocId(source)}/export?format=txt`;
}

function googleBearerToken(source) {
  if (source.token_env && process.env[source.token_env]) {
    return process.env[source.token_env].trim();
  }

  if (source.token_command) {
    const result = spawnSync(source.token_command, { shell: true, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `Token command failed for ${source.id}.`);
    }
    return result.stdout.trim();
  }

  if (source.auth === "gcloud") {
    const result = spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `gcloud auth failed for ${source.id}.`);
    }
    return result.stdout.trim();
  }

  return "";
}

async function readGoogleDocsSource(source) {
  if ((source.writeback ?? "none") !== "none") {
    return readGoogleDocsStructuredSource(source);
  }

  const headers = {};
  const token = googleBearerToken(source);
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(googleDocsExportUrl(source), { headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Google Docs source ${source.id} is not readable. Make it public/published or configure auth.`,
    );
  }
  if (!response.ok) throw new Error(`Google Docs source ${source.id} failed: HTTP ${response.status}`);

  const text = await response.text();
  const location = source.url ?? source.export_url ?? `Google Docs:${googleDocId(source)}`;
  return parseTodoText(text, {
    id: source.id,
    type: source.type,
    location,
    ref: location,
  });
}

async function googleDocsJson(method, url, token, body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Google Docs API request was not authorized. Configure a token with Docs read/write scope.");
  }
  if (!response.ok) {
    throw new Error(`Google Docs API request failed: HTTP ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

async function readGoogleDocsStructuredSource(source) {
  const token = googleBearerToken(source);
  if (!token) {
    throw new Error(
      `Google Docs source ${source.id} requires auth for write-back. Configure auth, token_env, or token_command.`,
    );
  }

  const documentId = googleDocId(source);
  const document = await googleDocsJson(
    "GET",
    `https://docs.googleapis.com/v1/documents/${documentId}`,
    token,
  );
  return googleDocParagraphTasks(source, document);
}

function googleDocParagraphTasks(source, document) {
  const documentId = googleDocId(source);
  const location = source.url ?? `Google Docs:${documentId}`;
  const tasks = [];

  for (const element of document.body?.content ?? []) {
    if (!element.paragraph || !Number.isInteger(element.startIndex) || !Number.isInteger(element.endIndex)) {
      continue;
    }

    const text = paragraphText(element.paragraph);
    const line = text.replace(/\n$/, "");
    const parsed = parseTodoLine(line);
    if (!parsed?.actionable) continue;

    const markerStart = element.startIndex + parsed.markerOffset;
    const markerEnd = markerStart + parsed.markerLength;
    tasks.push({
      task_id: fingerprint([source.id, documentId, String(element.startIndex), parsed.title]),
      source_id: source.id,
      source_type: source.type,
      title: parsed.title,
      body: "",
      location: `${location}:${element.startIndex}`,
      source_ref: location,
      created_from: "google_docs",
      writeback: {
        type: "google_docs",
        mode: source.writeback ?? "mark_done",
        document_id: documentId,
        revision_id: document.revisionId,
        auth: source.auth,
        token_env: source.token_env,
        token_command: source.token_command,
        paragraph_start: element.startIndex,
        paragraph_end: element.endIndex,
        marker_start: markerStart,
        marker_end: markerEnd,
        kind: parsed.kind,
        status: parsed.status,
      },
    });
  }

  return tasks;
}

function paragraphText(paragraph) {
  return (paragraph.elements ?? []).map((element) => element.textRun?.content ?? "").join("");
}

function notionPageId(source) {
  const raw = String(source.page_id ?? source.url ?? "");
  const match = notionPageIdRe.exec(raw) ?? notionPageIdRe.exec(raw.replaceAll("-", ""));
  if (!match) throw new Error(`Notion source ${source.id} needs page_id or a valid url.`);
  const value = match[1].replaceAll("-", "");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function notionToken(source) {
  const tokenEnv = source.token_env ?? "NOTION_TOKEN";
  if (tokenEnv && process.env[tokenEnv]) return process.env[tokenEnv].trim();

  if (source.token_command) {
    const result = spawnSync(source.token_command, { shell: true, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `Token command failed for ${source.id}.`);
    }
    return result.stdout.trim();
  }

  throw new Error(`Notion source ${source.id} requires token_env or token_command. Default token_env is NOTION_TOKEN.`);
}

async function notionJson(method, url, token, source, body) {
  const headers = {
    authorization: `Bearer ${token}`,
    "notion-version": source.notion_version ?? "2022-06-28",
  };
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if ([401, 403, 404].includes(response.status)) {
    throw new Error(
      `Notion API request was not authorized or the page was not shared with the integration: HTTP ${response.status} ${await response.text()}`,
    );
  }
  if (!response.ok) throw new Error(`Notion API request failed: HTTP ${response.status} ${await response.text()}`);
  return await response.json();
}

async function notionChildren(source, token, blockId) {
  const blocks = [];
  let cursor = "";
  while (true) {
    const suffix = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "";
    const response = await notionJson(
      "GET",
      `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100${suffix}`,
      token,
      source,
    );
    blocks.push(...(response.results ?? []));
    if (!response.has_more) return blocks;
    cursor = response.next_cursor;
  }
}

async function readNotionPageSource(source) {
  const token = notionToken(source);
  const pageId = notionPageId(source);
  const blocks = await notionChildren(source, token, pageId);
  const tasks = notionBlockTasks(source, blocks);

  if (source.recursive) {
    const queue = blocks.filter((block) => block.has_children);
    while (queue.length > 0) {
      const block = queue.shift();
      const children = await notionChildren(source, token, block.id);
      tasks.push(...notionBlockTasks(source, children));
      queue.push(...children.filter((child) => child.has_children));
    }
  }

  return tasks;
}

function notionPlainText(richText) {
  return (richText ?? []).map((part) => part.plain_text ?? "").join("");
}

function notionBlockText(block) {
  const payload = block[block.type] ?? {};
  return notionPlainText(payload.rich_text);
}

function notionBlockTasks(source, blocks) {
  const tasks = [];
  const pageId = notionPageId(source);
  const location = source.url ?? `Notion:${pageId}`;

  for (const block of blocks) {
    if (!block.id || block.archived) continue;

    if (block.type === "to_do") {
      const title = notionPlainText(block.to_do?.rich_text).trim();
      const isClaimed = title.startsWith("[>] ") || title.startsWith("[!] ") || title.startsWith("[x] ");
      if (title && !block.to_do?.checked && !isClaimed) {
        tasks.push({
          task_id: fingerprint([source.id, block.id, title]),
          source_id: source.id,
          source_type: source.type,
          title,
          body: "",
          location: `${location}:${block.id}`,
          source_ref: location,
          created_from: "notion_page",
          writeback: {
            type: "notion_page",
            mode: source.writeback ?? "mark_done",
            page_id: pageId,
            block_id: block.id,
            block_type: block.type,
            token_env: source.token_env,
            token_command: source.token_command,
            notion_version: source.notion_version,
            status: "todo",
          },
        });
      }
      continue;
    }

    if (!["paragraph", "bulleted_list_item", "numbered_list_item"].includes(block.type)) continue;

    const line = notionBlockText(block).trim();
    const parsed = parseTodoLine(line);
    if (!parsed?.actionable) continue;

    tasks.push({
      task_id: fingerprint([source.id, block.id, parsed.title]),
      source_id: source.id,
      source_type: source.type,
      title: parsed.title,
      body: "",
      location: `${location}:${block.id}`,
      source_ref: location,
      created_from: "notion_page",
      writeback: {
        type: "notion_page",
        mode: source.writeback ?? "mark_done",
        page_id: pageId,
        block_id: block.id,
        block_type: block.type,
        kind: parsed.kind,
        text: line,
        status: parsed.status,
        token_env: source.token_env,
        token_command: source.token_command,
        notion_version: source.notion_version,
      },
    });
  }

  return tasks;
}

function readGitHubIssuesSource(source) {
  if (!source.repo) throw new Error(`GitHub source ${source.id} needs repo.`);

  const fields = "number,title,url,body,labels,updatedAt";
  const args = [
    "issue",
    "list",
    "--repo",
    source.repo,
    "--state",
    source.state ?? "open",
    "--limit",
    String(source.limit ?? 20),
    "--json",
    fields,
  ];
  if (source.label) args.splice(6, 0, "--label", source.label);

  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `gh issue list failed for ${source.id}.`);
  }

  const issues = JSON.parse(result.stdout);
  return issues.map((issue) => ({
    task_id: fingerprint([source.id, source.repo, String(issue.number), issue.updatedAt ?? ""]),
    source_id: source.id,
    source_type: source.type,
    title: issue.title,
    body: issue.body ?? "",
    location: `${source.repo}#${issue.number}`,
    source_ref: issue.url,
    github: {
      repo: source.repo,
      number: issue.number,
      url: issue.url,
      labels: (issue.labels ?? []).map((label) => label.name),
    },
    created_from: "github_issue",
  }));
}

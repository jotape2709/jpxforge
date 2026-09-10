import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ForgeConfigSchema } from "@jpxforge/shared";

const temporaryRoot = path.resolve(os.tmpdir());
const dataDirectory = mkdtempSync(path.join(temporaryRoot, "jpxforge-foundation-"));
process.env.FORGE_DATA_DIR = dataDirectory;
const {
  db, DB_PATH, createProject, getProject, updateProject, enqueueTask, claimNextTask,
  completeTask, failTask, listTasks, abortProjectTasks, recoverInterruptedTasks, tokensByProject,
} = await import("../src/db.js");
const { configPath, saveConfig, loadConfig } = await import("../src/config.js");
const { ModelRouter } = await import("../src/model-router.js");
const { REPO_ROOT, DATA_DIR } = await import("../src/paths.js");

beforeEach(() => {
  db.exec("DELETE FROM tasks; DELETE FROM projects; DELETE FROM token_usage; DELETE FROM events;");
});

after(() => {
  db.close();
  assert.equal(path.dirname(path.resolve(dataDirectory)), temporaryRoot);
  assert.ok(path.basename(dataDirectory).startsWith("jpxforge-foundation-"));
  rmSync(dataDirectory, { recursive: true, force: true });
});

function project() {
  return createProject({ source: "manual", raw_text: "Uma landing page para a empresa de testes." });
}

function task(projectId: string, extra: Partial<Parameters<typeof enqueueTask>[0]> = {}) {
  return enqueueTask({ project_id: projectId, title: "Tarefa de teste", role: "fullstack_dev", ...extra });
}

test("paths remain anchored to the checkout from an unrelated working directory", () => {
  assert.equal(DATA_DIR, dataDirectory);
  assert.equal(DB_PATH, path.join(dataDirectory, "jpxforge.db"));
  assert.equal(configPath(), path.join(dataDirectory, "jpxforge.config.json"));
  const pathsModule = new URL("../src/paths.ts", import.meta.url);
  const tsxLoader = new URL("../../../node_modules/tsx/dist/loader.mjs", pathsModule).href;
  const child = spawnSync(process.execPath, [
    "--import", tsxLoader, "--input-type=module", "-e",
    `const { REPO_ROOT, DATA_DIR } = await import(${JSON.stringify(pathsModule.href)}); console.log(JSON.stringify({ REPO_ROOT, DATA_DIR }));`,
  ], { cwd: dataDirectory, encoding: "utf8", env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { REPO_ROOT, DATA_DIR });
});

test("config supports Windows BOM and atomic saves in the selected data directory", () => {
  const config = ForgeConfigSchema.parse({ version: 1, providers: {}, roles: {} });
  saveConfig(config);
  assert.deepEqual(loadConfig(), config);
  writeFileSync(configPath(), `\uFEFF${readFileSync(configPath(), "utf8")}`);
  assert.deepEqual(loadConfig(), config);
});

test("ready tasks beyond twenty blocked rows are claimed and attempts are current", () => {
  const p = project();
  for (let i = 0; i < 25; i++) task(p.id, { depends_on: ["missing-dependency"] });
  const ready = task(p.id);
  const claimed = claimNextTask();
  assert.equal(claimed?.id, ready.id);
  assert.equal(claimed?.attempts, 1);
  assert.equal(claimed?.status, "running");
  assert.equal(claimNextTask(), null);
});

test("dependencies must be completed within the same project", () => {
  const first = project();
  const second = project();
  const dependency = task(first.id);
  task(second.id, { depends_on: [dependency.id] });
  assert.equal(claimNextTask()?.id, dependency.id);
  assert.equal(completeTask(dependency.id, false, 1), true);
  assert.equal(listTasks(first.id)[0].result, false);
  assert.equal(claimNextTask(), null);
  const local = task(first.id, { depends_on: [dependency.id] });
  assert.equal(claimNextTask()?.id, local.id);
});

test("aborted, quarantined and shipped projects cannot receive or start tasks", () => {
  for (const status of ["aborted", "quarantine", "shipped"] as const) {
    const p = project();
    task(p.id);
    assert.equal(updateProject(p.id, { status }), true);
    assert.throws(() => task(p.id), /indisponível/);
  }
  assert.equal(claimNextTask(), null);
});

test("an aborted running task cannot complete, retry or resurrect its project", () => {
  const p = project();
  const queued = task(p.id);
  assert.equal(completeTask(queued.id), false);
  assert.equal(failTask(queued.id, "failure before claim"), null);
  const claimed = claimNextTask()!;
  updateProject(p.id, { status: "aborted" });
  assert.equal(completeTask(claimed.id, { stale: true }, claimed.attempts), false);
  assert.equal(failTask(claimed.id, "stale error", claimed.attempts), null);
  abortProjectTasks(p.id);
  assert.equal(completeTask(claimed.id), false);
  assert.equal(updateProject(p.id, { status: "planned" }), false);
  assert.equal(getProject(p.id)?.status, "aborted");
  assert.equal(listTasks(p.id)[0].status, "failed");
});

test("retry count is finite and late results from an older attempt are ignored", () => {
  const p = project();
  task(p.id, { max_attempts: 2 });
  const first = claimNextTask()!;
  assert.equal(failTask(first.id, "temporary", first.attempts)?.status, "queued");
  const second = claimNextTask()!;
  assert.equal(second.attempts, 2);
  assert.equal(completeTask(first.id, "late response", first.attempts), false);
  assert.equal(failTask(first.id, "late failure", first.attempts), null);
  assert.equal(failTask(second.id, "exhausted", second.attempts)?.status, "failed");
  assert.equal(claimNextTask(), null);
});

test("a publish task may finish after setting its project to shipped", () => {
  const p = project();
  task(p.id);
  const claimed = claimNextTask()!;
  updateProject(p.id, { status: "shipped" });
  assert.equal(completeTask(claimed.id, { pushed: true }, claimed.attempts), true);
});

test("crash recovery quarantines interrupted projects without repeating effects", () => {
  const p = project();
  const interrupted = task(p.id);
  task(p.id, { depends_on: [interrupted.id] });
  claimNextTask();
  assert.deepEqual(recoverInterruptedTasks(), { taskIds: [interrupted.id], projectIds: [p.id] });
  assert.equal(getProject(p.id)?.status, "quarantine");
  assert.equal(listTasks(p.id)[0].status, "blocked");
  assert.equal(listTasks(p.id)[0].attempts, 1);
  assert.equal(completeTask(interrupted.id), false);
  assert.equal(claimNextTask(), null);
  assert.deepEqual(recoverInterruptedTasks(), { taskIds: [], projectIds: [] });
});

async function mockProvider(handler: (body: any, response: ServerResponse, request: IncomingMessage) => void) {
  const calls: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(body);
    handler(body, response, request);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    calls,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function completion(response: ServerResponse, content = "Resposta válida", finishReason = "stop") {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    id: "mock-completion", object: "chat.completion", created: 0, model: "mock-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }));
}

function routerConfig(baseURL: string, fallback = true) {
  return ForgeConfigSchema.parse({
    version: 1,
    providers: { deepseek: { enabled: true, api_key: "test-local-only", base_url: baseURL } },
    roles: { fullstack_dev: {
      primary: { provider: "deepseek", model: "primary" },
      ...(fallback ? { fallback: { provider: "deepseek", model: "fallback" } } : {}),
    } },
  });
}

const messages = [{ role: "user" as const, content: "Teste sem acesso a APIs pagas" }];

test("disabled providers and missing remote keys fail before network access", async () => {
  const provider = await mockProvider((_body, response) => completion(response));
  try {
    const config = routerConfig(provider.url, false);
    config.providers.deepseek!.enabled = false;
    await assert.rejects(new ModelRouter(config).chat("fullstack_dev", messages), /desabilitado/);
    config.providers.deepseek!.enabled = true;
    config.providers.deepseek!.api_key = "  ";
    await assert.rejects(new ModelRouter(config).chat("fullstack_dev", messages), /API key/);
    assert.equal(provider.calls.length, 0);
  } finally { await provider.close(); }
});

test("provider failures have no hidden retries and only one configured fallback", async () => {
  const provider = await mockProvider((body, response) => {
    if (body.model === "primary") {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "mock failure", type: "server_error" } }));
    } else completion(response);
  });
  try {
    const result = await new ModelRouter(routerConfig(provider.url)).chat("fullstack_dev", messages);
    assert.equal(result.usedFallback, true);
    assert.deepEqual(provider.calls.map((call) => call.model), ["primary", "fallback"]);
  } finally { await provider.close(); }
});

test("canceling an in-flight model call never dispatches the fallback", async () => {
  const controller = new AbortController();
  const provider = await mockProvider(() => controller.abort(new DOMException("Cancelado", "AbortError")));
  try {
    await assert.rejects(new ModelRouter(routerConfig(provider.url)).chat("fullstack_dev", messages, { signal: controller.signal }), { name: "AbortError" });
    assert.deepEqual(provider.calls.map((call) => call.model), ["primary"]);
    await assert.rejects(new ModelRouter(routerConfig(provider.url)).chat("fullstack_dev", messages, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(provider.calls.length, 1);
  } finally { await provider.close(); }
});

test("a finite timeout advances to fallback instead of leaving the queue stuck", async () => {
  const provider = await mockProvider((body, response) => {
    if (body.model === "fallback") completion(response);
  });
  try {
    const result = await new ModelRouter(routerConfig(provider.url)).chat("fullstack_dev", messages, { timeoutMs: 100 });
    assert.equal(result.usedFallback, true);
    assert.deepEqual(provider.calls.map((call) => call.model), ["primary", "fallback"]);
  } finally { await provider.close(); }
});

test("tokens from a rejected truncated response are still recorded", async () => {
  const p = project();
  const provider = await mockProvider((body, response) => completion(response, "partial", body.model === "primary" ? "length" : "stop"));
  try {
    const result = await new ModelRouter(routerConfig(provider.url)).chat("fullstack_dev", messages, { projectId: p.id });
    assert.equal(result.usedFallback, true);
    const rows = tokensByProject(p.id) as { model: string; prompt_tokens: number; completion_tokens: number }[];
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, row) => sum + row.prompt_tokens + row.completion_tokens, 0), 10);
  } finally { await provider.close(); }
});

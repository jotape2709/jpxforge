import assert from "node:assert/strict";
import { test, after, beforeEach } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { Role } from "@jpxforge/shared";
import { parsePilotOptions, pilotConfig, PilotPricingSchema } from "../src/pilot-options.js";
import type { PilotReport } from "../src/pilot-runner.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "forge-pilot-test-"));
process.env.FORGE_DATA_DIR = directory;
const { db, createProject, listTasks } = await import("../src/db.js");
const { runPilot } = await import("../src/pilot-runner.js");
const { ModelRouter, readModelUsage } = await import("../src/model-router.js");
const { DemoRouter } = await import("../src/demo-router.js");
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const offline = parsePilotOptions([]);
const live = parsePilotOptions(["--live", "--model", "deepseek-v4-flash"]);
// Deliberately synthetic rates for arithmetic tests, NOT a current price list.
const pricing = PilotPricingSchema.parse({ currency: "USD", model: live.model,
  input_usd_per_million: 1, cached_input_usd_per_million: 0.1, output_usd_per_million: 2, checked_on: "2026-09-10" });
const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 };
const fixtureRoles: Role[] = ["product_owner", "tech_lead", "fullstack_dev"];
const responses = await Promise.all(fixtureRoles.map(role => new DemoRouter().chat(role, [])));

async function provider(handler: (response: ServerResponse, index: number, body: Record<string, unknown>) => void) {
  const calls: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(body);
    handler(res, calls.length - 1, body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = pilotConfig(live, "fake-secret-for-local-test");
  config.providers.deepseek!.base_url = `http://127.0.0.1:${address.port}/v1`;
  return { calls, router: new ModelRouter(config), async close() {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
function completion(res: ServerResponse, index: number, counters: unknown = usage, finish = "stop") {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "synthetic", object: "chat.completion", created: 0, model: live.model,
    choices: [{ index: 0, message: { role: "assistant", content: responses[index]?.content ?? "{}" }, finish_reason: finish }],
    ...(counters ? { usage: counters } : {}),
  }));
}
beforeEach(() => db.exec("DELETE FROM tasks; DELETE FROM projects; DELETE FROM token_usage; DELETE FROM events;"));
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

test("pilot defaults to offline and validates the live model, limits and pricing before any call", () => {
  assert.equal(offline.mode, "offline");
  assert.equal(offline.maxCalls, 3);
  for (const args of [["--live"], ["--live", "--offline"], ["--max-calls", "4"], ["--timeout-ms", "NaN"],
    ["--max-calls", "0"], ["--model", "deepseek-v4-flash"], ["--api-key", "secret"]]) {
    assert.throws(() => parsePilotOptions(args));
  }
  assert.throws(() => pilotConfig(live, " "), /Chave DeepSeek ausente/);
  const config = pilotConfig(live, " fake-secret ");
  assert.equal(config.work.auto_claim, false);
  assert.equal(config.work.token, undefined);
  assert.equal(config.github.token, undefined);
  assert.deepEqual(Object.keys(config.providers), ["deepseek"]);
  for (const route of Object.values(config.roles)) {
    assert.equal(route.fallback, undefined);
    assert.equal(route.primary.thinking, "disabled");
  }
  assert.equal(PilotPricingSchema.safeParse({ ...pricing, cached_input_usd_per_million: 2 }).success, false);
});

test("offline pilot emits initial and final checkpoints with real QA and a local commit", async () => {
  const snapshots: PilotReport[] = [];
  const report = await runPilot(offline, new DemoRouter(), { checkpoint: r => snapshots.push(structuredClone(r)) });
  assert.equal(snapshots[0].status, "running");
  assert.equal(snapshots[0].calls.length, 0);
  assert.ok(snapshots.some(s => s.calls.some(c => c.status === "running")));
  assert.equal(snapshots.at(-1)?.status, "passed");
  assert.equal(report.status, "passed");
  assert.equal(report.qa_passed, true);
  assert.match(report.local_commit!, /^[a-f0-9]{40}$/);
  assert.equal(report.tasks.length, 5);
  assert.ok(report.tasks.every(t => t.status === "done" && t.attempts === 1));
  assert.equal(report.calls.length, 3);
  assert.equal(report.published, false);
  assert.equal(report.cost.estimated_usd, 0);
  assert.equal(report.live_provider_validated, false);
  assert.equal(report.human_review, "pending");
});

test("local HTTP simulator exercises real router, JSON mode, thinking option and cache-aware estimates", async () => {
  const p = await provider((res, i) => completion(res, i));
  try {
    const report = await runPilot(live, p.router, { pricing });
    assert.equal(report.status, "passed");
    assert.equal(p.calls.length, 3);
    for (const call of p.calls) {
      assert.equal(call.model, live.model);
      assert.deepEqual(call.thinking, { type: "disabled" });
      assert.deepEqual(call.response_format, { type: "json_object" });
      assert.ok(Number(call.max_tokens) <= 8000);
    }
    assert.deepEqual(report.tokens, { prompt: 300, completion: 30, unreported_calls: 0 });
    assert.equal(report.cost.method, "reported_cache");
    assert.equal(report.cost.estimated_usd, 0.000252);
    assert.ok(report.calls.every(c => Number.isFinite(c.duration_ms) && c.duration_ms >= 0));
  } finally { await p.close(); }
});

test("HTTP errors do not leak the echoed key, retry, use fallback or claim zero cost", async () => {
  const p = await provider(res => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fake-secret-for-local-test", type: "authentication_error" } }));
  });
  try {
    const report = await runPilot(live, p.router, { pricing });
    assert.equal(report.status, "failed");
    assert.equal(report.stop_reason, "model_error");
    assert.equal(report.calls[0].http_status, 401);
    assert.equal(report.project_status, "quarantine");
    assert.equal(p.calls.length, 1);
    assert.equal(report.tokens.unreported_calls, 1);
    assert.equal(report.cost.estimated_usd, null);
    const stored = JSON.stringify([report, listTasks(report.project_id), db.prepare("SELECT * FROM events").all()]);
    assert.ok(!stored.includes("fake-secret-for-local-test"));
  } finally { await p.close(); }
});

test("truncated model output retains usage and cost evidence without another paid attempt", async () => {
  const p = await provider((res, i) => completion(res, i, usage, "length"));
  try {
    const report = await runPilot(live, p.router, { pricing });
    assert.equal(report.status, "failed");
    assert.equal(report.calls[0].status, "failed");
    assert.equal(report.calls[0].failure, "truncated");
    assert.equal(report.tokens.prompt, 100);
    assert.equal(report.cost.estimated_usd, 0.000084);
    assert.equal(p.calls.length, 1);
  } finally { await p.close(); }
});

test("missing usage stops the live pilot before any further paid work", async () => {
  const p = await provider((res, i) => completion(res, i, null));
  try {
    const report = await runPilot(live, p.router, { pricing });
    assert.equal(report.qa_passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.stop_reason, "usage_missing");
    assert.equal(report.live_provider_validated, false);
    assert.equal(report.tokens.unreported_calls, 1);
    assert.equal(p.calls.length, 1);
    assert.equal(report.cost.estimated_usd, null);
  } finally { await p.close(); }
});

test("malformed response envelopes preserve reported usage and safe failure evidence", async () => {
  const p = await provider(res => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ usage }));
  });
  try {
    const report = await runPilot(live, p.router, { pricing });
    assert.equal(report.status, "failed");
    assert.equal(report.calls[0].failure, "invalid_response");
    assert.equal(report.tokens.prompt, 100);
    assert.equal(report.cost.estimated_usd, 0.000084);
    assert.equal(p.calls.length, 1);
  } finally { await p.close(); }
});

for (const stage of [0, 1, 2]) for (const format of ["json", "schema"]) {
  const content = format === "json" ? '{"private-response-sentinel": invalid}'
    : stage === 0 ? JSON.stringify({ ...JSON.parse(responses[0].content), service_type: "private-response-sentinel" })
    : JSON.stringify({ ...JSON.parse(responses[stage].content), "private-response-sentinel": true });
  test(`stage ${stage + 1} invalid ${format} never persists raw model data in diagnostic errors`, async () => {
    const p = await provider((res, index) => {
      if (index !== stage) { completion(res, index); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage }));
    });
    try {
      const report = await runPilot(live, p.router);
      assert.equal(report.status, "failed");
      assert.equal(p.calls.length, stage + 1);
      const stored = JSON.stringify([report, listTasks(report.project_id), db.prepare("SELECT * FROM events").all()]);
      assert.ok(!stored.includes("private-response-sentinel"));
    } finally { await p.close(); }
  });
}

test("persistent checkpoint failure at completion rejects acceptance and quarantines the finished project", async () => {
  let projectId = "";
  const p = await provider((res, i) => completion(res, i));
  try {
    await assert.rejects(runPilot(live, p.router, { checkpoint(snapshot) {
      projectId = snapshot.project_id;
      if (snapshot.status === "passed") throw new Error("private-final-path-sentinel");
    } }), error => error instanceof Error && !error.message.includes("private-final-path-sentinel"));
    assert.equal(p.calls.length, 3);
    assert.equal((db.prepare("SELECT status FROM projects WHERE id = ?").get(projectId) as { status: string }).status, "quarantine");
    assert.ok(listTasks(projectId).every(t => t.status === "done"));
  } finally { await p.close(); }
});

test("a permanently unavailable checkpoint store stops before dispatch and leaves recoverable quarantine", async () => {
  const p = await provider((res, i) => completion(res, i));
  try {
    await assert.rejects(runPilot(live, p.router, { checkpoint() { throw new Error("private-disk-sentinel"); } }),
      error => error instanceof Error && !error.message.includes("private-disk-sentinel"));
    assert.equal(p.calls.length, 0);
    assert.equal((db.prepare("SELECT status FROM projects").get() as { status: string }).status, "quarantine");
  } finally { await p.close(); }
});

for (const when of ["initial", "before_dispatch", "usage", "after_task"] as const) {
  test(`checkpoint failure at ${when} stops work and sanitizes storage diagnostics`, async () => {
    let injected = false;
    const snapshots: PilotReport[] = [];
    const p = await provider((res, i) => completion(res, i));
    try {
      const report = await runPilot(live, p.router, { pricing, checkpoint(snapshot) {
        const matches = when === "initial" ? snapshot.calls.length === 0
          : when === "before_dispatch" ? snapshot.calls.length === 1
          : when === "usage" ? snapshot.calls[0]?.usage !== null && snapshot.calls.length > 0
          : snapshot.tasks.some(t => t.status === "done");
        if (!injected && matches) { injected = true; throw new Error("private-checkpoint-path-sentinel"); }
        snapshots.push(structuredClone(snapshot));
      } });
      assert.equal(injected, true);
      assert.equal(report.status, "failed");
      assert.equal(report.stop_reason, "checkpoint_error");
      assert.equal(report.project_status, "quarantine");
      assert.equal(p.calls.length, when === "initial" || when === "before_dispatch" ? 0 : 1);
      assert.equal(snapshots.at(-1)?.status, "failed");
      assert.ok(!report.tasks.some(t => ["queued", "running"].includes(t.status)));
      const stored = JSON.stringify([report, listTasks(report.project_id), db.prepare("SELECT * FROM events").all()]);
      assert.ok(!stored.includes("private-checkpoint-path-sentinel"));
    } finally { await p.close(); }
  });
}

test("unknown cache breakdown uses a labeled uncached estimate and invalid counts stay unknown", async () => {
  assert.equal(readModelUsage({ prompt_tokens: -1, completion_tokens: 2 }), null);
  assert.equal(readModelUsage({ prompt_tokens: 1, completion_tokens: 0.5 }), null);
  assert.deepEqual(readModelUsage({ ...usage, prompt_cache_hit_tokens: 999 }), { prompt_tokens: 100, completion_tokens: 10 });
  const p = await provider((res, i) => completion(res, i, { prompt_tokens: 100, completion_tokens: 10 }));
  try {
    const report = await runPilot(live, p.router, { pricing });
    assert.equal(report.cost.method, "uncached_upper_estimate");
    assert.equal(report.cost.estimated_usd, 0.00036);
  } finally { await p.close(); }
});

test("call cap prevents the next dispatch and leaves unfinished work quarantined", async () => {
  const p = await provider((res, i) => completion(res, i));
  try {
    const report = await runPilot({ ...live, maxCalls: 2 }, p.router);
    assert.equal(p.calls.length, 2);
    assert.equal(report.stop_reason, "call_limit");
    assert.equal(report.project_status, "quarantine");
    assert.equal(report.cost.estimated_usd, null);
    assert.ok(report.tasks.every(t => t.status !== "queued" && t.status !== "running"));
  } finally { await p.close(); }
});

test("cancellation interrupts an active model request and preserves an incomplete cost record", async () => {
  const controller = new AbortController();
  const p = await provider(() => controller.abort());
  try {
    const report = await runPilot(live, p.router, { signal: controller.signal, pricing });
    assert.equal(report.status, "cancelled");
    assert.equal(report.stop_reason, "cancelled");
    assert.equal(report.project_status, "quarantine");
    assert.equal(p.calls.length, 1);
    assert.equal(report.cost.estimated_usd, null);
  } finally { await p.close(); }
});

test("pilot refuses to consume an existing project queue", async () => {
  const existing = createProject({ source: "manual", raw_text: "Projeto anterior que deve ser preservado." });
  await assert.rejects(runPilot(offline, new DemoRouter()), /banco vazio/);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count, 1);
  assert.equal(listTasks(existing.id).length, 0);
});

test("CLI isolates each run, ignores operational config offline and fails before a live run without a key", () => {
  const configPath = path.join(directory, "jpxforge.config.json");
  const sentinel = "invalid operational config: MUST NOT BE READ OR CHANGED OFFLINE";
  writeFileSync(configPath, sentinel);
  const cli = path.join(repoRoot, "apps/orchestrator/src/pilot.ts");
  const dirs: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--offline"], {
        cwd: repoRoot, env: { ...process.env, FORGE_DATA_DIR: directory, DEEPSEEK_API_KEY: "" }, encoding: "utf8", timeout: 30000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const reportPath = result.stdout.match(/Relatório: (.+pilot-report\.json)/)?.[1];
      assert.ok(reportPath, result.stdout);
      dirs.push(path.dirname(reportPath));
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(report.status, "passed");
      assert.equal(report.mode, "offline");
      assert.equal(existsSync(path.join(path.dirname(reportPath), "jpxforge.config.json")), false);
    }
    assert.notEqual(dirs[0], dirs[1]);
    assert.equal(readFileSync(configPath, "utf8"), sentinel);
    rmSync(configPath);
    const pilotsRoot = path.join(repoRoot, ".forge-pilots");
    const before = readdirSync(pilotsRoot).sort();
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--live", "--model", live.model], {
      cwd: repoRoot, env: { ...process.env, FORGE_DATA_DIR: directory, DEEPSEEK_API_KEY: "" }, encoding: "utf8", timeout: 30000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Chave DeepSeek ausente/);
    assert.deepEqual(readdirSync(pilotsRoot).sort(), before);
  } finally {
    for (const dir of dirs) {
      assert.equal(path.dirname(dir), path.join(repoRoot, ".forge-pilots"));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

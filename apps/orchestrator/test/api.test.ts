import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ForgeConfigSchema, ForgeEventSchema, TaskSchema } from "@jpxforge/shared";

const tempRoot = path.resolve(os.tmpdir());
const dataDir = mkdtempSync(path.join(tempRoot, "jpxforge-api-"));
process.env.FORGE_DATA_DIR = dataDir;
const { createApp } = await import("../src/server.js");
const { db, listTasks } = await import("../src/db.js");
const { emit } = await import("../src/events.js");
const { createProject, enqueueTask } = await import("../src/db.js");
const { runNextTask } = await import("../src/queue.js");
const { DemoRouter } = await import("../src/demo-router.js");
const config = ForgeConfigSchema.parse({ version: 1, providers: { deepseek: { api_key: "test-secret-never-serialize", base_url: "http://127.0.0.1:1", enabled: true } }, roles: {} });
const app = await createApp(config, { demo: true });
await app.listen({ host: "127.0.0.1", port: 0 });
after(async () => {
  await app.close(); db.close();
  assert.equal(path.dirname(path.resolve(dataDir)), tempRoot);
  assert.ok(path.basename(dataDir).startsWith("jpxforge-api-"));
  rmSync(dataDir, { recursive: true, force: true });
});

test("health exposes configuration presence, never secrets or fake connectivity", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mode, "demo");
  assert.deepEqual(response.json().providers.deepseek, { configured: true });
  assert.ok(!response.body.includes("test-secret"));
});

test("invalid briefings never enqueue; valid briefing creates one durable task", async () => {
  const invalid = await app.inject({ method: "POST", url: "/briefings", payload: { raw_text: "short" } });
  assert.equal(invalid.statusCode, 400);
  const response = await app.inject({ method: "POST", url: "/briefings", payload: { raw_text: "Uma landing page para o negócio fictício." } });
  assert.equal(response.statusCode, 201);
  const id = response.json().project_id;
  const tasks = listTasks(id);
  assert.equal(tasks.length, 1);
  assert.equal(TaskSchema.parse(tasks[0]).status, "queued");
  const abort = await app.inject({ method: "POST", url: `/projects/${id}/abort` });
  assert.equal(abort.statusCode, 200);
  assert.equal(listTasks(id)[0].status, "failed");
  assert.equal((await app.inject({ method: "POST", url: `/projects/${id}/abort` })).statusCode, 409);
  assert.equal((await app.inject({ method: "GET", url: "/briefings/missing" })).statusCode, 404);
});

test("local API rejects foreign origins and rebinding hostnames", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/projects", headers: { host: "evil.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/briefings", headers: { origin: "https://evil.example" }, payload: { raw_text: "Uma página indevida de outro site." } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/health", headers: { host: "localhost:4100", origin: "http://localhost:4100" } })).statusCode, 200);
});

test("event replay bounds reject unbounded or malformed queries", async () => {
  for (const limit of ["-1", "NaN", "1.5", "501", "Infinity"]) {
    assert.equal((await app.inject({ method: "GET", url: `/events?limit=${limit}` })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "GET", url: "/events?limit=10" })).statusCode, 200);
});

test("dashboard serves only fixed assets with a restrictive policy", async () => {
  const response = await app.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /O escritório/);
  assert.match(response.headers["content-security-policy"] as string, /script-src 'self'/);
  assert.equal((await app.inject({ method: "GET", url: "/dashboard.js" })).statusCode, 200);
  for (const url of ["/jpxforge.db", "/jpxforge.config.json", "/preview/prj_0123456789ab/jpxforge.db"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  }
});

test("preview is gated by successful QA and serves sandboxed build outputs only", async () => {
  const project = createProject({ source: "manual", raw_text: "Landing page fictícia para testar a prévia local." });
  enqueueTask({ project_id: project.id, role: "product_owner", title: "Especificar página", payload: { kind: "ingest_briefing" } });
  const url = `/preview/${project.id}/index.html`;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 409);
  const router = new DemoRouter();
  for (let i = 0; i < 5; i++) assert.equal(await runNextTask(router), true);
  const response = await app.inject({ method: "GET", url });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Estúdio Aurora/);
  assert.match(response.headers["content-security-policy"] as string, /^sandbox;/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal((await app.inject({ method: "GET", url: `/preview/${project.id}/styles.css` })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/preview/${project.id}/package.json` })).statusCode, 404);
});

test("WebSocket streams the same persisted event available in replay", async () => {
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/events/live`);
  try {
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("WebSocket failed")); });
    const next = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 2000);
      socket.onmessage = event => { clearTimeout(timeout); resolve(String(event.data)); };
    });
    const event = emit({ type: "agent.say", project_id: null, role: "qa", message: "Evidência real de stream local." });
    assert.deepEqual(ForgeEventSchema.parse(JSON.parse(await next)), event);
    assert.ok((await app.inject({ method: "GET", url: "/events" })).json().events.some((entry: { id: string }) => entry.id === event.id));
  } finally { socket.close(); }
});

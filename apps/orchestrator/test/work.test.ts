import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ForgeConfigSchema, type Handoff, type WorkEventPayload } from "@jpxforge/shared";

const tempRoot = path.resolve(os.tmpdir());
const dataDirectory = mkdtempSync(path.join(tempRoot, "jpxforge-work-"));
process.env.FORGE_DATA_DIR = dataDirectory;
const { db, createProject, enqueueTask, getProject, listTasks } = await import("../src/db.js");

// Simulate the pre-upgrade database before loading its migration.
const stamp = new Date().toISOString();
db.prepare(`INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run("legacy", "legacy-project", "legacy-test-claim", "legacy-worker", 3, 9, 1,
    new Date(Date.now() + 60_000).toISOString(), "active", stamp, stamp);
db.prepare(`INSERT INTO work_outbox VALUES (?, ?, ?, ?, ?, ?)`)
  .run("legacy-event", "legacy", 1, JSON.stringify({ claimToken: "legacy-test-claim", type: "progress", message: "Original" }), 0, stamp);
const {
  createExecution, closeExecution, getExecution, getActiveExecution, queueWorkEvent, pendingWorkEvents, confirmWorkEvent,
} = await import("../src/executions.js");
const { WorkClient, WorkConflictError, WorkRevokedError } = await import("../src/work-client.js");
const { WorkPoller, startWorkPoller, stopWorkPoller } = await import("../src/work-poller.js");

const migrated = pendingWorkEvents("legacy-worker")[0];
assert.equal(migrated.attempt, 3);
assert.deepEqual(JSON.parse(migrated.payload), {
  claimToken: "legacy-test-claim", type: "progress", message: "Original", eventId: "legacy-event", sequence: 1,
});
assert.equal(getExecution("legacy", 3)?.sequence, 1);

beforeEach(async () => {
  await stopWorkPoller();
  db.exec("DELETE FROM work_outbox; DELETE FROM executions; DELETE FROM tasks; DELETE FROM projects; DELETE FROM events;");
});
after(async () => {
  await stopWorkPoller();
  db.close();
  assert.equal(path.dirname(path.resolve(dataDirectory)), tempRoot);
  assert.ok(path.basename(dataDirectory).startsWith("jpxforge-work-"));
  rmSync(dataDirectory, { recursive: true, force: true });
});

function handoff(extra: Partial<Handoff> = {}): Handoff {
  return {
    id: "handoff-local", status: "running", version: 2, attempt: 1, lastSequence: 0,
    claimToken: "test-claim-only", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    brief: { title: "Teste local", objective: "Validar protocolo", scope: [], acceptanceCriteria: [], constraints: [], domain: "test" },
    ...extra,
  };
}
function execution(h = handoff(), workerId = "stable-worker") {
  const project = createProject({ source: "manual", raw_text: "Teste local do protocolo WORK." });
  enqueueTask({ project_id: project.id, title: "Tarefa local", role: "fullstack_dev" });
  return createExecution(h, project.id, workerId);
}
function config(url = "http://127.0.0.1:1", autoClaim = false) {
  return ForgeConfigSchema.parse({ version: 1, providers: {}, roles: {},
    work: { token: "local-test-token", worker_id: "stable-worker", base_url: url, auto_claim: autoClaim } });
}
function ack(body: WorkEventPayload, extra: Record<string, unknown> = {}) {
  return {
    id: "handoff-local", attempt: 1, version: 2 + body.sequence, lastSequence: body.sequence,
    status: body.type === "progress" ? "running" : body.type === "completed" ? "awaiting_review" : "failed",
    leaseExpiresAt: body.type === "progress" ? new Date(Date.now() + 120_000).toISOString() : null,
    ...extra,
  };
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
async function server(handler: (body: any, response: ServerResponse, request: IncomingMessage) => void) {
  const calls: { path: string; body: any; raw: string }[] = [];
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: request.url!, body, raw });
    assert.equal(request.headers.authorization, "Bearer local-test-token");
    handler(body, response, request);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return {
    calls, url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
  };
}
function outboxRows() { return db.prepare("SELECT * FROM work_outbox ORDER BY rowid").all() as any[]; }

test("migration preserves legacy attempt, sequence, claim and exact outbound content", () => {
  assert.equal(migrated.attempt, 3);
  assert.equal(migrated.sequence, 1);
  assert.equal(migrated.confirmed, 0);
});

test("WORK rejects insecure endpoints and credentials in URLs before sending", () => {
  for (const url of ["http://remote.example.test", "https://user:password@example.test", "http://127.0.0.1?token=secret"]) {
    assert.throws(() => new WorkClient({ ...config().work, base_url: url }));
  }
});

test("claim uses stable worker, preserves approval metadata and propagates busy/revoked responses", async () => {
  let code = 200;
  let empty = true;
  const mock = await server((_body, response, request) => {
    if (request.url?.endsWith("/status")) json(response, 200, { service: "work", protocolVersion: 1, paused: false, ready: 0 });
    else json(response, code, { handoff: empty ? null : { ...handoff(), clientApproval: { state: "approved", approvedAt: stamp, method: "manual" } } });
  });
  try {
    const client = new WorkClient(config(mock.url).work);
    assert.equal((await client.status()).ready, 0);
    assert.equal(await client.claim(), null);
    empty = false;
    assert.equal((await client.claim())?.clientApproval?.state, "approved");
    code = 409;
    await assert.rejects(client.claim(), WorkConflictError);
    code = 403;
    await assert.rejects(client.claim(), WorkRevokedError);
    assert.ok(mock.calls.slice(1).every((call) => call.body.workerId === "stable-worker"));
    assert.ok(mock.calls.every((call) => !call.path.includes("token")));
  } finally { await mock.close(); }
});

test("outbox allocation is atomic when insertion fails", () => {
  execution();
  db.exec(`CREATE TEMP TRIGGER simulate_outbox_failure BEFORE INSERT ON work_outbox
    BEGIN SELECT RAISE(ABORT, 'simulated disk insert failure'); END;`);
  try {
    assert.throws(() => queueWorkEvent("handoff-local", { type: "progress", message: "Tentativa" }), /simulated/);
    assert.equal(getExecution("handoff-local")?.sequence, 0);
    assert.equal(outboxRows().length, 0);
  } finally { db.exec("DROP TRIGGER simulate_outbox_failure"); }
  queueWorkEvent("handoff-local", { type: "progress", message: "Persistido" });
  assert.equal(pendingWorkEvents()[0].sequence, 1);
});

test("one active concession per worker and each new attempt gets a new token and sequence", () => {
  execution();
  assert.throws(() => execution(handoff({ id: "second-handoff" })), /UNIQUE/);
  queueWorkEvent("handoff-local", { type: "progress", message: "Tentativa anterior" });
  const previousId = outboxRows()[0].event_id;
  closeExecution("handoff-local", "aborted", 1);
  assert.throws(() => execution(handoff({ attempt: 2 })), /nova concessão/);
  execution(handoff({ attempt: 2, claimToken: "new-test-claim" }));
  queueWorkEvent("handoff-local", { type: "progress", message: "Nova tentativa" });
  const pending = pendingWorkEvents();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempt, 2);
  assert.equal(pending[0].sequence, 1);
  assert.notEqual(pending[0].event_id, previousId);
  assert.equal(getExecution("handoff-local", 1)?.status, "aborted");
  assert.equal(JSON.parse(pending[0].payload).claimToken, "new-test-claim");
});

test("lost response preserves exact retry body and blocks following sequences until ACK", async () => {
  const ex = execution();
  queueWorkEvent(ex.handoff_id, { type: "progress", message: "Primeiro" });
  queueWorkEvent(ex.handoff_id, { type: "progress", message: "Segundo" });
  let fail = true;
  const mock = await server((body, response) => {
    if (fail) { fail = false; response.destroy(); }
    else json(response, 200, ack(body));
  });
  const poller = new WorkPoller(new WorkClient(config(mock.url).work), 5, () => {});
  try {
    await poller.runOnce();
    assert.equal(mock.calls.length, 1);
    assert.equal(outboxRows().filter((event) => event.confirmed).length, 0);
    await poller.runOnce();
    assert.deepEqual(mock.calls.map((call) => call.body.sequence), [1, 1, 2]);
    assert.equal(mock.calls[0].raw, mock.calls[1].raw);
    assert.ok(outboxRows().every((event) => event.confirmed === 1));
    assert.ok(Date.parse(getExecution(ex.handoff_id)!.lease_expires_at) > Date.parse(ex.lease_expires_at));
  } finally { await poller.stop(); await mock.close(); }
});

test("409 divergence quarantines and cancels work without confirming or advancing events", async () => {
  const ex = execution();
  queueWorkEvent(ex.handoff_id, { type: "progress", message: "Primeiro" });
  queueWorkEvent(ex.handoff_id, { type: "progress", message: "Segundo" });
  const mock = await server((_body, response) => json(response, 409, { error: "sequence_conflict" }));
  const canceled: string[] = [];
  const poller = new WorkPoller(new WorkClient(config(mock.url).work), 5, (id) => { canceled.push(id); });
  try {
    await poller.runOnce();
    await poller.runOnce();
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(canceled, [ex.project_id]);
    assert.ok(outboxRows().every((event) => event.confirmed === 0));
    assert.equal(getExecution(ex.handoff_id)?.status, "aborted");
    assert.equal(getProject(ex.project_id)?.status, "quarantine");
    assert.equal(listTasks(ex.project_id)[0].status, "failed");
  } finally { await poller.stop(); await mock.close(); }
});

test("revoked concession aborts local work and stops all further requests", async () => {
  const ex = execution();
  queueWorkEvent(ex.handoff_id, { type: "progress", message: "Primeiro" });
  const mock = await server((_body, response) => json(response, 403, { error: "revoked" }));
  const canceled: string[] = [];
  const poller = new WorkPoller(new WorkClient(config(mock.url).work), 5, (id) => { canceled.push(id); });
  try {
    await poller.runOnce();
    await poller.runOnce();
    assert.equal(poller.revoked, true);
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(canceled, [ex.project_id]);
    assert.equal(outboxRows()[0].confirmed, 0);
  } finally { await poller.stop(); await mock.close(); }
});

test("expired lease stops before network and expiry during request cooperatively aborts", async () => {
  const ex = execution();
  queueWorkEvent(ex.handoff_id, { type: "progress", message: "Primeiro" });
  const mock = await server(() => {});
  const canceled: string[] = [];
  const poller = new WorkPoller(new WorkClient(config(mock.url).work), 5, (id) => { canceled.push(id); });
  try {
    db.prepare("UPDATE executions SET lease_expires_at = ?").run(new Date(Date.now() - 1).toISOString());
    await poller.runOnce();
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(canceled, [ex.project_id]);
    execution(handoff({ attempt: 2, claimToken: "new-test-claim" }));
    queueWorkEvent(ex.handoff_id, { type: "progress", message: "Segundo" });
    db.prepare("UPDATE executions SET lease_expires_at = ? WHERE attempt = 2").run(new Date(Date.now() + 100).toISOString());
    const before = Date.now();
    await poller.runOnce();
    assert.ok(Date.now() - before < 3000);
    assert.equal(mock.calls.length, 1);
    assert.equal(getExecution(ex.handoff_id)?.status, "aborted");
    assert.equal(canceled.length, 2);
  } finally { await poller.stop(); await mock.close(); }
});

test("terminal ACK closes execution and prevents duplicate or subsequent work events", async () => {
  for (const type of ["completed", "failed"] as const) {
    const ex = execution(handoff({ id: type }));
    queueWorkEvent(ex.handoff_id, type === "completed"
      ? { type, result: { summary: "Resultado de teste local", checks: [{ name: "Teste simulado", status: "passed" }] } }
      : { type, message: "Falha de teste local" });
    assert.throws(() => queueWorkEvent(ex.handoff_id, { type: "progress", message: "Tardio" }), /terminal/);
    const ev = pendingWorkEvents()[0];
    const body = JSON.parse(ev.payload);
    confirmWorkEvent(ev.event_id, ack(body, { id: ex.handoff_id }));
    assert.equal(getExecution(ex.handoff_id)?.status, type);
    assert.equal(getActiveExecution(), null);
    assert.equal(outboxRows().find((row) => row.event_id === ev.event_id).confirmed, 1);
  }
});

test("invalid acknowledgement cannot mark event delivered or replace the local lease", async () => {
  const ex = execution();
  queueWorkEvent(ex.handoff_id, { type: "progress", message: "Primeiro" });
  const mock = await server((body, response) => json(response, 200, ack(body, { attempt: 9 })));
  const poller = new WorkPoller(new WorkClient(config(mock.url).work), 5, () => {});
  try {
    await poller.runOnce();
    assert.equal(outboxRows()[0].confirmed, 0);
    assert.equal(getExecution(ex.handoff_id)?.lease_expires_at, ex.lease_expires_at);
    assert.equal(getExecution(ex.handoff_id)?.status, "aborted");
  } finally { await poller.stop(); await mock.close(); }
});

test("concurrent poll ticks share one request and stopping cancels an in-flight request", async () => {
  execution();
  queueWorkEvent("handoff-local", { type: "progress", message: "Primeiro" });
  let received!: () => void;
  const arrival = new Promise<void>((resolve) => { received = resolve; });
  const mock = await server(() => received());
  const poller = new WorkPoller(new WorkClient(config(mock.url).work), 5, () => {});
  try {
    const first = poller.runOnce();
    const second = poller.runOnce();
    assert.equal(first, second);
    await arrival;
    await poller.stop();
    await Promise.all([first, second]);
    assert.equal(mock.calls.length, 1);
    assert.equal(outboxRows()[0].confirmed, 0);
    assert.equal(getExecution("handoff-local")?.status, "active");
  } finally { await poller.stop(); await mock.close(); }
});

test("auto_claim true fails clearly and false still drains persisted executions without claiming", async () => {
  assert.equal(config().work.auto_claim, false);
  assert.throws(() => startWorkPoller(config(undefined, true)), /Fase 4/);
  execution();
  queueWorkEvent("handoff-local", { type: "progress", message: "Persistido" });
  let received!: () => void;
  const arrival = new Promise<void>((resolve) => { received = resolve; });
  const mock = await server((body, response) => { json(response, 200, ack(body)); received(); });
  try {
    startWorkPoller(config(mock.url));
    await arrival;
    // stop can race ACK parsing; only outbound path matters in this scheduler test.
    await stopWorkPoller();
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].path.endsWith("/events"));
  } finally { await stopWorkPoller(); await mock.close(); }
});

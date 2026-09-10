import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ForgeConfigSchema } from "@jpxforge/shared";

const tempRoot = path.resolve(os.tmpdir());
const dataDir = mkdtempSync(path.join(tempRoot, "jpxforge-publish-api-"));
process.env.FORGE_DATA_DIR = dataDir;
const { createApp } = await import("../src/server.js");
const { db, getProject, listTasks, createProject, enqueueTask, updateProject, completeTask } = await import("../src/db.js");
const { runNextTask } = await import("../src/queue.js");
const { DemoRouter } = await import("../src/demo-router.js");
const config = ForgeConfigSchema.parse({ version: 1, providers: {}, roles: {} });
const app = await createApp(config);
const demoApp = await createApp(config, { demo: true });
const router = new DemoRouter();
const remote = path.join(dataDir, "remote.git");
execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
after(async () => {
  await app.close(); await demoApp.close(); db.close();
  assert.equal(path.dirname(path.resolve(dataDir)), tempRoot);
  assert.ok(path.basename(dataDir).startsWith("jpxforge-publish-api-"));
  rmSync(dataDir, { recursive: true, force: true });
});
const publish = (id: string, payload: unknown = { remote }) => app.inject({ method: "POST", url: `/projects/${id}/publish`, payload: payload as object });
function reviewProject() {
  const project = createProject({ source: "manual", raw_text: "Landing page sintética para validação da publicação." });
  updateProject(project.id, { status: "review" });
  const task = enqueueTask({ project_id: project.id, role: "tech_lead", title: "Entrega local", payload: { kind: "publish_landing" } });
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
  assert.equal(completeTask(task.id, { published: false }), true);
  return project.id;
}

test("live API enqueues exactly one explicit publication and pushes verified output to bare Git", async () => {
  const created = await app.inject({ method: "POST", url: "/briefings", payload: { raw_text: "Uma landing page sintética para testar a entrega Git." } });
  assert.equal(created.statusCode, 201);
  const id = created.json().project_id as string;
  for (let i = 0; i < 5; i++) assert.equal(await runNextTask(router), true);
  assert.equal(getProject(id)?.status, "review");
  assert.equal(listTasks(id).length, 5);
  const branch = "joao2709/publish-api";
  const requests = await Promise.all([publish(id, { remote, branch }), publish(id, { remote, branch })]);
  assert.deepEqual(requests.map(response => response.statusCode).sort(), [202, 409]);
  const task = listTasks(id).find(task => task.status === "queued")!;
  assert.equal(task.max_attempts, 1);
  assert.equal(task.role, "tech_lead");
  assert.deepEqual(task.payload, { kind: "publish_landing", publish: { remote, branch } });
  assert.equal(await runNextTask(router), true);
  assert.equal(getProject(id)?.status, "shipped");
  assert.equal(getProject(id)?.repo_url, remote);
  const delivery = listTasks(id).find(entry => entry.id === task.id)!;
  assert.equal(delivery.status, "done");
  assert.equal((delivery.result as { published: boolean }).published, true);
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim(), (delivery.result as { commit: string }).commit);
  assert.equal((await publish(id)).statusCode, 409);
});

test("demo rejects publication and invalid destinations never enqueue", async () => {
  const id = reviewProject();
  assert.equal((await demoApp.inject({ method: "POST", url: `/projects/${id}/publish`, payload: { remote } })).statusCode, 409);
  for (const payload of [{ remote: "https://user:secret@example.test/repo.git" }, { remote, branch: "main" }, { remote: 1 }, { remote, branch: {} }, { remote, extra: true }, null]) {
    assert.equal((await publish(id, payload)).statusCode, 400);
  }
  assert.equal(listTasks(id).length, 1);
  assert.equal((await publish("missing")).statusCode, 404);
});

test("publication requires review, completed local delivery and a clear project queue", async () => {
  const missingDelivery = createProject({ source: "manual", raw_text: "Projeto sintético sem entrega anterior concluída." });
  updateProject(missingDelivery.id, { status: "review" });
  assert.equal((await publish(missingDelivery.id)).statusCode, 409);
  for (const status of ["queued", "running", "failed", "blocked"]) {
    const id = reviewProject();
    const task = enqueueTask({ project_id: id, role: "qa", title: "Trabalho não concluído" });
    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, task.id);
    assert.equal((await publish(id)).statusCode, 409);
    updateProject(id, { status: "aborted" });
  }
  for (const status of ["planned", "building", "aborted", "quarantine", "shipped"] as const) {
    const id = reviewProject();
    updateProject(id, { status });
    assert.equal((await publish(id)).statusCode, 409);
  }
});

test("worker revalidates persisted publication input before effects", async () => {
  const id = reviewProject();
  enqueueTask({ project_id: id, role: "tech_lead", title: "Destino adulterado", payload: { kind: "publish_landing", publish: { remote, branch: 123 } } });
  assert.equal(await runNextTask(router), true);
  assert.equal(getProject(id)?.status, "quarantine");
  assert.match(listTasks(id).find(task => task.status === "blocked")!.error!, /persistido inválido/);
});

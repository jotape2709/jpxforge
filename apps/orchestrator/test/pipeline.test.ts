import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Role } from "@jpxforge/shared";
import type { ChatOptions, ChatResult } from "../src/model-router.js";
import type { PipelineRouter } from "../src/pipeline/contracts.js";

const temporaryRoot = path.resolve(os.tmpdir());
const dataDirectory = mkdtempSync(path.join(temporaryRoot, "jpxforge-pipeline-"));
process.env.FORGE_DATA_DIR = dataDirectory;
const { db, createProject, getProject, updateProject, enqueueTask, listTasks, abortProjectTasks } = await import("../src/db.js");
const { runNextTask, startWorker, stopWorker, cancelProjectWork } = await import("../src/queue.js");
const { workspacePath, writeLanding, qaLanding, validateLanding, validatePublishOptions } = await import("../src/pipeline/workspace.js");

const spec = {
  title: "Jardim de Teste", service_type: "landing_page", summary: "Landing demonstrativa sem dados reais.",
  business: { client_name: "Jardim de Teste", niche: "jardinagem", value_proposition: "Cuidado com seu jardim", call_to_action: "Fale conosco" },
  sections: ["Hero", "Serviços", "Contato"], requirements: ["Layout responsivo"], brand: { colors: ["#123456"], tone: "profissional" }, deadline_days: 7,
};
const plan = { tasks: [
  { key: "build", title: "Construir landing page", kind: "build_landing", depends_on: [] },
  { key: "qa", title: "Validar build e testes", kind: "qa_landing", depends_on: ["build"] },
  { key: "publish", title: "Preparar entrega", kind: "publish_landing", depends_on: ["qa"] },
] };
const content = {
  title: "Jardim de Teste",
  body: '<main><section><h1>Cuidado com seu jardim</h1><p>Serviços de jardinagem sob consulta.</p><a href="#contato">Fale conosco</a></section><section id="contato"><h2>Vamos conversar</h2><p>Envie seu briefing ao time.</p></section></main>',
  css: "body { color: #123456; margin: 0; } main { max-width: 70rem; margin: auto; padding: clamp(1rem, 4vw, 4rem); }",
};
function result(value: unknown): ChatResult {
  return { content: JSON.stringify(value), provider: "offline", model: "fixture", usedFallback: false, usage: { prompt_tokens: 0, completion_tokens: 0 } };
}
class FakeRouter implements PipelineRouter {
  calls: Role[] = [];
  fail?: Role;
  output = content;
  async chat(role: Role, _messages: unknown, opts: ChatOptions = {}): Promise<ChatResult> {
    opts.signal?.throwIfAborted();
    this.calls.push(role);
    if (this.fail === role) throw new Error("Erro simulado de modelo");
    return result(role === "product_owner" ? spec : role === "tech_lead" ? plan : this.output);
  }
}
function project() {
  const p = createProject({ source: "manual", raw_text: "Landing page demonstrativa de jardinagem." });
  enqueueTask({ project_id: p.id, title: "Especificar briefing", role: "product_owner", payload: { kind: "ingest_briefing" } });
  return p;
}
async function drain(router: PipelineRouter, options: Parameters<typeof runNextTask>[1] = {}) {
  let runs = 0;
  while (await runNextTask(router, options)) {
    assert.ok(++runs < 12, "fila deve terminar em tentativas finitas");
  }
  return runs;
}
beforeEach(async () => {
  await stopWorker();
  db.exec("DELETE FROM tasks; DELETE FROM projects; DELETE FROM token_usage; DELETE FROM events;");
});
after(async () => {
  await stopWorker();
  db.close();
  assert.equal(path.dirname(path.resolve(dataDirectory)), temporaryRoot);
  assert.ok(path.basename(dataDirectory).startsWith("jpxforge-pipeline-"));
  rmSync(dataDirectory, { recursive: true, force: true });
});

test("offline briefing passes five dependent tasks, real build/node:test and local git commit", async () => {
  const p = project(), router = new FakeRouter();
  assert.equal(await drain(router), 5);
  const tasks = listTasks(p.id);
  assert.deepEqual(tasks.map(t => t.status), Array(5).fill("done"), JSON.stringify(tasks));
  assert.deepEqual(router.calls, ["product_owner", "tech_lead", "fullstack_dev"]);
  assert.equal(getProject(p.id)?.status, "review");
  const delivery = tasks.at(-1)!.result as { workspace: string; commit: string; published: boolean };
  assert.equal(delivery.published, false);
  assert.match(delivery.commit, /^[a-f0-9]{40}$/);
  assert.equal(readFileSync(path.join(delivery.workspace, "dist/index.html"), "utf8"), readFileSync(path.join(delivery.workspace, "index.html"), "utf8"));
  assert.equal(JSON.parse(readFileSync(path.join(delivery.workspace, "qa-report.json"), "utf8")).passed, true);
  const tracked = spawnSync("git", ["ls-files"], { cwd: delivery.workspace, encoding: "utf8", windowsHide: true });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.deepEqual(tracked.stdout.trim().split(/\r?\n/).sort(), [".gitignore", "index.html", "package.json", "scripts/build.mjs", "styles.css", "test/landing.test.mjs"].sort());
});

test("explicit local bare remote receives development branch and only then project ships", async () => {
  const p = project(), remote = path.join(dataDirectory, "test-remote.git");
  const init = spawnSync("git", ["init", "--bare", remote], { encoding: "utf8", windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(await drain(new FakeRouter(), { publish: { remote, branch: "joao2709/offline-test" } }), 5);
  assert.equal(getProject(p.id)?.status, "shipped", JSON.stringify(listTasks(p.id)));
  assert.equal(listTasks(p.id).at(-1)?.status, "done");
  const remoteCommit = spawnSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/joao2709/offline-test"], { encoding: "utf8", windowsHide: true });
  assert.equal(remoteCommit.status, 0, remoteCommit.stderr);
  assert.equal(remoteCommit.stdout.trim(), (listTasks(p.id).at(-1)!.result as { commit: string }).commit);
});

test("model failures retry finitely and quarantine downstream tasks", async () => {
  const p = project(), router = new FakeRouter();
  router.fail = "fullstack_dev";
  assert.equal(await drain(router), 4);
  assert.equal(getProject(p.id)?.status, "quarantine");
  assert.deepEqual(listTasks(p.id).map(t => t.status), ["done", "done", "failed", "blocked", "blocked"]);
  assert.equal(router.calls.filter(role => role === "fullstack_dev").length, 2);
});

test("unsafe generated HTML quarantines immediately without writing or executing it", async () => {
  const p = project(), router = new FakeRouter();
  router.output = { ...content, body: content.body + '<script>throw new Error("must never run")</script>' };
  assert.equal(await drain(router), 3);
  assert.equal(getProject(p.id)?.status, "quarantine");
  assert.equal(router.calls.filter(role => role === "fullstack_dev").length, 1);
  assert.equal(existsSync(path.join(dataDirectory, "workspaces", p.id, "index.html")), false);
});

test("static validator rejects executable syntax, obfuscated links, external CSS and missing anchors", () => {
  for (const body of [
    content.body.replace("<h1>", '<h1 onclick="alert(1)">'),
    content.body.replace('href="#contato"', 'href="java&#115;cript:alert(1)"'),
    content.body.replace('href="#contato"', 'href="#missing"'),
    content.body + "<!-- extra -->",
    content.body.replace("</main>", "</main><iframe></iframe>"),
    content.body.replace("<h1>", "<H1>"),
  ]) assert.throws(() => validateLanding({ ...content, body }));
  for (const css of ["body { background: url(https://example.test/x); }", "@import 'evil.css';", "body { background: image-set('https://example.test/x'); }", "body { color: r/**/ed; }"])
    assert.throws(() => validateLanding({ ...content, css }));
  assert.doesNotThrow(() => validateLanding(content));
});

test("QA rejects tampered build template before any generated executable runs", async () => {
  const p = project(), { workspace } = writeLanding(p.id, content);
  writeFileSync(path.join(workspace, "scripts/build.mjs"), "throw new Error('not trusted');\n");
  await assert.rejects(qaLanding(p.id), /Template executável/);
  assert.equal(existsSync(path.join(workspace, "dist/index.html")), false);
});

test("workspace traversal and unsafe publish destinations fail closed", () => {
  assert.throws(() => workspacePath("../escape"));
  for (const publish of [
    { remote: "https://token@example.test/repo.git" },
    { remote: "https://example.test/repo.git?token=hidden" },
    { remote: "ext::arbitrary-command" },
    { remote: "https://example.test/repo.git", branch: "main" },
    { remote: "https://example.test/repo.git", branch: "forge/production" },
  ]) assert.throws(() => validatePublishOptions(publish, "prj_000000000000"));
});

test("only one direct queue turn runs; cancellation prevents late model result and tasks", async () => {
  const p = project();
  let finish!: (value: ChatResult) => void;
  const router: PipelineRouter = { chat: async () => new Promise<ChatResult>(resolve => { finish = resolve; }) };
  const first = runNextTask(router);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await runNextTask(router), false);
  updateProject(p.id, { status: "aborted" });
  abortProjectTasks(p.id);
  cancelProjectWork(p.id);
  finish(result(spec));
  assert.equal(await first, true);
  assert.equal(getProject(p.id)?.status, "aborted");
  assert.equal(listTasks(p.id).length, 1);
  assert.equal(listTasks(p.id)[0].status, "failed");
});

test("worker shutdown cancels in-flight model and awaits final quarantine", async () => {
  const p = project();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const router: PipelineRouter = { chat: async (_role, _messages, opts) => new Promise<ChatResult>((_resolve, reject) => {
    entered();
    opts!.signal!.addEventListener("abort", () => reject(opts!.signal!.reason), { once: true });
  }) };
  startWorker(router, 10);
  await started;
  await stopWorker();
  assert.equal(getProject(p.id)?.status, "quarantine");
  assert.equal(listTasks(p.id)[0].status, "blocked");
  assert.equal(await runNextTask(new FakeRouter()), false);
});

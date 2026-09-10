import type { Role, Task } from "@jpxforge/shared";
import { db, claimNextTask, completeTask, failTask, getProject, listTasks, enqueueTask, updateProject, recoverInterruptedTasks } from "./db.js";
import { agentSay, emit } from "./events.js";
import { briefingToSpec } from "./agents/product-owner.js";
import { planLanding } from "./agents/tech-lead.js";
import { buildLanding } from "./agents/builder.js";
import { PipelineSafetyError, type PipelineRouter } from "./pipeline/contracts.js";
import { writeLanding, qaLanding, publishLanding, validatePublishOptions, type PublishOptions } from "./pipeline/workspace.js";

export type { PipelineRouter } from "./pipeline/contracts.js";
export interface WorkerOptions { signal?: AbortSignal; publish?: PublishOptions }
interface Context extends WorkerOptions { signal: AbortSignal; assertActive(): void }
type Handler = (task: Task, router: PipelineRouter, context: Context) => Promise<unknown>;

function projectFor(task: Task) {
  const project = getProject(task.project_id);
  if (!project) throw new Error(`Projeto ${task.project_id} não existe`);
  return project;
}
function taskQueued(task: Task): void {
  emit({ type: "task.queued", project_id: task.project_id, role: task.role, message: `Na fila: ${task.title}`, data: { task_id: task.id } });
}
function quarantine(task: Task, message: string): void {
  const changed = db.transaction(() => {
    if (!updateProject(task.project_id, { status: "quarantine" })) return false;
    db.prepare("UPDATE tasks SET status = 'blocked', error = ?, updated_at = ? WHERE project_id = ? AND status IN ('running', 'queued')")
      .run(message, new Date().toISOString(), task.project_id);
    return true;
  }).immediate();
  if (changed) emit({ type: "project.status", project_id: task.project_id, role: task.role, message: `Projeto em quarentena: ${message}` });
}

const handlers: Record<string, Handler> = {
  async ingest_briefing(task, router, ctx) {
    const project = projectFor(task);
    agentSay("product_owner", project.id, "Recebi o briefing. Vou organizar a especificação.");
    const { spec, model, usedFallback } = await briefingToSpec(router, project.briefing, project.id, ctx.signal);
    ctx.assertActive();
    if (spec.service_type !== "landing_page") throw new PipelineSafetyError(`Template ainda não implementado: ${spec.service_type}. A Fase 1 aceita landing_page.`);
    const next = db.transaction(() => {
      if (!updateProject(project.id, { status: "planned", spec })) throw new Error("Projeto indisponível");
      return listTasks(project.id).find(t => t.payload.kind === "plan_tasks" && t.payload.parent_task_id === task.id) ??
        enqueueTask({ project_id: project.id, title: `Planejar ${spec.title}`, role: "tech_lead", depends_on: [task.id], payload: { kind: "plan_tasks", parent_task_id: task.id } });
    }).immediate();
    taskQueued(next);
    agentSay("product_owner", project.id, `Spec pronta: ${spec.title}. Atlas vai planejar as tarefas.`);
    emit({ type: "project.status", project_id: project.id, role: "product_owner", message: `Planejado via ${model}${usedFallback ? " (fallback)" : ""}`, data: { spec } });
    return { spec };
  },
  async plan_tasks(task, router, ctx) {
    const project = projectFor(task);
    if (!project.spec) throw new Error("Projeto não tem spec");
    agentSay("tech_lead", project.id, "Vou dividir a entrega em construção, QA e publicação opcional.");
    const plan = await planLanding(router, project.spec, project.id, ctx.signal);
    ctx.assertActive();
    const tasks = db.transaction(() => {
      const existing = listTasks(project.id).filter(t => t.payload.parent_task_id === task.id);
      if (existing.length) {
        if (existing.length !== 3) throw new PipelineSafetyError("Plano persistido incompleto; revisão necessária");
        return existing;
      }
      const ids = new Map<string, string>();
      return plan.tasks.map(item => {
        const role: Role = item.kind === "build_landing" ? "fullstack_dev" : item.kind === "qa_landing" ? "qa" : "tech_lead";
        const queued = enqueueTask({ project_id: project.id, title: item.title, role,
          depends_on: item.depends_on.length ? item.depends_on.map(key => ids.get(key)!) : [task.id],
          payload: { kind: item.kind, parent_task_id: task.id, plan_key: item.key }, max_attempts: item.kind === "build_landing" ? 2 : 1 });
        ids.set(item.key, queued.id);
        return queued;
      });
    }).immediate();
    for (const next of tasks) taskQueued(next);
    return { plan, task_ids: tasks.map(t => t.id) };
  },
  async build_landing(task, router, ctx) {
    const project = projectFor(task);
    if (!project.spec) throw new Error("Projeto não tem spec");
    ctx.assertActive();
    updateProject(project.id, { status: "building" });
    agentSay("fullstack_dev", project.id, "Vou criar o HTML e CSS da landing no workspace do projeto.");
    const content = await buildLanding(router, project.spec, project.id, ctx.signal);
    ctx.assertActive();
    return writeLanding(project.id, content);
  },
  async qa_landing(task, _router, ctx) {
    ctx.assertActive();
    updateProject(task.project_id, { status: "review" });
    agentSay("qa", task.project_id, "Vou executar o build e os testes do template confiável.");
    return qaLanding(task.project_id, ctx.signal);
  },
  async publish_landing(task, _router, ctx) {
    ctx.assertActive();
    let publish = ctx.publish;
    if (Object.hasOwn(task.payload, "publish")) {
      const input = task.payload.publish;
      if (!input || typeof input !== "object" || Array.isArray(input) || !("remote" in input) || typeof input.remote !== "string" ||
        ("branch" in input && input.branch !== undefined && typeof input.branch !== "string") || Object.keys(input).some(key => !["remote", "branch"].includes(key))) {
        throw new PipelineSafetyError("Destino de publicação persistido inválido");
      }
      publish = validatePublishOptions(input as PublishOptions, task.project_id);
    }
    agentSay("tech_lead", task.project_id, publish ? "Vou preparar o commit e publicar na branch autorizada." : "Vou preparar um commit local para revisão.");
    return publishLanding(task.project_id, publish, ctx.signal);
  },
};

/** Extension point for trusted application code, never for model-generated code. */
export function registerHandler(kind: string, handler: Handler): void { handlers[kind] = handler; }
let active: { task: Task; controller: AbortController; done: Promise<boolean> } | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let workerController: AbortController | null = null;
let removeWorkerAbort: (() => void) | null = null;

/** Cancels in-flight work; the caller owns aborted/quarantine DB state. */
export function cancelProjectWork(projectId: string): void {
  if (active?.task.project_id === projectId) active.controller.abort(new DOMException("Trabalho cancelado", "AbortError"));
}

/** One bounded queue turn. Calls are serialized, including direct/manual calls. */
export function runNextTask(router: PipelineRouter, options: WorkerOptions = {}): Promise<boolean> {
  if (active) return Promise.resolve(false);
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const task = claimNextTask();
  if (!task) return Promise.resolve(false);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const ctx: Context = { ...options, signal: controller.signal, assertActive() {
    controller.signal.throwIfAborted();
    const current = getProject(task.project_id);
    if (!current || ["aborted", "quarantine", "shipped"].includes(current.status)) throw new DOMException("Projeto encerrado", "AbortError");
    const row = db.prepare("SELECT status, attempts FROM tasks WHERE id = ?").get(task.id) as { status: string; attempts: number } | undefined;
    if (row?.status !== "running" || row.attempts !== task.attempts) throw new DOMException("Tentativa não está mais ativa", "AbortError");
  } };
  // Defer until active is assigned, so event callbacks can cancel safely.
  const done = Promise.resolve().then(async () => {
    const kind = task.payload.kind as string | undefined;
    try {
      ctx.assertActive();
      emit({ type: "task.started", project_id: task.project_id, role: task.role, message: `Começou: ${task.title}`, data: { task_id: task.id, attempt: task.attempts } });
      const handler = kind ? handlers[kind] : undefined;
      if (!handler) throw new PipelineSafetyError(`Handler não registrado para '${kind}'`);
      const result = await handler(task, router, ctx);
      ctx.assertActive();
      const completed = db.transaction(() => {
        if (!completeTask(task.id, result, task.attempts)) return false;
        if (kind === "publish_landing" && (result as { published?: boolean })?.published) {
          if (!updateProject(task.project_id, { status: "shipped", repo_url: (result as { remote: string }).remote })) throw new Error("Projeto mudou durante publicação");
        }
        return true;
      }).immediate();
      if (completed) {
        emit({ type: "task.done", project_id: task.project_id, role: task.role, message: `Concluiu: ${task.title}`, data: { task_id: task.id } });
        if (kind === "publish_landing") emit({ type: "project.status", project_id: task.project_id, role: task.role, message: (result as { published?: boolean }).published ? "Entrega publicada na branch de desenvolvimento." : "Entrega com commit local pronta para revisão; nenhum push solicitado.", data: result as Record<string, unknown> });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) quarantine(task, "Execução cancelada; inspecione os efeitos antes de retomar.");
      else if (error instanceof PipelineSafetyError) quarantine(task, message);
      else {
        const failed = failTask(task.id, message, task.attempts);
        if (failed?.status === "failed") quarantine(task, message);
      }
      emit({ type: "task.failed", project_id: task.project_id, role: task.role, message: `Falhou em ${task.title}: ${message}`, data: { task_id: task.id } });
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
      active = null;
    }
    return true;
  });
  active = { task, controller, done };
  return done;
}

export function startWorker(router: PipelineRouter, intervalMs = 1500, options: WorkerOptions = {}): void {
  if (running) return;
  if (active) throw new Error("Não é possível iniciar worker durante execução manual");
  if (!Number.isFinite(intervalMs) || intervalMs < 10 || intervalMs > 300_000) throw new Error("Intervalo do worker inválido");
  options.signal?.throwIfAborted();
  const recovered = recoverInterruptedTasks();
  if (recovered.taskIds.length) emit({ type: "system", project_id: null, role: null, message: `${recovered.taskIds.length} tarefa(s) interrompida(s) isolada(s) para revisão.` });
  running = true;
  workerController = new AbortController();
  const stopOnAbort = () => { void stopWorker(); };
  options.signal?.addEventListener("abort", stopOnAbort, { once: true });
  removeWorkerAbort = () => options.signal?.removeEventListener("abort", stopOnAbort);
  const loop = async () => {
    if (!running || !workerController) return;
    try { await runNextTask(router, { ...options, signal: workerController.signal }); }
    catch (error) { emit({ type: "system", project_id: null, role: null, message: `Erro no worker: ${String(error)}` }); }
    if (running) timer = setTimeout(() => { void loop(); }, intervalMs);
  };
  timer = setTimeout(() => { void loop(); }, 0);
  emit({ type: "system", project_id: null, role: null, message: "Worker serial da fila iniciado" });
}

export async function stopWorker(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  removeWorkerAbort?.();
  removeWorkerAbort = null;
  workerController?.abort(new DOMException("Worker encerrando", "AbortError"));
  workerController = null;
  const pending = active?.done;
  active?.controller.abort(new DOMException("Worker encerrando", "AbortError"));
  if (pending) await pending;
}

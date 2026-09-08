import { Task } from "@jpxforge/shared";
import { ModelRouter } from "./model-router.js";
import {
  claimNextTask,
  completeTask,
  failTask,
  getProject,
  updateProject,
} from "./db.js";
import { agentSay, emit } from "./events.js";
import { briefingToSpec } from "./agents/product-owner.js";

/**
 * Worker — loop que consome a fila SQLite.
 * Cada task tem um "kind" (em payload.kind) que despacha pro agente certo.
 * Fase 0 implementa 'ingest_briefing' (Nina). Fases seguintes adicionam
 * 'plan_tasks' (Atlas), 'build' (devs), 'review' (Vera/Sento).
 */

type Handler = (task: Task, router: ModelRouter) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async ingest_briefing(task, router) {
    const project = getProject(task.project_id);
    if (!project) throw new Error(`projeto ${task.project_id} não existe`);

    agentSay(
      "product_owner",
      project.id,
      "Recebi o briefing, deixa eu organizar isso em uma spec…"
    );

    const { spec, model, usedFallback } = await briefingToSpec(
      router,
      project.briefing,
      project.id
    );

    updateProject(project.id, { status: "planned", spec });
    agentSay(
      "product_owner",
      project.id,
      `Spec pronta: "${spec.title}" (${spec.service_type}), ${spec.sections.length} seções. Passando pro Atlas planejar.`
    );
    emit({
      type: "project.status",
      project_id: project.id,
      role: "product_owner",
      message: `Projeto virou 'planned' via ${model}${usedFallback ? " (fallback)" : ""}`,
      data: { spec },
    });

    return { spec };
  },
};

export function registerHandler(kind: string, fn: Handler): void {
  handlers[kind] = fn;
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(router: ModelRouter): Promise<void> {
  const task = claimNextTask();
  if (!task) return;

  const kind = (task.payload as { kind?: string }).kind;
  const handler = kind ? handlers[kind] : undefined;

  emit({
    type: "task.started",
    project_id: task.project_id,
    role: task.role,
    message: `[${task.role}] começou: ${task.title}`,
  });

  if (!handler) {
    failTask(task.id, `handler não registrado pra kind '${kind}'`);
    return;
  }

  try {
    const result = await handler(task, router);
    completeTask(task.id, result);
    emit({
      type: "task.done",
      project_id: task.project_id,
      role: task.role,
      message: `[${task.role}] concluiu: ${task.title}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const updated = failTask(task.id, msg);
    emit({
      type: "task.failed",
      project_id: task.project_id,
      role: task.role,
      message: `[${task.role}] falhou em "${task.title}": ${msg}${
        updated?.status === "queued" ? " — vai tentar de novo" : " — sem mais tentativas"
      }`,
    });
  }
}

export function startWorker(router: ModelRouter, intervalMs = 1500): void {
  if (running) return;
  running = true;
  timer = setInterval(() => {
    tick(router).catch((err) =>
      emit({ type: "system", project_id: null, role: null, message: `erro no worker: ${String(err)}` })
    );
  }, intervalMs);
  emit({ type: "system", project_id: null, role: null, message: "worker da fila iniciado" });
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

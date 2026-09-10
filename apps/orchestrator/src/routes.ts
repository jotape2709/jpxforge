import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BriefingInputSchema, type ForgeConfig } from "@jpxforge/shared";
import { abortProjectTasks, createProject, db, enqueueTask, getProject, listProjects, listTasks, tokensByProject, updateProject } from "./db.js";
import { emit, history } from "./events.js";
import { cancelProjectWork } from "./queue.js";
import { validatePublishOptions } from "./pipeline/workspace.js";

const PublishInputSchema = z.object({ remote: z.string(), branch: z.string().optional() }).strict();

export function registerRoutes(app: FastifyInstance, config: ForgeConfig, options: { demo?: boolean } = {}): void {
  app.get("/health", async () => ({
    ok: true, service: "jpxforge", mode: options.demo ? "demo" : "live",
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, value]) => [name, { configured: !!value?.enabled && (name === "ollama" || !!value?.api_key) }])),
    ts: new Date().toISOString(),
  }));
  app.post("/briefings", async (req, reply) => {
    const parsed = BriefingInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const project = db.transaction(() => {
      const project = createProject(parsed.data);
      enqueueTask({ project_id: project.id, title: "Transformar briefing em spec", role: "product_owner", payload: { kind: "ingest_briefing" } });
      return project;
    })();
    emit({ type: "project.created", project_id: project.id, role: null, message: `Briefing recebido -> projeto ${project.id}` });
    return reply.code(201).send({ project_id: project.id });
  });
  app.get("/briefings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
    return { project, tasks: listTasks(id), tokens: tokensByProject(id) };
  });
  app.get("/projects", async () => ({ projects: listProjects() }));
  app.post("/projects/:id/publish", async (req, reply) => {
    if (options.demo) return reply.code(409).send({ error: "Publicação indisponível no modo demonstração" });
    const { id } = req.params as { id: string };
    const parsed = PublishInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Informe remote e, opcionalmente, branch como texto" });
    let publish: { remote: string; branch: string };
    try { publish = validatePublishOptions(parsed.data, id); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Destino inválido" }); }
    const result = db.transaction(() => {
      const project = getProject(id);
      if (!project) return { error: "Projeto não encontrado", status: 404 } as const;
      const tasks = listTasks(id);
      const localDelivery = tasks.some(task => task.payload.kind === "publish_landing" && task.status === "done" &&
        typeof task.result === "object" && task.result !== null && "published" in task.result && task.result.published === false);
      if (project.status !== "review" || !localDelivery || tasks.some(task => ["queued", "running", "failed", "blocked"].includes(task.status))) {
        return { error: "Publicação exige entrega local revisável e nenhuma tarefa pendente ou com falha", status: 409 } as const;
      }
      return { task: enqueueTask({ project_id: id, title: "Publicar entrega na branch autorizada", role: "tech_lead", max_attempts: 1,
        payload: { kind: "publish_landing", publish } }) };
    }).immediate();
    if (result.status !== undefined) return reply.code(result.status).send({ error: result.error });
    emit({ type: "task.queued", project_id: id, role: "tech_lead", message: "Publicação solicitada para a branch autorizada", data: { task_id: result.task.id } });
    return reply.code(202).send({ project_id: id, task_id: result.task.id });
  });
  app.post("/projects/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: "Projeto não encontrado" });
    if (["shipped", "quarantine", "aborted"].includes(project.status)) return reply.code(409).send({ error: "Projeto já encerrado; nenhuma ação alterada" });
    updateProject(id, { status: "aborted" });
    cancelProjectWork(id);
    const cancelled = abortProjectTasks(id);
    emit({ type: "project.status", project_id: id, role: null, message: `Projeto abortado (${cancelled} tarefas canceladas)` });
    return { ok: true, cancelled };
  });
  app.get("/events", async (req, reply) => {
    const { limit } = req.query as { limit?: string };
    const count = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 500) return reply.code(400).send({ error: "limit deve ser um inteiro entre 1 e 500" });
    return { events: history(count) };
  });
}

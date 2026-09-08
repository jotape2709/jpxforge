import { FastifyInstance } from "fastify";
import { BriefingInputSchema } from "@jpxforge/shared";
import {
  abortProjectTasks,
  createProject,
  enqueueTask,
  getProject,
  listProjects,
  listTasks,
  tokensByProject,
  updateProject,
} from "./db.js";
import { emit, history } from "./events.js";
import { ForgeConfig } from "@jpxforge/shared";
import OpenAI from "openai";

/**
 * API local do jpxforge — porta de entrada de testes/manuais
 * e fonte de dados do dashboard. (Briefings de produção chegam
 * via claim ao WORK — ver work-poller.ts.)
 */

async function checkDeepSeek(config: ForgeConfig): Promise<boolean> {
  const ds = config.providers.deepseek;
  if (!ds?.api_key) return false;
  try {
    const client = new OpenAI({
      baseURL: ds.base_url ?? "https://api.deepseek.com",
      apiKey: ds.api_key,
      timeout: 8000,
    });
    await client.models.list();
    return true;
  } catch {
    return false;
  }
}

async function checkOllama(config: ForgeConfig): Promise<boolean> {
  const base = config.providers.ollama?.base_url ?? "http://localhost:11434/v1";
  const tagsUrl = base.replace(/\/v1\/?$/, "") + "/api/tags";
  try {
    const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function registerRoutes(app: FastifyInstance, config: ForgeConfig): void {
  // ── Saúde do sistema ──
  app.get("/health", async () => {
    const [deepseek, ollama] = await Promise.all([
      checkDeepSeek(config),
      checkOllama(config),
    ]);
    return {
      ok: deepseek,
      providers: { deepseek, ollama },
      ts: new Date().toISOString(),
    };
  });

  // ── Entrada manual de briefings (testes) ──
  app.post("/briefings", async (req, reply) => {
    const parsed = BriefingInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const project = createProject(parsed.data);
    enqueueTask({
      project_id: project.id,
      title: "Transformar briefing em spec",
      role: "product_owner",
      payload: { kind: "ingest_briefing" },
    });
    emit({
      type: "project.created",
      project_id: project.id,
      role: null,
      message: `Briefing recebido (${parsed.data.source}) → projeto ${project.id}`,
    });
    return reply.status(201).send({ project_id: project.id });
  });

  app.get("/briefings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.status(404).send({ error: "projeto não encontrado" });
    return {
      project,
      tasks: listTasks(id),
      tokens: tokensByProject(id),
    };
  });

  // ── Projetos ──
  app.get("/projects", async () => ({ projects: listProjects() }));

  app.post("/projects/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProject(id);
    if (!project) return reply.status(404).send({ error: "projeto não encontrado" });
    const cancelled = abortProjectTasks(id);
    updateProject(id, { status: "aborted" });
    emit({
      type: "project.status",
      project_id: id,
      role: null,
      message: `Projeto abortado (${cancelled} tasks canceladas)`,
    });
    return { ok: true, cancelled };
  });

  // ── Eventos (histórico pro replay / chat) ──
  app.get("/events", async (req) => {
    const { limit } = req.query as { limit?: string };
    return { events: history(limit ? Number(limit) : 50) };
  });
}

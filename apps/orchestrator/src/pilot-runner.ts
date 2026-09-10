import { performance } from "node:perf_hooks";
import { existsSync, readFileSync } from "node:fs";
import { db, createProject, enqueueTask, getProject, listTasks } from "./db.js";
import { runNextTask } from "./queue.js";
import { dataPath } from "./paths.js";
import { PipelineSafetyError, type PipelineRouter } from "./pipeline/contracts.js";
import { ModelOutputError, type ModelUsage } from "./model-router.js";
import type { Role } from "@jpxforge/shared";
import type { PilotOptions, PilotPricing } from "./pilot-options.js";

export const PILOT_BRIEFING = "Crie uma landing page estática de demonstração, em português brasileiro, para o Estúdio Aurora, um estúdio de design fictício. Apresente identidade visual, experiência digital e conteúdo. Use tons verde escuro e verde claro, seções de apresentação, serviços e contato, navegação por âncoras e CTA para #contato. Informe que é uma demonstração. Não invente preços, números, depoimentos ou contatos. Sem formulário, imagens, JavaScript ou dependências externas.";

interface PilotCall {
  sequence: number;
  role: Role;
  status: "running" | "success" | "failed" | "cancelled";
  duration_ms: number;
  usage: ModelUsage | null;
  failure: "refused" | "truncated" | "filtered" | "empty" | "timeout" | "cancelled" | "provider_error" | null;
  http_status: number | null;
}
export interface PilotReport {
  version: 1;
  mode: "offline" | "live";
  status: "running" | "passed" | "failed" | "cancelled";
  model: string;
  started_at: string;
  duration_ms: number;
  project_id: string;
  project_status: string;
  limits: { max_calls: number; timeout_ms: number; max_output_tokens_per_call: number; automatic_retries: 0 };
  calls: PilotCall[];
  tasks: { kind: string; status: string; attempts: number }[];
  tokens: { prompt: number; completion: number; unreported_calls: number };
  cost: { currency: "USD"; estimated_usd: number | null; recorded_usage_estimate_usd: number | null;
    method: "offline_free" | "unpriced" | "reported_cache" | "uncached_upper_estimate";
    pricing: PilotPricing | null };
  qa_passed: boolean;
  local_commit: string | null;
  workspace: string | null;
  published: false;
  live_provider_validated: boolean;
  human_review: "pending";
  stop_reason: "completed" | "call_limit" | "model_error" | "pipeline_error" | "usage_missing" | "cancelled" | null;
}

function costs(mode: PilotOptions["mode"], calls: PilotCall[], pricing?: PilotPricing): PilotReport["cost"] {
  if (mode === "offline") return { currency: "USD", estimated_usd: 0, recorded_usage_estimate_usd: 0, method: "offline_free", pricing: null };
  if (!pricing) return { currency: "USD", estimated_usd: null, recorded_usage_estimate_usd: null, method: "unpriced", pricing: null };
  let sum = 0, upperEstimate = false;
  for (const call of calls) {
    if (!call.usage) continue;
    const u = call.usage;
    const hasCache = u.prompt_cache_hit_tokens !== undefined && u.prompt_cache_miss_tokens !== undefined && pricing.cached_input_usd_per_million !== undefined;
    upperEstimate ||= !hasCache;
    const input = hasCache
      ? u.prompt_cache_hit_tokens! * pricing.cached_input_usd_per_million! + u.prompt_cache_miss_tokens! * pricing.input_usd_per_million
      : u.prompt_tokens * pricing.input_usd_per_million;
    sum += (input + u.completion_tokens * pricing.output_usd_per_million) / 1_000_000;
  }
  sum = Math.round(sum * 1e9) / 1e9;
  return { currency: "USD", estimated_usd: calls.some(c => !c.usage || c.status === "running") ? null : sum,
    recorded_usage_estimate_usd: sum, method: upperEstimate ? "uncached_upper_estimate" : "reported_cache", pricing };
}

/** Caller must select a fresh, isolated database before importing this module. */
export async function runPilot(options: PilotOptions, router: PipelineRouter, settings: {
  signal?: AbortSignal;
  pricing?: PilotPricing;
  checkpoint?: (report: PilotReport) => void;
} = {}): Promise<PilotReport> {
  // Refuse to drain a user's queue or resume an old paid attempt.
  const count = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
  if (count.count) throw new Error("O piloto exige um banco vazio e exclusivo.");
  if (settings.pricing && settings.pricing.model !== options.model) throw new Error("Tarifa não corresponde ao modelo do piloto.");
  const started = performance.now();
  const project = db.transaction(() => {
    const p = createProject({ source: "manual", raw_text: PILOT_BRIEFING });
    enqueueTask({ project_id: p.id, title: "Validar briefing sintético", role: "product_owner",
      payload: { kind: "ingest_briefing" }, max_attempts: 1 });
    return p;
  }).immediate();
  const report: PilotReport = {
    version: 1, mode: options.mode, status: "running", model: options.model,
    started_at: new Date().toISOString(), duration_ms: 0, project_id: project.id, project_status: project.status,
    limits: { max_calls: options.maxCalls, timeout_ms: options.timeoutMs, max_output_tokens_per_call: 8000, automatic_retries: 0 },
    calls: [], tasks: [], tokens: { prompt: 0, completion: 0, unreported_calls: 0 },
    cost: costs(options.mode, [], settings.pricing), qa_passed: false, local_commit: null,
    workspace: null, published: false, live_provider_validated: false, human_review: "pending", stop_reason: null,
  };
  const checkpoint = () => {
    report.duration_ms = Math.round(performance.now() - started);
    report.project_status = getProject(project.id)!.status;
    report.tasks = listTasks(project.id).map(t => ({ kind: String(t.payload.kind), status: t.status, attempts: t.attempts }));
    report.tokens = { prompt: 0, completion: 0, unreported_calls: 0 };
    for (const call of report.calls) {
      if (call.usage) { report.tokens.prompt += call.usage.prompt_tokens; report.tokens.completion += call.usage.completion_tokens; }
      else if (options.mode === "live") report.tokens.unreported_calls++;
    }
    report.cost = costs(options.mode, report.calls, settings.pricing);
    settings.checkpoint?.(report);
  };
  const boundedRouter: PipelineRouter = { async chat(role, messages, opts = {}) {
    opts.signal?.throwIfAborted();
    if (report.calls.length >= options.maxCalls) {
      report.stop_reason = "call_limit";
      throw new PipelineSafetyError("Limite de chamadas do piloto atingido; nenhuma nova chamada enviada.");
    }
    const call: PilotCall = { sequence: report.calls.length + 1, role, status: "running", duration_ms: 0,
      usage: null, failure: null, http_status: null };
    report.calls.push(call);
    checkpoint(); // Persist the attempt before network access; a crash remains visibly incomplete.
    const callStarted = performance.now();
    try {
      const result = await router.chat(role, messages, { ...opts, maxTokens: Math.min(opts.maxTokens ?? 4096, 8000),
        timeoutMs: options.timeoutMs, onUsage: usage => { call.usage = usage; checkpoint(); } });
      if (options.mode === "offline") call.usage = result.usage;
      call.status = "success";
      return result;
    } catch (error) {
      call.status = opts.signal?.aborted ? "cancelled" : "failed";
      call.failure = opts.signal?.aborted ? "cancelled" : error instanceof ModelOutputError ? error.code
        : error instanceof Error && error.name === "APIConnectionTimeoutError" ? "timeout" : "provider_error";
      if (error && typeof error === "object" && "status" in error && typeof error.status === "number" &&
          Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) call.http_status = error.status;
      report.stop_reason = opts.signal?.aborted ? "cancelled" : "model_error";
      // Provider errors may echo credentials or request text; never persist their raw message.
      throw new PipelineSafetyError(opts.signal?.aborted ? "Piloto cancelado." : "Modelo indisponível ou resposta inválida. Revise chave, saldo, modelo e conexão antes de uma nova execução.");
    } finally {
      call.duration_ms = Math.round(performance.now() - callStarted);
      checkpoint();
    }
  } };
  checkpoint();
  try {
    for (let tick = 0; tick < 6; tick++) {
      settings.signal?.throwIfAborted();
      // The production queue keeps its retry policy; this synthetic run has one attempt per task.
      db.prepare("UPDATE tasks SET max_attempts = 1 WHERE project_id = ?").run(project.id);
      if (!await runNextTask(boundedRouter, { signal: settings.signal })) break;
      checkpoint();
    }
    const tasks = listTasks(project.id);
    const delivery = tasks.find(t => t.payload.kind === "publish_landing")?.result as { commit?: string; published?: boolean } | undefined;
    const qaPath = dataPath("workspaces", project.id, "qa-report.json");
    report.qa_passed = tasks.some(t => t.payload.kind === "qa_landing" && t.status === "done") &&
      existsSync(qaPath) && JSON.parse(readFileSync(qaPath, "utf8")).passed === true;
    report.local_commit = delivery?.commit && /^[a-f0-9]{40}$/.test(delivery.commit) ? delivery.commit : null;
    report.workspace = report.qa_passed ? dataPath("workspaces", project.id) : null;
    const passed = getProject(project.id)?.status === "review" && tasks.length === 5 &&
      tasks.every(t => t.status === "done") && report.qa_passed && !!report.local_commit && delivery?.published === false;
    report.status = settings.signal?.aborted ? "cancelled" : passed ? "passed" : "failed";
    report.stop_reason = report.status === "cancelled" ? "cancelled" : passed ? "completed" : report.stop_reason ?? "pipeline_error";
    report.live_provider_validated = options.mode === "live" && passed && report.calls.length === 3 && report.calls.every(c => c.usage !== null);
    if (passed && options.mode === "live" && !report.live_provider_validated) {
      report.status = "failed";
      report.stop_reason = "usage_missing";
    }
  } catch {
    report.status = settings.signal?.aborted ? "cancelled" : "failed";
    report.stop_reason = settings.signal?.aborted ? "cancelled" : "pipeline_error";
  } finally {
    if (report.status !== "passed") db.transaction(() => {
      db.prepare("UPDATE projects SET status = 'quarantine', updated_at = ? WHERE id = ?").run(new Date().toISOString(), project.id);
      db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE project_id = ? AND status IN ('queued', 'running')")
        .run(new Date().toISOString(), project.id);
    }).immediate();
    checkpoint();
  }
  return report;
}

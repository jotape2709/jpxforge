import OpenAI from "openai";
import { ForgeConfig, ModelTarget, Role } from "@jpxforge/shared";
import { recordTokens } from "./db.js";
import { PipelineSafetyError } from "./pipeline/contracts.js";

/**
 * ModelRouter — coração de custo/flexibilidade do jpxforge.
 *
 * Cada papel (role) aponta para um provider+modelo primário e um fallback.
 * Todos os providers falam o protocolo OpenAI-compatível:
 *   - DeepSeek:   https://api.deepseek.com
 *   - OpenRouter: https://openrouter.ai/api/v1
 *   - Ollama:     http://localhost:11434/v1
 *
 * Trocar de modelo NUNCA é mexer em código: é editar config
 * (pelo setup wizard hoje, pela tela de Settings na Fase 2).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  projectId?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  // Trusted observer: receives counters only, including unusable responses.
  onUsage?: (usage: ModelUsage | null) => void;
}

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export class ModelOutputError extends Error {
  constructor(public code: "refused" | "truncated" | "filtered" | "empty" | "invalid_response", message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/** Local evidence failure is terminal: another provider cannot repair storage. */
export class ModelEvidenceError extends PipelineSafetyError {
  override name = "ModelEvidenceError";
  constructor() { super("Não foi possível registrar o uso do modelo; inspecione o armazenamento antes de retomar."); }
}

class ModelProviderError extends Error {
  constructor(timeout: boolean, public status?: number) {
    super(timeout ? "O provedor excedeu o tempo limite da chamada." : "Falha na API do modelo; confira conexão, modelo, chave e saldo.");
    this.name = timeout ? "APIConnectionTimeoutError" : "ModelProviderError";
  }
}

/** Missing or invalid usage is unknown, never evidence of a free request. */
export function readModelUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!count(raw.prompt_tokens) || !count(raw.completion_tokens)) return null;
  const usage: ModelUsage = { prompt_tokens: raw.prompt_tokens, completion_tokens: raw.completion_tokens };
  if (count(raw.prompt_cache_hit_tokens) && count(raw.prompt_cache_miss_tokens) &&
      raw.prompt_cache_hit_tokens + raw.prompt_cache_miss_tokens === raw.prompt_tokens) {
    usage.prompt_cache_hit_tokens = raw.prompt_cache_hit_tokens;
    usage.prompt_cache_miss_tokens = raw.prompt_cache_miss_tokens;
  }
  return usage;
}

export interface ChatResult {
  content: string;
  provider: string;
  model: string;
  usedFallback: boolean;
  usage: { prompt_tokens: number; completion_tokens: number };
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

export class ModelRouter {
  constructor(private config: ForgeConfig) {}

  private clientFor(target: ModelTarget): OpenAI {
    const providerCfg = this.config.providers[target.provider];
    if (!providerCfg || !providerCfg.enabled) {
      throw new Error(`Provider ausente ou desabilitado: ${target.provider}`);
    }
    if (!target.model.trim()) throw new Error("Modelo não configurado");
    const baseURL =
      providerCfg.base_url || PROVIDER_DEFAULTS[target.provider];
    const url = new URL(baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`URL inválida do provider ${target.provider}`);
    }
    // Ollama não exige key; SDK exige algum valor.
    const apiKey = providerCfg.api_key?.trim() || (target.provider === "ollama" ? "ollama-local" : "");
    if (!apiKey) throw new Error(`API key não configurada para ${target.provider}`);
    // Retries belong to the durable queue, so one target means one billed attempt.
    return new OpenAI({ baseURL, apiKey, timeout: 60_000, maxRetries: 0 });
  }

  async chat(
    role: Role,
    messages: ChatMessage[],
    opts: ChatOptions = {}
  ): Promise<ChatResult> {
    opts.signal?.throwIfAborted();
    if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > 300_000)) {
      throw new Error("timeoutMs deve ser maior que zero e no máximo 300000");
    }
    const route = this.config.roles[role];
    if (!route) throw new Error(`Role sem rota configurada: ${role}`);

    const targets = [route.primary, ...(route.fallback ? [route.fallback] : [])];
    let lastError: unknown = null;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        opts.signal?.throwIfAborted();
        const result = await this.callTarget(role, target, messages, opts, i > 0);
        return result;
      } catch (err) {
        if (err instanceof ModelEvidenceError) throw err;
        // User cancellation stops the entire route, including any paid fallback.
        opts.signal?.throwIfAborted();
        if (err instanceof Error && ["AbortError", "APIUserAbortError"].includes(err.name)) throw err;
        // SDK messages, headers and causes can echo request data or credentials.
        lastError = err instanceof OpenAI.APIError
          ? new ModelProviderError(err instanceof OpenAI.APIConnectionTimeoutError, err.status)
          : err;
        // Fallback só faz sentido se existir próximo alvo
        if (i < targets.length - 1) continue;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Falha em todos os modelos do role ${role}`);
  }

  private async callTarget(
    role: Role,
    target: ModelTarget,
    messages: ChatMessage[],
    opts: ChatOptions,
    usedFallback: boolean
  ): Promise<ChatResult> {
    const client = this.clientFor(target);
    const res = await client.chat.completions.create(
      {
        model: target.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 4096,
        ...(target.provider === "deepseek" && target.thinking
          ? { thinking: { type: target.thinking } } : {}),
        ...(opts.jsonMode
          ? { response_format: { type: "json_object" as const } }
          : {}),
      },
      { signal: opts.signal, timeout: opts.timeoutMs ?? 60_000, maxRetries: 0 }
    );

    const reportedUsage = readModelUsage(res?.usage);
    const usage = reportedUsage ?? { prompt_tokens: 0, completion_tokens: 0 };
    // Observe both stores even if one fails, before inspecting untrusted content.
    let evidenceFailed = false;
    try { opts.onUsage?.(reportedUsage); } catch { evidenceFailed = true; }
    try { recordTokens(
      opts.projectId ?? null,
      role,
      target.provider,
      target.model,
      usage.prompt_tokens,
      usage.completion_tokens
    ); } catch { evidenceFailed = true; }
    if (evidenceFailed) throw new ModelEvidenceError();

    // Usage remains accounted even when an incomplete/refused response is unusable.
    opts.signal?.throwIfAborted();
    const choice = Array.isArray(res?.choices) ? res.choices[0] : undefined;
    if (!choice || typeof choice.message !== "object" || !choice.message) {
      throw new ModelOutputError("invalid_response", "Resposta do provedor fora do protocolo esperado.");
    }
    if (choice?.message?.refusal) throw new ModelOutputError("refused", `Modelo ${target.model} recusou a resposta`);
    if (choice?.finish_reason === "length") throw new ModelOutputError("truncated", `Resposta truncada do modelo ${target.model}`);
    if (choice?.finish_reason === "content_filter") throw new ModelOutputError("filtered", `Resposta filtrada do modelo ${target.model}`);
    const content = choice.message.content ?? "";
    if (typeof content !== "string" || choice.finish_reason !== "stop") {
      throw new ModelOutputError("invalid_response", "Resposta do provedor fora do protocolo esperado.");
    }
    if (!content.trim()) throw new ModelOutputError("empty", `Resposta vazia do modelo ${target.model}`);

    return {
      content,
      provider: target.provider,
      model: target.model,
      usedFallback,
      usage,
    };
  }
}

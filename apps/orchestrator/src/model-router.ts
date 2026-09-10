import OpenAI from "openai";
import { ForgeConfig, ModelTarget, Role } from "@jpxforge/shared";
import { recordTokens } from "./db.js";

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
        // User cancellation stops the entire route, including any paid fallback.
        opts.signal?.throwIfAborted();
        if (err instanceof Error && ["AbortError", "APIUserAbortError"].includes(err.name)) throw err;
        lastError = err;
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
        ...(opts.jsonMode
          ? { response_format: { type: "json_object" as const } }
          : {}),
      },
      { signal: opts.signal, timeout: opts.timeoutMs ?? 60_000, maxRetries: 0 }
    );

    const content = res.choices[0]?.message?.content ?? "";
    const usage = {
      prompt_tokens: res.usage?.prompt_tokens ?? 0,
      completion_tokens: res.usage?.completion_tokens ?? 0,
    };

    recordTokens(
      opts.projectId ?? null,
      role,
      target.provider,
      target.model,
      usage.prompt_tokens,
      usage.completion_tokens
    );

    // Usage remains accounted even when an incomplete/refused response is unusable.
    opts.signal?.throwIfAborted();
    const choice = res.choices[0];
    if (choice?.message?.refusal) throw new Error(`Modelo ${target.model} recusou a resposta`);
    if (choice?.finish_reason === "length") throw new Error(`Resposta truncada do modelo ${target.model}`);
    if (choice?.finish_reason === "content_filter") throw new Error(`Resposta filtrada do modelo ${target.model}`);
    if (!content.trim()) throw new Error(`Resposta vazia do modelo ${target.model}`);

    return {
      content,
      provider: target.provider,
      model: target.model,
      usedFallback,
      usage,
    };
  }
}

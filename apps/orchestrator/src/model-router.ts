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
    const baseURL =
      providerCfg?.base_url ?? PROVIDER_DEFAULTS[target.provider];
    // Ollama não exige key; SDK exige algum valor.
    const apiKey = providerCfg?.api_key ?? "ollama-local";
    return new OpenAI({ baseURL, apiKey });
  }

  async chat(
    role: Role,
    messages: ChatMessage[],
    opts: ChatOptions = {}
  ): Promise<ChatResult> {
    const route = this.config.roles[role];
    if (!route) throw new Error(`Role sem rota configurada: ${role}`);

    const targets = [route.primary, ...(route.fallback ? [route.fallback] : [])];
    let lastError: unknown = null;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        const result = await this.callTarget(role, target, messages, opts, i > 0);
        return result;
      } catch (err) {
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
    const res = await client.chat.completions.create({
      model: target.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.jsonMode
        ? { response_format: { type: "json_object" as const } }
        : {}),
    });

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

    return {
      content,
      provider: target.provider,
      model: target.model,
      usedFallback,
      usage,
    };
  }
}

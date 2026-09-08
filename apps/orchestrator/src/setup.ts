import prompts from "prompts";
import OpenAI from "openai";
import {
  DEFAULT_ROLE_ROUTES,
  ForgeConfig,
} from "@jpxforge/shared";
import { configExists, saveConfig } from "./config.js";

/**
 * SETUP WIZARD — configura o jpxforge sem abrir nenhum código.
 * Pergunta as API keys, valida na hora e grava jpxforge.config.json
 * (arquivo gitignored, permissão 600).
 */

async function validateDeepSeek(apiKey: string): Promise<boolean> {
  try {
    const client = new OpenAI({
      baseURL: "https://api.deepseek.com",
      apiKey,
      timeout: 10000,
    });
    await client.models.list();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("");
  console.log("  ▓▓▓ JPXFORGE — Setup ▓▓▓");
  console.log("  Suas keys ficam salvas localmente e nunca sobem pro GitHub.");
  console.log("");

  if (configExists()) {
    const { overwrite } = await prompts({
      type: "confirm",
      name: "overwrite",
      message: "Já existe uma configuração. Sobrescrever?",
      initial: false,
    });
    if (!overwrite) {
      console.log("Ok, mantendo a config atual.");
      return;
    }
  }

  // ── DeepSeek (obrigatório — cérebro da fábrica) ──
  let deepseekKey = "";
  for (;;) {
    const res = await prompts({
      type: "password",
      name: "key",
      message: "Cole sua API key do DeepSeek (platform.deepseek.com):",
    });
    if (!res.key) {
      console.log("Setup cancelado.");
      process.exit(0);
    }
    process.stdout.write("  Validando… ");
    const ok = await validateDeepSeek(res.key.trim());
    if (ok) {
      console.log("válida ✓");
      deepseekKey = res.key.trim();
      break;
    }
    console.log("inválida ✗  (confere e tenta de novo, ou Ctrl+C pra sair)");
  }

  // ── OpenRouter (opcional — fallback multi-modelo) ──
  const { wantOpenRouter } = await prompts({
    type: "confirm",
    name: "wantOpenRouter",
    message: "Quer adicionar uma key do OpenRouter agora? (opcional, dá pra fazer depois)",
    initial: false,
  });
  let openrouterKey: string | undefined;
  if (wantOpenRouter) {
    const res = await prompts({
      type: "password",
      name: "key",
      message: "Cole sua API key do OpenRouter:",
    });
    openrouterKey = res.key?.trim() || undefined;
  }

  // ── Ollama (opcional — modelos locais grátis) ──
  const { ollamaUrl } = await prompts({
    type: "text",
    name: "ollamaUrl",
    message: "URL do Ollama local (Enter pra manter o padrão):",
    initial: "http://localhost:11434/v1",
  });

  // ── GitHub (opcional nesta fase — usado na Fase 1 pro push) ──
  const { githubToken } = await prompts({
    type: "password",
    name: "githubToken",
    message: "Token do GitHub (opcional, Enter pra pular — necessário só na fase de push automático):",
  });

  // ── WORK (integração com a ferramenta de prospecção — contrato v1) ──
  console.log("");
  console.log("  Integração WORK (a ferramenta que administra os handoffs):");
  const { workUrl } = await prompts({
    type: "text",
    name: "workUrl",
    message: "URL da API do WORK (Enter pro padrão):",
    initial: "http://127.0.0.1:4310",
  });

  let workToken: string | undefined;
  for (;;) {
    const res = await prompts({
      type: "password",
      name: "key",
      message:
        "Token do Time de Desenvolvimento (WORK → Configurações → Conexões; Enter pra pular):",
    });
    if (!res.key) break; // opcional — integração fica desligada
    const key = res.key.trim();
    if (key.length < 32) {
      console.log("  ✗ O contrato exige token com pelo menos 32 caracteres. Tenta de novo.");
      continue;
    }
    // Valida contra /integrations/dev-team/status se o WORK estiver no ar
    process.stdout.write("  Validando contra o WORK… ");
    try {
      const res2 = await fetch(
        `${(workUrl || "http://127.0.0.1:4310").replace(/\/+$/, "")}/integrations/dev-team/status`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (res2.ok) {
        const st = (await res2.json()) as { ready?: number; paused?: boolean };
        console.log(`válido ✓  (fila: ${st.ready ?? "?"} prontos, pausado: ${st.paused ?? "?"})`);
        workToken = key;
        break;
      }
      console.log(`rejeitado ✗ (HTTP ${res2.status}) — confere o token ou tenta de novo`);
    } catch {
      console.log("WORK offline agora — salvando sem validar (o doctor confere depois)");
      workToken = key;
      break;
    }
  }

  const { workerId } = await prompts({
    type: "text",
    name: "workerId",
    message: "ID deste worker (estável, único por slot; Enter pro padrão):",
    initial: "jpxforge-slot-1",
  });

  const config: ForgeConfig = {
    version: 1,
    server: { port: 4100, host: "127.0.0.1" },
    providers: {
      deepseek: {
        api_key: deepseekKey,
        base_url: "https://api.deepseek.com",
        enabled: true,
      },
      ...(openrouterKey
        ? {
            openrouter: {
              api_key: openrouterKey,
              base_url: "https://openrouter.ai/api/v1",
              enabled: true,
            },
          }
        : {}),
      ollama: {
        base_url: ollamaUrl || "http://localhost:11434/v1",
        enabled: true,
      },
    },
    roles: DEFAULT_ROLE_ROUTES,
    github: {
      token: githubToken?.trim() || undefined,
      owner: "jotape2709",
      auto_create_repo: true,
    },
    work: {
      base_url: workUrl || "http://127.0.0.1:4310",
      token: workToken,
      worker_id: workerId || "jpxforge-slot-1",
      poll_interval_ms: 15000,
      auto_claim: false, // liga na Fase 1, quando a pipeline de build existir
    },
  };

  saveConfig(config);

  console.log("");
  console.log("  ✓ Config salva (jpxforge.config.json — gitignored)");
  console.log("");
  console.log("  Próximos passos:");
  console.log("    npm run doctor   → verifica se tudo está conectado");
  console.log("    npm run dev      → sobe a fábrica");
  console.log("");
}

main().catch((err) => {
  console.error("Erro no setup:", err.message ?? err);
  process.exit(1);
});

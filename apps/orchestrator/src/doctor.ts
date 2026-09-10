import { loadConfig } from "./config.js";
import OpenAI from "openai";

/**
 * DOCTOR — diagnóstico rápido: config, providers, WORK, rotas por papel.
 */

async function main() {
  console.log("");
  console.log("  ▓▓▓ JPXFORGE — Doctor ▓▓▓");
  console.log("");

  const config = loadConfig();
  let allOk = true;

  // DeepSeek
  const ds = config.providers.deepseek;
  if (ds?.api_key) {
    try {
      const client = new OpenAI({ baseURL: ds.base_url, apiKey: ds.api_key, timeout: 8000, maxRetries: 0 });
      const models = await client.models.list();
      console.log(`  ✓ DeepSeek conectado (${models.data.length} modelos disponíveis)`);
    } catch {
      allOk = false;
      console.log("  ✗ DeepSeek indisponível; confira a chave, a rede e o saldo da API.");
    }
  } else {
    allOk = false;
    console.log("  ✗ DeepSeek sem key — rode npm run setup");
  }

  // OpenRouter
  const or_ = config.providers.openrouter;
  console.log(or_?.api_key ? "  ✓ OpenRouter configurado" : "  – OpenRouter não configurado (opcional)");

  // Ollama
  const base = config.providers.ollama?.base_url ?? "http://localhost:11434/v1";
  try {
    const res = await fetch(base.replace(/\/v1\/?$/, "") + "/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      console.log(`  ✓ Ollama rodando (${names.length ? names.join(", ") : "nenhum modelo baixado ainda"})`);
      if (names.length === 0) {
        console.log("    Sugestão: ollama pull qwen2.5-coder:3b && ollama pull llama3.2:1b");
      }
    } else {
      console.log("  ✗ Ollama respondeu com erro");
    }
  } catch {
    console.log("  – Ollama offline (opcional por enquanto; obrigatório pra QA/Segurança nas fases 3+)");
  }

  // WORK (integração com a ferramenta de prospecção)
  const work = config.work;
  if (work?.token) {
    try {
      const res = await fetch(
        `${work.base_url.replace(/\/+$/, "")}/integrations/dev-team/status`,
        {
          headers: { Authorization: `Bearer ${work.token}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (res.ok) {
        const st = (await res.json()) as {
          service?: string;
          protocolVersion?: string | number;
          paused?: boolean;
          ready?: number;
        };
        console.log(
          `  ✓ WORK conectado — ${st.service ?? "?"} v${st.protocolVersion ?? "?"} | fila: ${st.ready ?? 0} prontos | pausado: ${st.paused ?? false} | workerId: ${work.worker_id}`
        );
        console.log(`    auto_claim: ${work.auto_claim ? "LIGADO" : "desligado (Fase 0 — liga na Fase 1)"}`);
      } else {
        allOk = false;
        console.log(`  ✗ WORK respondeu HTTP ${res.status} — token inválido/revogado? Rode npm run setup`);
      }
    } catch {
      console.log("  – WORK offline (a integração ativa quando ele estiver no ar)");
    }
  } else {
    console.log("  – WORK sem token (integração desligada; configure com npm run setup)");
  }

  // Rotas por papel
  console.log("");
  console.log("  Roteamento de modelos:");
  for (const [role, route] of Object.entries(config.roles)) {
    const fb = route.fallback ? `  (fallback: ${route.fallback.provider}/${route.fallback.model})` : "";
    console.log(`    ${role.padEnd(14)} → ${route.primary.provider}/${route.primary.model}${fb}`);
  }
  console.log("");
  console.log(allOk ? "  Tudo certo. npm run dev pra ligar a fábrica." : "  Resolva os ✗ acima antes de ligar.");
  if (!allOk) process.exitCode = 1;
  console.log("");
}

main().catch((err) => {
  console.error("Doctor falhou:", err.message ?? err);
  console.error("Rodou o setup?  npm run setup");
  process.exit(1);
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ForgeConfigSchema } from "@jpxforge/shared";
import { parsePilotOptions, pilotConfig, PilotInputError, PilotPricingSchema } from "./pilot-options.js";

async function main() {
  const options = parsePilotOptions(process.argv.slice(2));
  if (options.help) {
    console.log("JPXFORGE - Piloto sintético isolado\n\n" +
      "npm run pilot -- --offline\n" +
      "npm run pilot -- --live --model deepseek-flash\n" +
      "Opções: --max-calls 1..3, --timeout-ms 100..300000, --pricing caminho.json\n\n" +
      "Padrão: offline. --live faz chamadas pagas à API DeepSeek. Usa somente a chave do setup\n" +
      "ou DEEPSEEK_API_KEY, um modelo sem fallback e thinking desativado. Máximo de três\n" +
      "chamadas, sem retries automáticos. Não há orçamento monetário global. Sem push ou WORK.\n" +
      "A tarifa é opcional e fornecida por você; sem ela o custo real fica desconhecido.\n" +
      "Cada execução cria uma pasta nova em .forge-pilots/ com relatório, banco e workspace.");
    return;
  }
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  let config;
  let pricing;
  if (options.mode === "live") {
    let key = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
    if (!key) {
      // Read operational configuration before overriding FORGE_DATA_DIR, without importing the DB.
      const configFile = path.join(path.resolve(repoRoot, process.env.FORGE_DATA_DIR || "."), "jpxforge.config.json");
      if (existsSync(configFile)) {
        try {
          const saved = ForgeConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/, "")));
          if (saved.providers.deepseek?.enabled) key = saved.providers.deepseek.api_key?.trim() ?? "";
        } catch { throw new PilotInputError("Configuração inválida. Revise o setup antes do piloto real."); }
      }
    }
    config = pilotConfig(options, key);
    if (options.pricingFile) {
      try { pricing = PilotPricingSchema.parse(JSON.parse(readFileSync(path.resolve(options.pricingFile), "utf8"))); }
      catch { throw new PilotInputError("Arquivo de tarifas inválido. Consulte o formato no README."); }
      if (pricing.model !== options.model) throw new PilotInputError("A tarifa deve corresponder ao modelo escolhido.");
    }
  }
  const pilotsRoot = path.join(repoRoot, ".forge-pilots");
  mkdirSync(pilotsRoot, { recursive: true, mode: 0o700 });
  const runDirectory = mkdtempSync(path.join(pilotsRoot, `${options.mode}-`));
  process.env.FORGE_DATA_DIR = runDirectory;
  const { db } = await import("./db.js");
  const { runPilot } = await import("./pilot-runner.js");
  const reportPath = path.join(runDirectory, "pilot-report.json");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  console.log(`Piloto ${options.mode === "live" ? "REAL (API paga)" : "OFFLINE (fixtures)"}: máximo de ${options.maxCalls} chamadas; revisão humana pendente.`);
  try {
    const router = config
      ? new (await import("./model-router.js")).ModelRouter(config)
      : new (await import("./demo-router.js")).DemoRouter();
    let completed = -1;
    const report = await runPilot(options, router, { signal: controller.signal, pricing, checkpoint(snapshot) {
      const temporary = reportPath + ".tmp";
      writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
      renameSync(temporary, reportPath);
      const done = snapshot.tasks.filter(t => t.status === "done").length;
      if (done !== completed) { completed = done; console.log(`Etapas concluídas: ${done}/5. Chamadas: ${snapshot.calls.length}/${options.maxCalls}.`); }
    } });
    console.log(`Resultado: ${report.status}. Relatório: ${reportPath}`);
    if (report.workspace) console.log(`Prévia local: ${path.join(report.workspace, "dist", "index.html")}`);
    if (report.status !== "passed") process.exitCode = report.status === "cancelled" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    db.close();
  }
}

main().catch(error => {
  console.error(error instanceof PilotInputError ? error.message : "Piloto interrompido. Verifique a instalação e o relatório local; a mensagem interna foi omitida para proteger dados.");
  process.exitCode = 1;
});

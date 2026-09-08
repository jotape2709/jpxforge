import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ForgeConfig, ForgeConfigSchema } from "@jpxforge/shared";

/**
 * Configuração vive em jpxforge.config.json na raiz do projeto.
 * Esse arquivo contém API keys e NUNCA é commitado (está no .gitignore).
 * Ninguém edita código pra configurar — ou roda `npm run setup`,
 * ou (Fase 2) usa a tela de Settings do dashboard.
 */

const CONFIG_PATH = path.resolve(process.cwd(), "../../jpxforge.config.json");

export function configPath(): string {
  return CONFIG_PATH;
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): ForgeConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config não encontrada em ${CONFIG_PATH}.\n` +
        `Rode primeiro:  npm run setup`
    );
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  return ForgeConfigSchema.parse(raw);
}

export function tryLoadConfig(): ForgeConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

export function saveConfig(config: ForgeConfig): void {
  const parsed = ForgeConfigSchema.parse(config);
  writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600, // só o dono lê/escreve — contém keys
  });
}

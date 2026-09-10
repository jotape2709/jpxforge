import { parseArgs } from "node:util";
import { ForgeConfigSchema, type ForgeConfig } from "@jpxforge/shared";
import { z } from "zod";

export class PilotInputError extends Error {}
export const PilotPricingSchema = z.object({
  currency: z.literal("USD"),
  model: z.string().min(1),
  input_usd_per_million: z.number().finite().nonnegative().max(10000),
  cached_input_usd_per_million: z.number().finite().nonnegative().max(10000).optional(),
  output_usd_per_million: z.number().finite().nonnegative().max(10000),
  checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict().refine(p => p.cached_input_usd_per_million === undefined ||
  p.cached_input_usd_per_million <= p.input_usd_per_million);
export type PilotPricing = z.infer<typeof PilotPricingSchema>;
export interface PilotOptions {
  mode: "offline" | "live";
  model: string;
  maxCalls: number;
  timeoutMs: number;
  pricingFile?: string;
  help: boolean;
}

export function parsePilotOptions(args: string[]): PilotOptions {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      offline: { type: "boolean" }, live: { type: "boolean" }, help: { type: "boolean" },
      model: { type: "string" }, "max-calls": { type: "string" },
      "timeout-ms": { type: "string" }, pricing: { type: "string" },
    } }));
  } catch { throw new PilotInputError("Argumentos inválidos. Consulte npm run pilot -- --help."); }
  if (values.live && values.offline) throw new PilotInputError("Escolha somente um modo: --offline ou --live.");
  if (values.live && !values.model) throw new PilotInputError("O piloto real exige --model com o modelo DeepSeek escolhido.");
  if (values.model && !/^deepseek-[a-z0-9.-]{1,80}$/.test(values.model)) {
    throw new PilotInputError("Identificador de modelo DeepSeek inválido.");
  }
  if (!values.live && (values.model || values.pricing)) {
    throw new PilotInputError("--model e --pricing são opções do piloto --live.");
  }
  const maxCalls = Number(values["max-calls"] ?? 3);
  const timeoutMs = Number(values["timeout-ms"] ?? 60000);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 3) {
    throw new PilotInputError("--max-calls deve ser um inteiro entre 1 e 3.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) {
    throw new PilotInputError("--timeout-ms deve ser um inteiro entre 100 e 300000.");
  }
  return { mode: values.live ? "live" : "offline", model: values.model ?? "fixture-local",
    maxCalls, timeoutMs, pricingFile: values.pricing, help: !!values.help };
}

/** Copy only the key. Operational roles, URLs, WORK and GitHub are not imported. */
export function pilotConfig(options: PilotOptions, key: string): ForgeConfig {
  if (!key.trim()) throw new PilotInputError("Chave DeepSeek ausente. Execute npm run setup no seu computador.");
  const primary = { provider: "deepseek", model: options.model, thinking: "disabled" };
  return ForgeConfigSchema.parse({ version: 1,
    providers: { deepseek: { enabled: true, base_url: "https://api.deepseek.com", api_key: key.trim() } },
    roles: Object.fromEntries(["product_owner", "tech_lead", "fullstack_dev"].map(role => [role, { primary }])),
  });
}

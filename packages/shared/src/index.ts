import { z } from "zod";

/**
 * JPXFORGE — Contratos centrais
 * Todo módulo (orquestrador, dashboard, agentes) fala usando estes tipos.
 * Mudou aqui, mudou pra fábrica inteira.
 */

// ── Papéis do time ──────────────────────────────────────────────

export const ROLES = [
  "product_owner", // Nina — transforma briefing bagunçado em Spec
  "tech_lead", // Atlas — planeja e quebra em tasks (modelo pago, prioridade)
  "web_dev", // Pixel — front-end
  "back_dev", // Rex — APIs e banco
  "fullstack_dev", // Juno — projetos ponta a ponta (MVP: landing pages)
  "qa", // Vera — testes e qualidade
  "security", // Sento — auditoria de segurança
  "narrator", // Voz do escritório (modelo local, diálogo ambiental)
] as const;

export type Role = (typeof ROLES)[number];

// ── Briefing (entrada crua, vem da ferramenta de prospecção) ────

export const BriefingInputSchema = z.object({
  source: z.enum(["whatsapp", "form", "manual", "api"]).default("api"),
  raw_text: z.string().trim().min(10, "briefing muito curto").max(30000),
  lead: z
    .object({
      name: z.string().optional(),
      company: z.string().optional(),
      contact: z.string().optional(),
      niche: z.string().optional(),
    })
    .optional(),
});
export type BriefingInput = z.infer<typeof BriefingInputSchema>;

// ── Spec (saída estruturada do Product Owner) ───────────────────

export const SpecSchema = z.object({
  title: z.string(),
  service_type: z.enum([
    "landing_page",
    "site_institucional",
    "automacao",
    "dashboard",
    "api",
    "outro",
  ]),
  summary: z.string(),
  business: z.object({
    client_name: z.string().default("Cliente"),
    niche: z.string().default("geral"),
    value_proposition: z.string().default(""),
    call_to_action: z.string().default("Fale conosco"),
  }),
  sections: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  brand: z
    .object({
      colors: z.array(z.string()).default([]),
      tone: z.string().default("profissional"),
    })
    .default({ colors: [], tone: "profissional" }),
  deadline_days: z.number().int().positive().default(7),
});
export type Spec = z.infer<typeof SpecSchema>;

// ── Tasks (saída do Tech Lead, unidade de trabalho da fila) ─────

export type TaskStatus = "queued" | "running" | "done" | "failed" | "blocked";

export interface Task {
  id: string;
  project_id: string;
  title: string;
  role: Role;
  depends_on: string[]; // ids de tasks que precisam terminar antes
  payload: Record<string, unknown>;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  result?: unknown;
  error?: string;
  created_at: string;
  updated_at: string;
}

export const TaskSchema = z.object({
  id: z.string().min(1), project_id: z.string().min(1), title: z.string().min(1),
  role: z.enum(ROLES), depends_on: z.array(z.string().min(1)),
  payload: z.record(z.unknown()),
  status: z.enum(["queued", "running", "done", "failed", "blocked"]),
  attempts: z.number().int().nonnegative(), max_attempts: z.number().int().positive(),
  result: z.unknown().optional(), error: z.string().optional(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
});

// ── Projeto ─────────────────────────────────────────────────────

export type ProjectStatus =
  | "intake" // briefing recebido, PO trabalhando
  | "planned" // tech lead já quebrou em tasks
  | "building"
  | "review" // QA + segurança
  | "shipped" // push feito
  | "quarantine" // falhou após retries — precisa de humano
  | "aborted";

export interface Project {
  id: string;
  status: ProjectStatus;
  briefing: BriefingInput;
  spec?: Spec;
  repo_url?: string;
  created_at: string;
  updated_at: string;
}

// ── Eventos (stream do dashboard + replay log) ──────────────────

export interface ForgeEvent {
  id: string;
  project_id: string | null;
  role: Role | null;
  type:
    | "project.created"
    | "project.status"
    | "task.queued"
    | "task.started"
    | "task.done"
    | "task.failed"
    | "agent.say" // fala visível no chat do escritório
    | "tokens.used"
    | "system";
  message: string;
  data?: Record<string, unknown>;
  ts: string;
}

export const ForgeEventSchema = z.object({
  id: z.string().min(1), project_id: z.string().nullable(), role: z.enum(ROLES).nullable(),
  type: z.enum(["project.created", "project.status", "task.queued", "task.started", "task.done", "task.failed", "agent.say", "tokens.used", "system"]),
  message: z.string(), data: z.record(z.unknown()).optional(), ts: z.string().datetime(),
});

// ── Configuração (jpxforge.config.json — gerado pelo setup) ─────

export const ProviderSchema = z.object({
  api_key: z.string().optional(),
  base_url: z.string(),
  enabled: z.boolean().default(true),
});

export const ModelTargetSchema = z.object({
  provider: z.enum(["deepseek", "openrouter", "ollama"]),
  model: z.string(),
});

export const RoleRouteSchema = z.object({
  primary: ModelTargetSchema,
  fallback: ModelTargetSchema.optional(),
});

export const ForgeConfigSchema = z.object({
  version: z.literal(1),
  server: z
    .object({
      port: z.number().int().min(1).max(65535).default(4100),
      host: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
    })
    .default({ port: 4100, host: "127.0.0.1" }),
  providers: z.object({
    deepseek: ProviderSchema.optional(),
    openrouter: ProviderSchema.optional(),
    ollama: ProviderSchema.optional(),
  }),
  roles: z.record(z.string(), RoleRouteSchema),
  github: z
    .object({
      token: z.string().optional(),
      owner: z.string().optional(),
      auto_create_repo: z.boolean().default(false),
    })
    .default({ auto_create_repo: false }),
  work: z
    .object({
      base_url: z.string().default("http://127.0.0.1:4310"),
      token: z.string().optional(), // WORK_DEV_TEAM_TOKEN — nunca logar
      worker_id: z.string().default("jpxforge-slot-1"),
      poll_interval_ms: z.number().int().min(1000).max(300000).default(15000),
      auto_claim: z.boolean().default(false), // Fase 1+ liga a retirada automática
    })
    .default({
      base_url: "http://127.0.0.1:4310",
      worker_id: "jpxforge-slot-1",
      poll_interval_ms: 15000,
      auto_claim: false,
    }),
});

export type ForgeConfig = z.infer<typeof ForgeConfigSchema>;
export type ModelTarget = z.infer<typeof ModelTargetSchema>;

// ── Integração WORK (contrato v1 — jpxforge é CLIENTE da API do WORK) ──

export const HandoffBriefSchema = z.object({
  title: z.string(),
  objective: z.string(),
  scope: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  domain: z.string().default("geral"),
});
export type HandoffBrief = z.infer<typeof HandoffBriefSchema>;

export const HandoffSchema = z.object({
  id: z.string(),
  status: z.string(),
  version: z.number().int(),
  attempt: z.number().int(),
  lastSequence: z.number().int().default(0),
  claimToken: z.string().min(1),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  clientApproval: z.object({
    state: z.string(), briefDigest: z.string().optional(),
    approvedAt: z.string().nullable().optional(), method: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  brief: HandoffBriefSchema,
  review: z
    .object({
      decision: z.string().optional(),
      notes: z.string().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const WorkStatusSchema = z.object({
  service: z.string(),
  protocolVersion: z.union([z.string(), z.number()]),
  paused: z.boolean(),
  ready: z.number().int(),
});
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

/** Evento que o jpxforge reporta de volta ao WORK */
export interface WorkEventPayload {
  eventId: string;
  claimToken: string;
  sequence: number;
  type: "progress" | "completed" | "failed";
  message?: string;
  result?: {
    summary: string;
    artifacts?: { label: string; url: string }[];
    checks?: { name: string; status: "passed" | "failed" | "not_run"; details?: string }[];
    risks?: string[];
  };
}

// ── Defaults de roteamento (usados pelo setup wizard) ───────────

export const DEFAULT_ROLE_ROUTES: Record<Role, z.infer<typeof RoleRouteSchema>> = {
  product_owner: {
    primary: { provider: "deepseek", model: "deepseek-chat" },
  },
  tech_lead: {
    primary: { provider: "deepseek", model: "deepseek-reasoner" },
    fallback: { provider: "deepseek", model: "deepseek-chat" },
  },
  web_dev: {
    primary: { provider: "deepseek", model: "deepseek-chat" },
    fallback: { provider: "ollama", model: "qwen2.5-coder:3b" },
  },
  back_dev: {
    primary: { provider: "deepseek", model: "deepseek-chat" },
    fallback: { provider: "ollama", model: "qwen2.5-coder:3b" },
  },
  fullstack_dev: {
    primary: { provider: "deepseek", model: "deepseek-chat" },
    fallback: { provider: "ollama", model: "qwen2.5-coder:3b" },
  },
  qa: {
    primary: { provider: "ollama", model: "qwen2.5-coder:3b" },
    fallback: { provider: "deepseek", model: "deepseek-chat" },
  },
  security: {
    primary: { provider: "ollama", model: "qwen2.5-coder:3b" },
    fallback: { provider: "deepseek", model: "deepseek-chat" },
  },
  narrator: {
    primary: { provider: "ollama", model: "llama3.2:1b" },
  },
};

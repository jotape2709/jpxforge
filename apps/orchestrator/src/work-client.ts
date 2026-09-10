import {
  ForgeConfig,
  HandoffSchema,
  Handoff,
  WorkEventPayload,
  WorkStatus,
  WorkStatusSchema,
} from "@jpxforge/shared";
import { z } from "zod";

/**
 * WorkClient — cliente HTTP da API local do WORK (contrato v1).
 * jpxforge é CLIENTE: faz requisições de saída ao WORK.
 *
 * Regras do contrato respeitadas aqui:
 * - Authorization: Bearer <token> — nunca em URL, log ou artefato
 * - claim com workerId estável; uma execução ativa por workerId
 * - eventos com eventId + sequence idempotentes
 * - 409 em claim = worker ocupado; 401/403 = token revogado
 */

export class WorkRevokedError extends Error {}
export class WorkConflictError extends Error {}
export class WorkProtocolError extends Error {}

const EventAckSchema = z.object({
  id: z.string(), status: z.string(), attempt: z.number().int().positive(),
  version: z.number().int(), lastSequence: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
});
export type WorkEventAck = z.infer<typeof EventAckSchema>;

export class WorkClient {
  private baseUrl: string;
  private token: string;
  readonly workerId: string;

  constructor(config: ForgeConfig["work"]) {
    if (!config.token) throw new Error("WORK sem token — rode npm run setup");
    const url = new URL(config.base_url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("WORK exige HTTPS ou endereço loopback");
    }
    if (url.username || url.password || url.search || url.hash || !config.worker_id.trim()) {
      throw new Error("Configure endereço WORK sem credenciais e workerId estável");
    }
    this.baseUrl = url.href.replace(/\/+$/, "");
    this.token = config.token;
    this.workerId = config.worker_id;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new WorkRevokedError("token revogado ou inválido no WORK");
    }
    if (res.status === 409) {
      throw new WorkConflictError("conflito: worker ocupado ou sequência divergente");
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new WorkProtocolError(`WORK rejeitou a requisição (${res.status}); exige inspeção`);
    }
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      throw new Error(`WORK ${method} ${path} → ${res.status}`);
    }
    return { status: res.status, data };
  }

  /** Testa conexão sem retirar trabalho (não faz claim, não expõe conteúdo) */
  async status(): Promise<WorkStatus> {
    const { data } = await this.request<unknown>(
      "GET",
      "/integrations/dev-team/status"
    );
    return WorkStatusSchema.parse(data);
  }

  /** Retira trabalho da fila. null = fila vazia. 409 = worker ocupado. */
  async claim(signal?: AbortSignal): Promise<Handoff | null> {
    const { data } = await this.request<{ handoff: unknown }>(
      "POST",
      "/integrations/dev-team/claim",
      { workerId: this.workerId }, signal,
    );
    if (!data || !("handoff" in data)) throw new WorkProtocolError("WORK devolveu resposta de retirada inválida");
    if (data.handoff === null) return null;
    return HandoffSchema.parse(data.handoff);
  }

  /**
   * Envia evento de progresso/conclusão/falha.
   * Reenvio após perda de confirmação preserva eventId/sequence/conteúdo.
   */
  async sendEvent(handoffId: string, event: WorkEventPayload, signal?: AbortSignal): Promise<WorkEventAck> {
    const { data } = await this.request<unknown>(
      "POST",
      `/integrations/dev-team/handoffs/${encodeURIComponent(handoffId)}/events`,
      event, signal,
    );
    const parsed = EventAckSchema.safeParse(data);
    if (!parsed.success) throw new WorkProtocolError("WORK devolveu confirmação incompatível com contrato v1");
    return parsed.data;
  }
}

import {
  ForgeConfig,
  HandoffSchema,
  Handoff,
  WorkEventPayload,
  WorkStatus,
  WorkStatusSchema,
} from "@jpxforge/shared";

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

export class WorkClient {
  private baseUrl: string;
  private token: string;
  readonly workerId: string;

  constructor(config: ForgeConfig["work"]) {
    if (!config.token) throw new Error("WORK sem token — rode npm run setup");
    this.baseUrl = config.base_url.replace(/\/+$/, "");
    this.token = config.token;
    this.workerId = config.worker_id;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new WorkRevokedError("token revogado ou inválido no WORK");
    }
    if (res.status === 409) {
      throw new WorkConflictError("conflito: worker ocupado ou sequência divergente");
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
  async claim(): Promise<Handoff | null> {
    const { data } = await this.request<{ handoff: unknown }>(
      "POST",
      "/integrations/dev-team/claim",
      { workerId: this.workerId }
    );
    if (!data.handoff) return null;
    return HandoffSchema.parse(data.handoff);
  }

  /**
   * Envia evento de progresso/conclusão/falha.
   * Reenvio após perda de confirmação preserva eventId/sequence/conteúdo.
   */
  async sendEvent(handoffId: string, event: WorkEventPayload): Promise<void> {
    await this.request(
      "POST",
      `/integrations/dev-team/handoffs/${encodeURIComponent(handoffId)}/events`,
      event
    );
  }
}

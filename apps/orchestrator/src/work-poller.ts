import { ForgeConfig, WorkEventPayload } from "@jpxforge/shared";
import { WorkClient, WorkConflictError, WorkProtocolError, WorkRevokedError } from "./work-client.js";
import {
  confirmWorkEvent, getActiveExecution, getExecution, closeExecution, leaseExpired,
  pendingWorkEvents, queueWorkEvent, type Execution,
} from "./executions.js";
import { abortProjectTasks, updateProject } from "./db.js";
import { emit } from "./events.js";
import { cancelProjectWork } from "./queue.js";

let poller: WorkPoller | null = null;

export function isWorkRevoked(): boolean { return poller?.revoked ?? false; }

export function reportProgress(handoffId: string, message: string): void {
  queueWorkEvent(handoffId, { type: "progress", message });
}
export function reportCompleted(handoffId: string, result: NonNullable<WorkEventPayload["result"]>): void {
  queueWorkEvent(handoffId, { type: "completed", result });
}
export function reportFailed(handoffId: string, message: string): void {
  queueWorkEvent(handoffId, { type: "failed", message });
}

/** Phase 4 drain only: no claims until the complete WORK pilot is validated. */
export class WorkPoller {
  revoked = false;
  private stopped = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private requestController: AbortController | null = null;

  constructor(private client: WorkClient, private intervalMs: number,
    private cancel: (projectId: string) => void = cancelProjectWork) {}

  private abort(ex: Execution, message: string): void {
    this.cancel(ex.project_id);
    abortProjectTasks(ex.project_id);
    updateProject(ex.project_id, { status: "quarantine" });
    closeExecution(ex.handoff_id, "aborted", ex.attempt);
    this.requestController?.abort();
    emit({ type: "system", project_id: ex.project_id, role: null, message });
  }

  private watchLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    const ex = getActiveExecution(this.client.workerId);
    if (!ex) return;
    if (leaseExpired(ex)) {
      this.abort(ex, "Lease do WORK expirado — execução interrompida e projeto em quarentena");
      return;
    }
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      const current = getExecution(ex.handoff_id, ex.attempt);
      if (current?.status === "active") {
        if (leaseExpired(current)) this.abort(current, "Lease do WORK expirou durante a execução — projeto em quarentena");
        else this.watchLease();
      }
    }, Math.min(2_147_483_647, Math.max(1, Date.parse(ex.lease_expires_at) - Date.now())));
    this.leaseTimer.unref();
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.revoked) return;
    this.watchLease();
    for (const ev of pendingWorkEvents(this.client.workerId)) {
      if (this.stopped || this.revoked) break;
      const ex = getExecution(ev.handoff_id, ev.attempt);
      if (!ex || ex.status !== "active") break;
      if (leaseExpired(ex)) { this.watchLease(); break; }
      this.requestController = new AbortController();
      try {
        const ack = await this.client.sendEvent(ev.handoff_id, JSON.parse(ev.payload) as WorkEventPayload, this.requestController.signal);
        if (this.stopped || getExecution(ev.handoff_id, ev.attempt)?.status !== "active") break;
        confirmWorkEvent(ev.event_id, ack);
        this.watchLease();
      } catch (error) {
        if (error instanceof WorkRevokedError) {
          this.revoked = true;
          this.abort(ex, "Token do WORK revogado — execução interrompida; confira a concessão no WORK");
        } else if (error instanceof WorkConflictError || error instanceof WorkProtocolError) {
          // 409 is divergence, never proof of receipt. Preserve evidence unconfirmed.
          this.abort(ex, "Conflito de protocolo WORK — evento não confirmado; inspecione a outbox e o WORK");
        }
        // Network errors leave this exact body pending. Never send later sequences.
        break;
      } finally {
        this.requestController = null;
      }
    }
  }

  runOnce(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.drain().finally(() => { this.flight = null; });
    return this.flight;
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.watchLease();
    const cycle = async () => {
      this.timer = null;
      try { await this.runOnce(); }
      catch { emit({ type: "system", project_id: null, role: null, message: "Falha local ao drenar WORK; confira o banco antes de retomar" }); }
      if (!this.stopped && !this.revoked) this.timer = setTimeout(cycle, this.intervalMs);
    };
    this.timer = setTimeout(cycle, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.timer = this.leaseTimer = null;
    this.requestController?.abort();
    await this.flight;
  }
}

export function startWorkPoller(config: ForgeConfig): void {
  if (poller) return;
  const w = config.work;
  if (w.auto_claim) {
    throw new Error("WORK auto_claim=true bloqueado: piloto completo da Fase 4 ainda pendente. Use auto_claim=false para status e drenagem de execuções antigas.");
  }
  if (!w.token) {
    emit({ type: "system", project_id: null, role: null, message: "WORK não configurado — integração desligada" });
    return;
  }
  const existing = getActiveExecution();
  if (existing && existing.worker_id !== w.worker_id) {
    throw new Error("WORK possui concessão ativa de outro workerId; restaure o identificador estável antes de iniciar");
  }
  poller = new WorkPoller(new WorkClient(w), w.poll_interval_ms);
  poller.start();
  emit({ type: "system", project_id: null, role: null,
    message: "WORK configurado: novas retiradas bloqueadas até piloto da Fase 4; drenagem de concessões existentes ativa" });
}

export async function stopWorkPoller(): Promise<void> {
  const current = poller;
  if (current) await current.stop();
  poller = null;
}

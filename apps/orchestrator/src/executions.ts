import { Handoff } from "@jpxforge/shared";
import { db, newId } from "./db.js";

/**
 * Persistência das execuções WORK (contrato v1).
 * Guarda concessão (claimToken), sequência de eventos e outbox
 * pra reenvio idempotente — tudo local, acesso restrito.
 * claimToken NUNCA aparece em logs.
 */

export interface Execution {
  handoff_id: string;
  project_id: string;
  claim_token: string;
  worker_id: string;
  attempt: number;
  version: number;
  sequence: number;
  lease_expires_at: string;
  status: "active" | "completed" | "failed" | "aborted";
  created_at: string;
  updated_at: string;
}

const now = () => new Date().toISOString();

export function createExecution(
  handoff: Handoff,
  projectId: string,
  workerId: string
): Execution {
  const ex: Execution = {
    handoff_id: handoff.id,
    project_id: projectId,
    claim_token: handoff.claimToken,
    worker_id: workerId,
    attempt: handoff.attempt,
    version: handoff.version,
    sequence: 0,
    lease_expires_at: handoff.leaseExpiresAt,
    status: "active",
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO executions (handoff_id, project_id, claim_token, worker_id, attempt, version, sequence, lease_expires_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?)`
  ).run(
    ex.handoff_id,
    ex.project_id,
    ex.claim_token,
    ex.worker_id,
    ex.attempt,
    ex.version,
    ex.lease_expires_at,
    ex.created_at,
    ex.updated_at
  );
  return ex;
}

export function getActiveExecution(): Execution | null {
  const row = db
    .prepare(`SELECT * FROM executions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`)
    .get() as Execution | undefined;
  return row ?? null;
}

export function getExecution(handoffId: string): Execution | null {
  const row = db
    .prepare(`SELECT * FROM executions WHERE handoff_id = ?`)
    .get(handoffId) as Execution | undefined;
  return row ?? null;
}

export function closeExecution(
  handoffId: string,
  status: "completed" | "failed" | "aborted"
): void {
  db.prepare(
    `UPDATE executions SET status = ?, updated_at = ? WHERE handoff_id = ?`
  ).run(status, now(), handoffId);
}

export function updateLease(handoffId: string, leaseExpiresAt: string): void {
  db.prepare(
    `UPDATE executions SET lease_expires_at = ?, updated_at = ? WHERE handoff_id = ?`
  ).run(leaseExpiresAt, now(), handoffId);
}

export function leaseExpired(ex: Execution): boolean {
  return new Date(ex.lease_expires_at).getTime() < Date.now();
}

/**
 * Próxima sequência do evento (começa em 1, consecutiva por tentativa).
 * Persistida antes do envio — sobrevive a queda do processo.
 */
export function nextSequence(handoffId: string): number {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE executions SET sequence = sequence + 1, updated_at = ? WHERE handoff_id = ?`
    ).run(now(), handoffId);
    const row = db
      .prepare(`SELECT sequence FROM executions WHERE handoff_id = ?`)
      .get(handoffId) as { sequence: number };
    return row.sequence;
  });
  return tx();
}

// ── Outbox de eventos pro WORK ──────────────────────────────────

export interface OutboxEvent {
  event_id: string;
  handoff_id: string;
  sequence: number;
  payload: string;
  confirmed: number;
  created_at: string;
}

export function queueWorkEvent(handoffId: string, payload: object): string {
  const eventId = newId("wevt");
  const sequence = nextSequence(handoffId);
  db.prepare(
    `INSERT INTO work_outbox (event_id, handoff_id, sequence, payload, confirmed, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(eventId, handoffId, sequence, JSON.stringify(payload), now());
  return eventId;
}

export function pendingWorkEvents(): OutboxEvent[] {
  return db
    .prepare(
      `SELECT * FROM work_outbox WHERE confirmed = 0 ORDER BY sequence ASC LIMIT 50`
    )
    .all() as OutboxEvent[];
}

export function confirmWorkEvent(eventId: string): void {
  db.prepare(`UPDATE work_outbox SET confirmed = 1 WHERE event_id = ?`).run(
    eventId
  );
}

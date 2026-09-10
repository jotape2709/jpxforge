import { Handoff, WorkEventPayload } from "@jpxforge/shared";
import { db, newId } from "./db.js";
import { WorkProtocolError, type WorkEventAck } from "./work-client.js";

/** Secret concessions and exact outbound bodies are stored only in the local DB. */
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

// Upgrade the Phase 0 tables atomically, preserving old executions and outbox.
db.transaction(() => {
  const columns = db.prepare("PRAGMA table_info(executions)").all() as { name: string; pk: number }[];
  if (!columns.some((column) => column.name === "attempt" && column.pk > 0)) {
    db.exec(`ALTER TABLE executions RENAME TO executions_legacy;
      CREATE TABLE executions (
        handoff_id TEXT NOT NULL, project_id TEXT NOT NULL, claim_token TEXT NOT NULL,
        worker_id TEXT NOT NULL, attempt INTEGER NOT NULL, version INTEGER NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (handoff_id, attempt)
      );
      INSERT INTO executions SELECT * FROM executions_legacy;
      DROP TABLE executions_legacy;`);
  }
  const outboxColumns = db.prepare("PRAGMA table_info(work_outbox)").all() as { name: string }[];
  if (!outboxColumns.some((column) => column.name === "attempt")) {
    db.exec(`ALTER TABLE work_outbox ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
      UPDATE work_outbox SET attempt = COALESCE(
        (SELECT attempt FROM executions e WHERE e.handoff_id = work_outbox.handoff_id
          AND e.claim_token = json_extract(work_outbox.payload, '$.claimToken') ORDER BY attempt DESC LIMIT 1), 1);`);
  }
  // The old code added these fields only when sending. Persist that exact body now.
  db.exec(`UPDATE work_outbox SET payload = json_set(payload, '$.eventId', event_id, '$.sequence', sequence)
    WHERE json_extract(payload, '$.eventId') IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_active_worker ON executions(worker_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_active_handoff ON executions(handoff_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_attempt_sequence ON work_outbox(handoff_id, attempt, sequence);`);
}).immediate();

export function createExecution(handoff: Handoff, projectId: string, workerId: string): Execution {
  return db.transaction(() => {
    if (handoff.lastSequence !== 0 || handoff.status !== "running" || handoff.attempt < 1) {
      throw new Error("Concessão WORK não é uma nova tentativa válida; inspecione no WORK");
    }
    if (Date.parse(handoff.leaseExpiresAt) <= Date.now() || !Number.isFinite(Date.parse(handoff.leaseExpiresAt))) {
      throw new Error("Concessão WORK com lease inválido ou expirado");
    }
    const previous = getExecution(handoff.id);
    if (previous && (handoff.attempt <= previous.attempt || handoff.claimToken === previous.claim_token)) {
      throw new Error("Nova tentativa WORK exige attempt maior e nova concessão");
    }
    const ex: Execution = {
      handoff_id: handoff.id, project_id: projectId, claim_token: handoff.claimToken,
      worker_id: workerId, attempt: handoff.attempt, version: handoff.version, sequence: 0,
      lease_expires_at: handoff.leaseExpiresAt, status: "active", created_at: now(), updated_at: now(),
    };
    db.prepare(`INSERT INTO executions
      (handoff_id, project_id, claim_token, worker_id, attempt, version, sequence, lease_expires_at, status, created_at, updated_at)
      VALUES (@handoff_id, @project_id, @claim_token, @worker_id, @attempt, @version, @sequence,
        @lease_expires_at, @status, @created_at, @updated_at)`).run(ex);
    return ex;
  }).immediate();
}

export function getActiveExecution(workerId?: string): Execution | null {
  return (db.prepare(`SELECT * FROM executions WHERE status = 'active'
    AND (? IS NULL OR worker_id = ?) ORDER BY created_at ASC LIMIT 1`)
    .get(workerId ?? null, workerId ?? null) as Execution | undefined) ?? null;
}

export function getExecution(handoffId: string, attempt?: number): Execution | null {
  return (db.prepare(`SELECT * FROM executions WHERE handoff_id = ? AND (? IS NULL OR attempt = ?)
    ORDER BY attempt DESC LIMIT 1`).get(handoffId, attempt ?? null, attempt ?? null) as Execution | undefined) ?? null;
}

export function closeExecution(handoffId: string, status: "completed" | "failed" | "aborted", attempt?: number): void {
  db.prepare(`UPDATE executions SET status = ?, updated_at = ? WHERE handoff_id = ?
    AND status = 'active' AND (? IS NULL OR attempt = ?)`)
    .run(status, now(), handoffId, attempt ?? null, attempt ?? null);
}

export function leaseExpired(ex: Execution): boolean {
  const expires = Date.parse(ex.lease_expires_at);
  return !Number.isFinite(expires) || expires <= Date.now();
}

export interface OutboxEvent {
  event_id: string;
  handoff_id: string;
  attempt: number;
  sequence: number;
  payload: string;
  confirmed: number;
  created_at: string;
}

/** Allocation and insert commit together; retries never allocate a new sequence. */
export function queueWorkEvent(handoffId: string, payload: Omit<WorkEventPayload, "eventId" | "sequence" | "claimToken">): string {
  return db.transaction(() => {
    const ex = getExecution(handoffId);
    if (!ex || ex.status !== "active" || leaseExpired(ex)) throw new Error("Execução WORK inativa ou expirada");
    const terminal = db.prepare(`SELECT 1 FROM work_outbox WHERE handoff_id = ? AND attempt = ?
      AND json_extract(payload, '$.type') IN ('completed', 'failed') LIMIT 1`).get(handoffId, ex.attempt);
    if (terminal) throw new Error("Execução WORK já possui evento terminal pendente ou confirmado");
    const eventId = newId("wevt");
    const sequence = ex.sequence + 1;
    const body: WorkEventPayload = { ...payload, claimToken: ex.claim_token, eventId, sequence };
    db.prepare(`UPDATE executions SET sequence = ?, updated_at = ? WHERE handoff_id = ? AND attempt = ?`)
      .run(sequence, now(), handoffId, ex.attempt);
    db.prepare(`INSERT INTO work_outbox (event_id, handoff_id, attempt, sequence, payload, confirmed, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)`).run(eventId, handoffId, ex.attempt, sequence, JSON.stringify(body), now());
    return eventId;
  }).immediate();
}

export function pendingWorkEvents(workerId?: string): OutboxEvent[] {
  return db.prepare(`SELECT o.* FROM work_outbox o JOIN executions e
    ON e.handoff_id = o.handoff_id AND e.attempt = o.attempt
    WHERE o.confirmed = 0 AND e.status = 'active' AND (? IS NULL OR e.worker_id = ?)
    ORDER BY e.created_at ASC, o.sequence ASC LIMIT 50`).all(workerId ?? null, workerId ?? null) as OutboxEvent[];
}

/** Persist ACK and renewed lease/terminal status in the same transaction. */
export function confirmWorkEvent(eventId: string, ack: WorkEventAck): void {
  db.transaction(() => {
    const ev = db.prepare("SELECT * FROM work_outbox WHERE event_id = ?").get(eventId) as OutboxEvent | undefined;
    if (!ev || ev.confirmed) return;
    const ex = getExecution(ev.handoff_id, ev.attempt);
    if (!ex || ex.status !== "active") return;
    const payload = JSON.parse(ev.payload) as WorkEventPayload;
    const expectedStatus = payload.type === "progress" ? "running" : payload.type === "completed" ? "awaiting_review" : "failed";
    if (ack.id !== ev.handoff_id || ack.attempt !== ev.attempt || ack.lastSequence !== ev.sequence || ack.status !== expectedStatus) {
      throw new WorkProtocolError("Confirmação WORK diverge do evento pendente; exige inspeção");
    }
    if (payload.type === "progress" && (!ack.leaseExpiresAt || !Number.isFinite(Date.parse(ack.leaseExpiresAt)) || Date.parse(ack.leaseExpiresAt) <= Date.now())) {
      throw new WorkProtocolError("WORK não renovou um lease válido no progresso");
    }
    const older = db.prepare(`SELECT 1 FROM work_outbox WHERE handoff_id = ? AND attempt = ?
      AND sequence < ? AND confirmed = 0 LIMIT 1`).get(ev.handoff_id, ev.attempt, ev.sequence);
    if (older) throw new WorkProtocolError("Confirmação WORK fora de ordem");
    db.prepare(`UPDATE executions SET lease_expires_at = ?, version = ?, status = ?, updated_at = ?
      WHERE handoff_id = ? AND attempt = ?`).run(ack.leaseExpiresAt ?? ex.lease_expires_at, ack.version,
        payload.type === "progress" ? "active" : payload.type, now(), ex.handoff_id, ex.attempt);
    db.prepare("UPDATE work_outbox SET confirmed = 1 WHERE event_id = ?").run(eventId);
  }).immediate();
}

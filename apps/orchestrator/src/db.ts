import Database from "better-sqlite3";
import crypto from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import {
  ForgeEvent,
  Project,
  ProjectStatus,
  Role,
  Task,
  TaskStatus,
  BriefingInput,
  Spec,
} from "@jpxforge/shared";
import { DATA_DIR, dataPath } from "./paths.js";

/**
 * Persistência 100% SQLite local: projetos, fila de tasks, eventos (replay)
 * e uso de tokens (precificação jpxlab). Zero serviços externos.
 */

export const DB_PATH = dataPath("jpxforge.db");

mkdirSync(DATA_DIR, { recursive: true });
export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// O banco guarda claimTokens (concessões do WORK) — acesso restrito.
try {
  chmodSync(DB_PATH, 0o600);
} catch {
  // No Windows as permissões dependem da ACL do diretório de dados.
}

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  briefing TEXT NOT NULL,
  spec TEXT,
  repo_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  role TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);

-- Execuções WORK: uma retirada ativa por vez, concessão persistida
CREATE TABLE IF NOT EXISTS executions (
  handoff_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  version INTEGER NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Outbox: eventos pendentes de confirmação pelo WORK (reenvio idempotente)
CREATE TABLE IF NOT EXISTS work_outbox (
  event_id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  payload TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON work_outbox(confirmed, sequence);
`);

const now = () => new Date().toISOString();
export const newId = (prefix: string) =>
  `${prefix}_${crypto.randomBytes(6).toString("hex")}`;

// ── Projetos ────────────────────────────────────────────────────

export function createProject(briefing: BriefingInput): Project {
  const p: Project = {
    id: newId("prj"),
    status: "intake",
    briefing,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO projects (id, status, briefing, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(p.id, p.status, JSON.stringify(briefing), p.created_at, p.updated_at);
  return p;
}

export function getProject(id: string): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    ...(row as object),
    briefing: JSON.parse(row.briefing as string),
    spec: row.spec ? JSON.parse(row.spec as string) : undefined,
  } as Project;
}

export function listProjects(): Project[] {
  const rows = db
    .prepare(`SELECT * FROM projects ORDER BY created_at DESC LIMIT 100`)
    .all() as Record<string, unknown>[];
  return rows.map(
    (row) =>
      ({
        ...(row as object),
        briefing: JSON.parse(row.briefing as string),
        spec: row.spec ? JSON.parse(row.spec as string) : undefined,
      }) as Project
  );
}

export function updateProject(
  id: string,
  patch: { status?: ProjectStatus; spec?: Spec; repo_url?: string }
): boolean {
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [now()];
  if (patch.status) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.spec) {
    sets.push("spec = ?");
    vals.push(JSON.stringify(patch.spec));
  }
  if (patch.repo_url) {
    sets.push("repo_url = ?");
    vals.push(patch.repo_url);
  }
  vals.push(id);
  return db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?
    AND status NOT IN ('aborted', 'quarantine', 'shipped')`).run(
    ...vals
  ).changes === 1;
}

// ── Tasks (a fila) ──────────────────────────────────────────────

export function enqueueTask(
  t: Pick<Task, "project_id" | "title" | "role"> &
    Partial<Pick<Task, "depends_on" | "payload" | "max_attempts">>
): Task {
  const project = getProject(t.project_id);
  if (!project || ["aborted", "quarantine", "shipped"].includes(project.status)) {
    throw new Error(`Projeto indisponível para novas tarefas: ${t.project_id}`);
  }
  if (t.max_attempts !== undefined && (!Number.isInteger(t.max_attempts) || t.max_attempts < 1)) {
    throw new Error("max_attempts deve ser um inteiro positivo");
  }
  const task: Task = {
    id: newId("task"),
    project_id: t.project_id,
    title: t.title,
    role: t.role,
    depends_on: t.depends_on ?? [],
    payload: t.payload ?? {},
    status: "queued",
    attempts: 0,
    max_attempts: t.max_attempts ?? 2,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, role, depends_on, payload, status, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    task.project_id,
    task.title,
    task.role,
    JSON.stringify(task.depends_on),
    JSON.stringify(task.payload),
    task.status,
    task.attempts,
    task.max_attempts,
    task.created_at,
    task.updated_at
  );
  return task;
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    ...(row as object),
    depends_on: JSON.parse(row.depends_on as string),
    payload: JSON.parse(row.payload as string),
    result: row.result ? JSON.parse(row.result as string) : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
  } as Task;
}

/**
 * Pega a próxima task pronta: queued, sem dependências pendentes.
 * Retorna já marcada como running (claim atômico).
 */
export function claimNextTask(): Task | null {
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'queued' AND t.attempts < t.max_attempts
           AND p.status NOT IN ('aborted', 'quarantine', 'shipped')
           AND NOT EXISTS (
             SELECT 1 FROM json_each(t.depends_on) dependency
             LEFT JOIN tasks d ON d.id = dependency.value AND d.project_id = t.project_id
             WHERE d.id IS NULL OR d.status != 'done'
           )
         ORDER BY t.created_at ASC, t.rowid ASC LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const updatedAt = now();
    const claimed = db.prepare(
      `UPDATE tasks SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'queued'`
    ).run(updatedAt, row.id);
    if (claimed.changes !== 1) return null;
    return { ...rowToTask(row), status: "running" as TaskStatus, attempts: Number(row.attempts) + 1, error: undefined, updated_at: updatedAt };
  });
  return tx.immediate();
}

export function completeTask(id: string, result?: unknown, expectedAttempt?: number): boolean {
  return db.prepare(
    `UPDATE tasks SET status = 'done', result = ?, error = NULL, updated_at = ?
     WHERE id = ? AND status = 'running' AND (? IS NULL OR attempts = ?)
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id
         AND p.status NOT IN ('aborted', 'quarantine'))`
  ).run(result === undefined ? null : JSON.stringify(result), now(), id, expectedAttempt ?? null, expectedAttempt ?? null).changes === 1;
}

export function failTask(id: string, error: string, expectedAttempt?: number): Task | null {
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row || row.status !== "running") return null;
    const task = rowToTask(row);
    const status = task.attempts >= task.max_attempts ? "failed" : "queued";
    const updatedAt = now();
    const changed = db.prepare(
      `UPDATE tasks SET status = ?, error = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND (? IS NULL OR attempts = ?)
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id
           AND p.status NOT IN ('aborted', 'quarantine', 'shipped'))`
    ).run(status, error, updatedAt, id, expectedAttempt ?? null, expectedAttempt ?? null);
    return changed.changes === 1 ? { ...task, status: status as TaskStatus, error, updated_at: updatedAt } : null;
  }).immediate();
}

/** Call once on startup, before starting the only worker for this database. */
export function recoverInterruptedTasks(): { taskIds: string[]; projectIds: string[] } {
  return db.transaction(() => {
    const interrupted = db.prepare(`SELECT id, project_id FROM tasks WHERE status = 'running'`)
      .all() as { id: string; project_id: string }[];
    const projectIds = [...new Set(interrupted.map((task) => task.project_id))];
    const timestamp = now();
    // An interrupted operation may already have produced files or a remote push.
    // Require inspection instead of blindly repeating its side effects.
    db.prepare(`UPDATE tasks SET status = 'blocked', error = ?, updated_at = ? WHERE status = 'running'`)
      .run("Execução interrompida; inspecione os efeitos antes de retomar manualmente.", timestamp);
    const quarantine = db.prepare(`UPDATE projects SET status = 'quarantine', updated_at = ?
      WHERE id = ? AND status NOT IN ('aborted', 'shipped')`);
    for (const projectId of projectIds) quarantine.run(timestamp, projectId);
    return { taskIds: interrupted.map((task) => task.id), projectIds };
  }).immediate();
}

export function listTasks(projectId: string): Task[] {
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function abortProjectTasks(projectId: string): number {
  const r = db
    .prepare(
      `UPDATE tasks SET status = 'failed', error = 'abortado pelo usuário', updated_at = ?
       WHERE project_id = ? AND status IN ('queued', 'running')`
    )
    .run(now(), projectId);
  return r.changes;
}

// ── Eventos ─────────────────────────────────────────────────────

export function recordEvent(
  e: Omit<ForgeEvent, "id" | "ts">
): ForgeEvent {
  const ev: ForgeEvent = { ...e, id: newId("evt"), ts: now() };
  db.prepare(
    `INSERT INTO events (id, project_id, role, type, message, data, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ev.id,
    ev.project_id,
    ev.role,
    ev.type,
    ev.message,
    ev.data ? JSON.stringify(ev.data) : null,
    ev.ts
  );
  return ev;
}

export function recentEvents(limit = 50): ForgeEvent[] {
  const rows = db
    .prepare(`SELECT * FROM events ORDER BY ts DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows
    .reverse()
    .map(
      (row) =>
        ({
          ...(row as object),
          data: row.data ? JSON.parse(row.data as string) : undefined,
        }) as ForgeEvent
    );
}

// ── Tokens (precificação) ───────────────────────────────────────

export function recordTokens(
  projectId: string | null,
  role: Role,
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): void {
  db.prepare(
    `INSERT INTO token_usage (id, project_id, role, provider, model, prompt_tokens, completion_tokens, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId("tok"),
    projectId,
    role,
    provider,
    model,
    promptTokens,
    completionTokens,
    now()
  );
}

export function tokensByProject(projectId: string) {
  return db
    .prepare(
      `SELECT role, provider, model, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens
       FROM token_usage WHERE project_id = ? GROUP BY role, provider, model`
    )
    .all(projectId);
}

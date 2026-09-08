import Database from "better-sqlite3";
import path from "node:path";
import crypto from "node:crypto";
import { chmodSync } from "node:fs";
import {
  ForgeEvent,
  Handoff,
  Project,
  ProjectStatus,
  Role,
  Task,
  TaskStatus,
  BriefingInput,
  Spec,
} from "@jpxforge/shared";

/**
 * Persistência 100% SQLite local: projetos, fila de tasks, eventos (replay)
 * e uso de tokens (precificação jpxlab). Zero serviços externos.
 */

const DB_PATH = path.resolve(process.cwd(), "../../jpxforge.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// O banco guarda claimTokens (concessões do WORK) — acesso restrito.
try {
  chmodSync(DB_PATH, 0o600);
} catch {
  // Windows ignora chmod POSIX; o arquivo já nasce restrito ao usuário
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
): void {
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
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(
    ...vals
  );
}

// ── Tasks (a fila) ──────────────────────────────────────────────

export function enqueueTask(
  t: Pick<Task, "project_id" | "title" | "role"> &
    Partial<Pick<Task, "depends_on" | "payload" | "max_attempts">>
): Task {
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
  } as Task;
}

/**
 * Pega a próxima task pronta: queued, sem dependências pendentes.
 * Retorna já marcada como running (claim atômico).
 */
export function claimNextTask(): Task | null {
  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 20`
      )
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const task = rowToTask(row);
      const blocked = task.depends_on.some((depId) => {
        const dep = db
          .prepare(`SELECT status FROM tasks WHERE id = ?`)
          .get(depId) as { status: TaskStatus } | undefined;
        return !dep || dep.status !== "done";
      });
      if (blocked) continue;
      db.prepare(
        `UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`
      ).run(now(), task.id);
      return { ...task, status: "running" as TaskStatus };
    }
    return null;
  });
  return tx();
}

export function completeTask(id: string, result?: unknown): void {
  db.prepare(
    `UPDATE tasks SET status = 'done', result = ?, updated_at = ? WHERE id = ?`
  ).run(result ? JSON.stringify(result) : null, now(), id);
}

export function failTask(id: string, error: string): Task | null {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const task = rowToTask(row);
  const exhausted = task.attempts >= task.max_attempts;
  db.prepare(
    `UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?`
  ).run(exhausted ? "failed" : "queued", error, now(), id);
  return { ...task, status: exhausted ? "failed" : "queued" };
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

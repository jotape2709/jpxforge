import { ForgeConfig, Handoff, BriefingInput } from "@jpxforge/shared";
import { WorkClient, WorkConflictError, WorkRevokedError } from "./work-client.js";
import {
  confirmWorkEvent,
  createExecution,
  getActiveExecution,
  closeExecution,
  leaseExpired,
  pendingWorkEvents,
  queueWorkEvent,
  Execution,
} from "./executions.js";
import {
  abortProjectTasks,
  createProject,
  enqueueTask,
  updateProject,
} from "./db.js";
import { agentSay, emit } from "./events.js";

/**
 * WorkPoller — integração contínua com o WORK (contrato v1).
 *
 * Ciclo:
 *  1. Drena o outbox (reenvia eventos não confirmados, mesmos eventId/sequence)
 *  2. Se há execução ativa: vigia lease e revogação
 *  3. Se não há execução e auto_claim ligado: tenta retirar trabalho
 *
 * Retirou → cria projeto interno → Nina (PO) gera a Spec →
 * pipeline interna segue pelas fases seguintes. Progresso é
 * reportado ao WORK como eventos "progress"; conclusão/falha
 * como "completed"/"failed".
 */

let client: WorkClient | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let revoked = false;

export function isWorkRevoked(): boolean {
  return revoked;
}

/** Converte o brief estruturado do WORK num BriefingInput interno */
function handoffToBriefing(h: Handoff): BriefingInput {
  const raw = [
    `Título: ${h.brief.title}`,
    `Objetivo: ${h.brief.objective}`,
    h.brief.scope.length ? `Escopo:\n- ${h.brief.scope.join("\n- ")}` : "",
    h.brief.acceptanceCriteria.length
      ? `Critérios de aceite:\n- ${h.brief.acceptanceCriteria.join("\n- ")}`
      : "",
    h.brief.constraints.length
      ? `Restrições:\n- ${h.brief.constraints.join("\n- ")}`
      : "",
    h.review?.notes ? `Ajustes pedidos na revisão anterior: ${h.review.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { source: "api", raw_text: raw, lead: { niche: h.brief.domain } };
}

/** Reporta progresso ao WORK (passa pelo outbox — idempotente) */
export function reportProgress(handoffId: string, message: string): void {
  const ex = getActiveExecution();
  if (!ex || ex.handoff_id !== handoffId || ex.status !== "active") return;
  const payload = {
    claimToken: ex.claim_token,
    type: "progress",
    message,
  };
  queueWorkEvent(handoffId, payload);
}

export function reportCompleted(
  handoffId: string,
  result: {
    summary: string;
    artifacts?: { label: string; url: string }[];
    checks?: { name: string; status: "passed" | "failed" | "not_run"; details?: string }[];
    risks?: string[];
  }
): void {
  const ex = getActiveExecution();
  if (!ex || ex.handoff_id !== handoffId || ex.status !== "active") return;
  queueWorkEvent(handoffId, {
    claimToken: ex.claim_token,
    type: "completed",
    result,
  });
}

export function reportFailed(handoffId: string, message: string): void {
  const ex = getActiveExecution();
  if (!ex || ex.handoff_id !== handoffId || ex.status !== "active") return;
  queueWorkEvent(handoffId, {
    claimToken: ex.claim_token,
    type: "failed",
    message,
  });
}

async function drainOutbox(): Promise<void> {
  if (!client) return;
  for (const ev of pendingWorkEvents()) {
    const body = JSON.parse(ev.payload) as Record<string, unknown>;
    try {
      await client.sendEvent(ev.handoff_id, {
        ...body,
        eventId: ev.event_id,
        sequence: ev.sequence,
      } as never);
      confirmWorkEvent(ev.event_id);
    } catch (err) {
      if (err instanceof WorkConflictError) {
        // 409 = já recebido (reenvio) ou divergência — marca confirmado e segue
        confirmWorkEvent(ev.event_id);
      } else if (err instanceof WorkRevokedError) {
        throw err; // sobe pro tratamento de revogação
      }
      // erro de rede: fica pendente, próximo tick reenvia
    }
  }
}

async function handleActiveExecution(ex: Execution): Promise<void> {
  if (leaseExpired(ex)) {
    // Lease venceu: WORK marca needs_attention e revoga o token.
    // Nunca recolocar trabalho incerto na fila — abortar local.
    abortProjectTasks(ex.project_id);
    updateProject(ex.project_id, { status: "quarantine" });
    closeExecution(ex.handoff_id, "aborted");
    emit({
      type: "system",
      project_id: ex.project_id,
      role: null,
      message: "Lease do WORK expirado — execução abortada localmente, projeto em quarentena",
    });
  }
}

async function tryClaim(): Promise<void> {
  if (!client) return;
  const handoff = await client.claim();
  if (!handoff) return; // fila vazia — normal

  const briefing = handoffToBriefing(handoff);
  const project = createProject(briefing);
  createExecution(handoff, project.id, client.workerId);

  emit({
    type: "project.created",
    project_id: project.id,
    role: null,
    message: `Handoff "${handoff.brief.title}" retirado do WORK (tentativa ${handoff.attempt})`,
  });
  agentSay(
    "product_owner",
    project.id,
    `Chegou trabalho do WORK: "${handoff.brief.title}". Vou transformar em spec.`
  );

  enqueueTask({
    project_id: project.id,
    title: `Spec: ${handoff.brief.title}`,
    role: "product_owner",
    payload: { kind: "ingest_briefing", handoff_id: handoff.id },
  });
}

async function tick(): Promise<void> {
  if (!client || revoked) return;
  try {
    await drainOutbox();
    const active = getActiveExecution();
    if (active) {
      await handleActiveExecution(active);
    }
  } catch (err) {
    if (err instanceof WorkRevokedError) {
      revoked = true;
      const active = getActiveExecution();
      if (active) {
        abortProjectTasks(active.project_id);
        updateProject(active.project_id, { status: "aborted" });
        closeExecution(active.handoff_id, "aborted");
      }
      emit({
        type: "system",
        project_id: null,
        role: null,
        message:
          "Token do WORK revogado/cancelado — novas ações interrompidas. Verifique o WORK e rode o setup novamente se necessário.",
      });
      return;
    }
    // conflito de claim (409) ou erro de rede: espera o próximo tick
  }

  const active = getActiveExecution();
  if (!active && !revoked && client) {
    await tryClaim().catch((err) => {
      if (!(err instanceof WorkConflictError)) {
        emit({
          type: "system",
          project_id: null,
          role: null,
          message: `claim ao WORK falhou (tenta de novo no próximo ciclo): ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    });
  }
}

export function startWorkPoller(config: ForgeConfig): void {
  const w = config.work;
  if (!w?.token) {
    emit({
      type: "system",
      project_id: null,
      role: null,
      message: "WORK não configurado — integração desligada (rode npm run setup pra conectar)",
    });
    return;
  }
  if (!w.auto_claim) {
    emit({
      type: "system",
      project_id: null,
      role: null,
      message:
        "WORK configurado. auto_claim desligado (Fase 0: só status; retirada automática liga na Fase 1).",
    });
    return;
  }
  client = new WorkClient(w);
  timer = setInterval(() => {
    tick().catch(() => {});
  }, w.poll_interval_ms);
  emit({
    type: "system",
    project_id: null,
    role: null,
    message: `Poller do WORK ativo (workerId=${w.worker_id}, a cada ${w.poll_interval_ms}ms)`,
  });
}

export function stopWorkPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

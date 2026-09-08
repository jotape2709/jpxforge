import { ForgeEvent } from "@jpxforge/shared";
import { recordEvent, recentEvents } from "./db.js";

/**
 * Hub de eventos: grava tudo no SQLite (replay log) e transmite
 * ao vivo pros dashboards conectados via WebSocket.
 * O "chat da equipe" no escritório pixel art é alimentado daqui.
 */

type Listener = (ev: ForgeEvent) => void;
const listeners = new Set<Listener>();

export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(
  e: Omit<ForgeEvent, "id" | "ts">
): ForgeEvent {
  const ev = recordEvent(e);
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      // listener quebrado não derruba o barramento
    }
  }
  return ev;
}

export function history(limit = 50): ForgeEvent[] {
  return recentEvents(limit);
}

/** Atalho pra fala visível dos agentes no chat do escritório */
export function agentSay(
  role: ForgeEvent["role"],
  projectId: string | null,
  message: string,
  data?: Record<string, unknown>
): ForgeEvent {
  return emit({
    type: "agent.say",
    project_id: projectId,
    role,
    message,
    data,
  });
}

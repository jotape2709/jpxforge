import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { ForgeConfig } from "@jpxforge/shared";
import { onEvent } from "./events.js";
import { registerRoutes } from "./routes.js";
import { registerDashboard } from "./dashboard.js";

export async function createApp(config: ForgeConfig, options: { demo?: boolean } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  app.addHook("onRequest", async (request, reply) => {
    let host: URL;
    try { host = new URL(`http://${request.headers.host || "localhost"}`); }
    catch { return reply.code(400).send({ error: "Host inválido" }); }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) {
      return reply.code(403).send({ error: "Acesso disponível apenas neste computador" });
    }
    if (request.headers.origin && request.headers.origin !== host.origin) {
      return reply.code(403).send({ error: "Origem não autorizada" });
    }
  });
  await app.register(websocket);
  const sockets = new Set<{ close(): void }>();
  app.get("/events/live", { websocket: true }, socket => {
    sockets.add(socket);
    const off = onEvent(event => {
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "Cliente lento; reconecte e consulte histórico"); return; }
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    });
    socket.once("close", () => { off(); sockets.delete(socket); });
    socket.once("error", off);
  });
  app.addHook("preClose", async () => { for (const socket of sockets) socket.close(); });
  registerRoutes(app, config, options);
  registerDashboard(app);
  return app;
}

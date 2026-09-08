import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { ModelRouter } from "./model-router.js";
import { startWorker } from "./queue.js";
import { startWorkPoller } from "./work-poller.js";
import { emit, onEvent } from "./events.js";

/**
 * JPXFORGE Orchestrator — processo local que roda a fábrica.
 * Sobe a API local, o WebSocket do dashboard, o worker da fila
 * e o poller da integração WORK.
 */

async function main() {
  const config = loadConfig(); // falha cedo se setup não foi rodado
  const router = new ModelRouter(config);

  const app = Fastify({ logger: false });
  await app.register(websocket);

  // WebSocket: dashboard se conecta aqui e recebe tudo ao vivo
  app.get("/events/live", { websocket: true }, (socket) => {
    const off = onEvent((ev) => {
      try {
        socket.send(JSON.stringify(ev));
      } catch {
        off();
      }
    });
    socket.on("close", off);
  });

  registerRoutes(app, config);
  startWorker(router);
  startWorkPoller(config);

  const { port, host } = config.server;
  await app.listen({ port, host });

  emit({
    type: "system",
    project_id: null,
    role: null,
    message: `jpxforge orquestrador no ar em http://${host}:${port}`,
  });

  console.log("");
  console.log("  ▓▓▓ JPXFORGE ▓▓▓");
  console.log(`  API local:   http://${host}:${port}`);
  console.log(`  WebSocket:   ws://${host}:${port}/events/live`);
  console.log(`  Health:      http://${host}:${port}/health`);
  console.log("");
  console.log("  Envie um briefing:");
  console.log(`  curl -X POST http://${host}:${port}/briefings \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"source":"manual","raw_text":"..."}'`);
  console.log("");
}

main().catch((err) => {
  console.error("Falha ao subir o orquestrador:", err.message ?? err);
  process.exit(1);
});

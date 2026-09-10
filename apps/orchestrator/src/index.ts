import path from "node:path";
import { fileURLToPath } from "node:url";

const demo = process.argv.includes("--demo");
if (demo) process.env.FORGE_DATA_DIR ||= path.join(fileURLToPath(new URL("../../../", import.meta.url)), ".forge-demo");

async function main() {
  const [{ loadConfig }, { ForgeConfigSchema }, { ModelRouter }, { DemoRouter }, { createApp }, queue, work, events] = await Promise.all([
    import("./config.js"), import("@jpxforge/shared"), import("./model-router.js"), import("./demo-router.js"),
    import("./server.js"), import("./queue.js"), import("./work-poller.js"), import("./events.js"),
  ]);
  const config = demo ? ForgeConfigSchema.parse({ version: 1, providers: {}, roles: {} }) : loadConfig();
  const router = demo ? new DemoRouter() : new ModelRouter(config);
  const app = await createApp(config, { demo });
  const off = events.onEvent(event => console.log(`[${event.ts}] [${event.type}] ${event.message}`));
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    await work.stopWorkPoller();
    await queue.stopWorker();
    await app.close();
    off();
    (await import("./db.js")).db.close();
  }
  try {
    if (config.work.auto_claim) throw new Error("auto_claim ainda indisponível: conclua o piloto WORK descrito em docs/BACKLOG.md.");
    await app.listen(config.server);
    work.startWorkPoller(config);
    queue.startWorker(router);
    process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    console.log(`JPXFORGE em http://${config.server.host}:${config.server.port}${demo ? " | DEMONSTRAÇÃO: respostas simuladas, sem gastos de API" : ""}`);
  } catch (error) { await shutdown(); throw error; }
}

main().catch(error => { console.error("Falha ao iniciar:", error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

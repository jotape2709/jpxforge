import path from "node:path";
import { fileURLToPath } from "node:url";

// Select an isolated database BEFORE loading any database-dependent module.
process.env.FORGE_DATA_DIR ||= path.join(fileURLToPath(new URL("../../../", import.meta.url)), ".forge-demo");
const { DemoRouter } = await import("./demo-router.js");
const { createProject, enqueueTask, getProject, listTasks, db } = await import("./db.js");
const { runNextTask } = await import("./queue.js");
const { onEvent } = await import("./events.js");
const { dataPath } = await import("./paths.js");
const off = onEvent(event => console.log(`[${event.type}] ${event.message}`));
try {
  console.log("JPXFORGE DEMO: respostas simuladas; sem API paga ou envio ao GitHub.");
  const project = createProject({ source: "manual", raw_text: "Uma landing page de demonstração para o estúdio fictício Aurora, com apresentação, serviços e contato." });
  enqueueTask({ project_id: project.id, title: "Organizar briefing", role: "product_owner", payload: { kind: "ingest_briefing" } });
  const router = new DemoRouter();
  for (let tick = 0; tick < 15 && await runNextTask(router); tick++) { /* finite local demo */ }
  const tasks = listTasks(project.id);
  const final = getProject(project.id)!;
  if (final.status !== "review" || tasks.length !== 5 || tasks.some(task => task.status !== "done")) {
    throw new Error(`Demo incompleta: ${final.status}, ${tasks.filter(t => t.status === "done").length}/${tasks.length} tarefas concluídas`);
  }
  console.log(JSON.stringify({ project_id: project.id, status: final.status, tasks: tasks.length, workspace: dataPath("workspaces", project.id), publish: tasks.find(t => t.payload.kind === "publish_landing")?.result }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { off(); db.close(); }

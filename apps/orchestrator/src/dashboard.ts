import { readFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { getProject, listTasks } from "./db.js";
import { dataPath } from "./paths.js";

const assets = fileURLToPath(new URL("../public/", import.meta.url));
const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'";

export function registerDashboard(app: FastifyInstance) {
  for (const [url, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/dashboard.css", "dashboard.css", "text/css; charset=utf-8"],
    ["/dashboard.js", "dashboard.js", "text/javascript; charset=utf-8"],
    ["/office.js", "office.js", "text/javascript; charset=utf-8"],
  ]) {
    app.get(url, async (_request, reply) => reply.header("Content-Security-Policy", policy)
      .header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store")
      .type(type).send(readFileSync(path.join(assets, file))));
  }
  app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());
  // Only validated build outputs; never expose arbitrary files, SQLite or config.
  app.get("/preview/:id/:file", async (request, reply) => {
    const { id, file } = request.params as { id: string; file: string };
    if (!/^prj_[a-f0-9]{12}$/.test(id) || !["index.html", "styles.css"].includes(file)) return reply.code(404).send({ error: "Prévia não encontrada" });
    const project = getProject(id);
    const tasks = listTasks(id);
    if (!project || !["review", "shipped"].includes(project.status) || !tasks.some(task => task.payload.kind === "qa_landing" && task.status === "done")) {
      return reply.code(409).send({ error: "Prévia disponível após aprovação do QA" });
    }
    const root = path.resolve(dataPath("workspaces"));
    const parts = [root, path.join(root, id), path.join(root, id, "dist"), path.join(root, id, "dist", file)];
    try {
      for (let index = 0; index < parts.length; index++) {
        const stat = lstatSync(parts[index]);
        if (stat.isSymbolicLink() || (index < 3 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 400000)) throw new Error("Unsafe preview");
        if (index && path.dirname(realpathSync(parts[index])) !== realpathSync(parts[index - 1])) throw new Error("Preview redirected");
      }
      return reply.header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
        .header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store")
        .type(file.endsWith(".html") ? "text/html; charset=utf-8" : "text/css; charset=utf-8").send(readFileSync(parts[3]));
    } catch { return reply.code(404).send({ error: "Prévia indisponível; execute QA novamente" }); }
  });
}

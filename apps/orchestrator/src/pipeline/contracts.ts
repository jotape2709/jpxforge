import { z } from "zod";
import type { ModelRouter } from "../model-router.js";

export type PipelineRouter = Pick<ModelRouter, "chat">;

export class PipelineSafetyError extends Error {
  override name = "PipelineSafetyError";
}

const PlannedTaskSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  title: z.string().min(3).max(180),
  kind: z.enum(["build_landing", "qa_landing", "publish_landing"]),
  depends_on: z.array(z.string()).max(2),
}).strict();

export const LandingPlanSchema = z.object({
  tasks: z.array(PlannedTaskSchema).length(3),
}).strict().superRefine(({ tasks }, ctx) => {
  const [build, qa, publish] = tasks;
  if (new Set(tasks.map(t => t.key)).size !== 3 ||
      build.kind !== "build_landing" || build.depends_on.length !== 0 ||
      qa.kind !== "qa_landing" || qa.depends_on.length !== 1 || qa.depends_on[0] !== build.key ||
      publish.kind !== "publish_landing" || publish.depends_on.length !== 1 || publish.depends_on[0] !== qa.key) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Plano deve seguir build -> QA -> publicação, sem ciclos nem tarefas extras" });
  }
});
export type LandingPlan = z.infer<typeof LandingPlanSchema>;

export const LandingContentSchema = z.object({
  title: z.string().min(3).max(180),
  body: z.string().min(30).max(150_000),
  css: z.string().min(10).max(100_000),
}).strict();
export type LandingContent = z.infer<typeof LandingContentSchema>;

export function parseModelJson(content: string): unknown {
  if (Buffer.byteLength(content, "utf8") > 300_000) throw new PipelineSafetyError("Resposta do modelo excede 300 KB");
  try { return JSON.parse(content); }
  catch { throw new PipelineSafetyError("Modelo retornou JSON inválido; revise a execução antes de tentar novamente."); }
}

/** Parser diagnostics can quote model data; persist only application-owned text. */
export function parseModelOutput<S extends z.ZodTypeAny>(schema: S, content: string): z.infer<S> {
  const result = schema.safeParse(parseModelJson(content));
  if (!result.success) throw new PipelineSafetyError("Resposta do modelo não atende ao contrato desta etapa.");
  return result.data;
}

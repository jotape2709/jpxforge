import path from "node:path";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dataPath } from "../paths.js";
import { PipelineSafetyError, type LandingContent } from "./contracts.js";

// Executables belong to Forge. The model can only provide static content.
export const BUILD_SCRIPT = `import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const file of ['index.html', 'styles.css']) copyFileSync(file, 'dist/' + file);
console.log('Build estático concluído: dist/index.html');
`;
export const TEST_SCRIPT = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
const html = readFileSync('dist/index.html', 'utf8');
const css = readFileSync('dist/styles.css', 'utf8');
test('build preserva os arquivos validados', () => {
  assert.equal(html, readFileSync('index.html', 'utf8'));
  assert.equal(css, readFileSync('styles.css', 'utf8'));
});
test('documento tem idioma, viewport, título e conteúdo principal', () => {
  assert.match(html, /<html lang="pt-BR">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<title>[^<]+<\\/title>/);
  assert.match(html, /<main(?:\\s|>)/);
  assert.equal((html.match(/<h1(?:\\s|>)/g) || []).length, 1);
});
test('página tem CTA e CSS, sem conteúdo executável', () => {
  assert.match(html, /<a\\s[^>]*href="(?:#|https:\\/\\/|mailto:|tel:)/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<(?:script|iframe|object|embed|form|svg)\\b/i);
  assert.ok(css.trim().length >= 10);
});
`;
export const PACKAGE_JSON = JSON.stringify({
  name: "forge-landing", version: "1.0.0", private: true, type: "module",
  scripts: { build: "node scripts/build.mjs", test: "node --test test/landing.test.mjs" },
}, null, 2) + "\n";
const FIXED_FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON, "scripts/build.mjs": BUILD_SCRIPT,
  "test/landing.test.mjs": TEST_SCRIPT, ".gitignore": "dist/\nqa-report.json\n",
};
const ARTIFACT_FILES = ["index.html", "styles.css", ...Object.keys(FIXED_FILES)];
const ALLOWED_TAGS = new Set("main header footer nav section article aside div span h1 h2 h3 h4 h5 h6 p a ul ol li strong em small br hr blockquote figure figcaption details summary".split(" "));
const VOID_TAGS = new Set(["br", "hr"]);
const ATTRIBUTES = new Set(["class", "id", "title", "role", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden"]);
const CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "clamp", "min", "max", "calc", "var", "linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeat", "minmax", "fit-content"]);
function reject(message: string): never { throw new PipelineSafetyError(message); }
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_whole, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
    if (!entity.startsWith("#")) return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    if (code <= 0 || code > 0x10ffff) reject("Entidade HTML inválida");
    return String.fromCodePoint(code);
  });
}

/** Strict static subset: reject unfamiliar syntax instead of repairing it. */
export function validateLanding(content: LandingContent): void {
  const { body, css } = content;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body + css)) reject("Conteúdo contém controles inválidos");
  const stack: string[] = [], anchors: string[] = [];
  const ids = new Set<string>();
  let main = 0, h1 = 0, links = 0, offset = 0;
  for (const match of body.matchAll(/<\/?[a-z][^<>]*>/g)) {
    if (body.slice(offset, match.index).includes("<")) reject("Marcação HTML não permitida");
    offset = match.index! + match[0].length;
    const closing = /^<\/([a-z][a-z0-9]*)\s*>$/.exec(match[0]);
    if (closing) {
      if (!ALLOWED_TAGS.has(closing[1]) || VOID_TAGS.has(closing[1]) || stack.pop() !== closing[1]) reject("Tags HTML desbalanceadas");
      continue;
    }
    const opening = /^<([a-z][a-z0-9]*)([\s\S]*?)\s*\/?\s*>$/.exec(match[0]);
    if (!opening || !ALLOWED_TAGS.has(opening[1])) reject("Tag HTML fora da lista permitida");
    const tag = opening[1];
    if (tag === "main") main++;
    if (tag === "h1") h1++;
    if (!VOID_TAGS.has(tag)) {
      if (/\/\s*>$/.test(match[0])) reject("Somente br e hr podem ser auto-fechados");
      stack.push(tag);
    }
    let rest = opening[2];
    const names = new Set<string>();
    while (rest.trim()) {
      const attr = /^\s+([a-z][a-z0-9-]*)="([^"<>]*)"/.exec(rest);
      if (!attr) reject("Atributos devem usar sintaxe simples com aspas duplas");
      rest = rest.slice(attr[0].length);
      const name = attr[1], value = decodeAttribute(attr[2]);
      if (names.has(name) || (!ATTRIBUTES.has(name) && !(tag === "a" && name === "href"))) reject("Atributo HTML não permitido ou duplicado");
      names.add(name);
      if (/[\u0000-\u001f\u007f<>]/.test(value)) reject("Valor de atributo inválido");
      if (name === "id") {
        if (!/^[a-zA-Z][\w-]{0,99}$/.test(value) || ids.has(value)) reject("ID HTML inválido ou duplicado");
        ids.add(value);
      }
      if (name === "href") {
        if (/^#[a-zA-Z][\w-]{0,99}$/.test(value)) anchors.push(value.slice(1));
        else if (value.startsWith("https://")) {
          let url: URL;
          try { url = new URL(value); } catch { reject("URL de CTA inválida"); }
          if (url!.username || url!.password || !url!.hostname || /[\s\\]/.test(value)) reject("URL de CTA inválida");
        } else if (!/^mailto:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value) && !/^tel:\+?[0-9() -]{5,30}$/.test(value)) reject("Destino de link não permitido");
        links++;
      }
    }
  }
  if (body.slice(offset).includes("<") || stack.length) reject("HTML incompleto ou marcação não permitida");
  if (main !== 1 || h1 !== 1 || links < 1) reject("Landing exige exatamente um main, um h1 e ao menos um CTA");
  if (anchors.some(anchor => !ids.has(anchor))) reject("CTA aponta para seção inexistente");
  if (/[@\\<>]|\/\*|\*\/|\b(?:expression|binding|behavior)\b/i.test(css)) reject("CSS contém recurso não permitido");
  for (const match of css.matchAll(/([a-z-]+)\s*\(/gi)) {
    if (!CSS_FUNCTIONS.has(match[1].toLowerCase())) reject("Função CSS não permitida");
  }
  if (css.split("{").length !== css.split("}").length || !css.includes("{")) reject("CSS incompleto");
}

function checkEntry(location: string, directory: boolean): void {
  const entry = lstatSync(location, { throwIfNoEntry: false });
  if (!entry) return;
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()) || (!directory && entry.nlink !== 1)) reject("Workspace contém link ou tipo de arquivo não permitido");
}
export function workspacePath(projectId: string): string {
  if (!/^prj_[a-f0-9]{12}$/.test(projectId)) reject("ID de projeto inválido para workspace");
  const root = path.resolve(dataPath("workspaces")), workspace = path.resolve(root, projectId);
  if (path.dirname(workspace) !== root) reject("Workspace fora do diretório de projetos");
  checkEntry(root, true);
  mkdirSync(root, { recursive: true });
  checkEntry(workspace, true);
  mkdirSync(workspace, { recursive: true });
  if (path.dirname(realpathSync(workspace)) !== realpathSync(root)) reject("Workspace redirecionado");
  return workspace;
}
function safeFile(workspace: string, relative: string): string {
  const destination = path.resolve(workspace, relative);
  if (!destination.startsWith(workspace + path.sep)) reject("Arquivo fora do workspace");
  let directory = workspace;
  for (const part of relative.split("/").slice(0, -1)) {
    directory = path.join(directory, part);
    checkEntry(directory, true);
    mkdirSync(directory, { recursive: true });
  }
  checkEntry(destination, false);
  return destination;
}
function checkTree(directory: string, prefix = "", budget = { left: 5000 }): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (--budget.left < 0) reject("Workspace excede o limite de arquivos");
    const location = path.join(directory, entry.name), relative = prefix + entry.name;
    if (entry.isSymbolicLink()) reject("Links não são permitidos no workspace");
    if (entry.isDirectory()) {
      if (!relative.startsWith(".git/") && ![".git", "scripts", "test", "dist"].includes(relative)) reject("Diretório inesperado no workspace");
      checkTree(location, relative + "/", budget);
    } else {
      checkEntry(location, false);
      if (!relative.startsWith(".git/") && ![...ARTIFACT_FILES, "dist/index.html", "dist/styles.css", "qa-report.json"].includes(relative)) reject("Arquivo inesperado no workspace");
    }
  }
}
const head = (title: string) => `<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'">\n<title>${title}</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n`;
export function writeLanding(projectId: string, content: LandingContent): { workspace: string; files: string[] } {
  validateLanding(content);
  const workspace = workspacePath(projectId);
  checkTree(workspace);
  const html = head(escapeHtml(content.title)) + content.body + "\n</body>\n</html>\n";
  for (const [file, source] of Object.entries({ ...FIXED_FILES, "index.html": html, "styles.css": content.css })) {
    writeFileSync(safeFile(workspace, file), source, { encoding: "utf8", mode: 0o600 });
  }
  return { workspace, files: [...ARTIFACT_FILES] };
}
function inspectWorkspace(projectId: string): string {
  const workspace = workspacePath(projectId);
  checkTree(workspace);
  for (const [file, expected] of Object.entries(FIXED_FILES)) {
    if (readFileSync(safeFile(workspace, file), "utf8") !== expected) reject("Template executável ou manifesto foi alterado");
  }
  const html = readFileSync(safeFile(workspace, "index.html"), "utf8");
  const body = /\n<body>\n([\s\S]*)\n<\/body>\n<\/html>\n$/.exec(html)?.[1];
  const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
  if (!body || !title) reject("Documento do workspace inválido");
  validateLanding({ title: title!, body: body!, css: readFileSync(safeFile(workspace, "styles.css"), "utf8") });
  if (!html.startsWith(head(title!))) reject("Cabeçalho ou CSP do documento foi alterado");
  checkEntry(path.join(workspace, "dist"), true);
  for (const file of ["dist/index.html", "dist/styles.css"]) safeFile(workspace, file);
  return workspace;
}
function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|GIT_.*|.*(?:API_KEY|TOKEN|SECRET|PASSWORD))$/i.test(key)) delete environment[key];
  }
  return { ...environment, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}
async function command(executable: string, args: string[], workspace: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, rejectPromise) => {
    let output = "";
    const child = spawn(executable, args, { cwd: workspace, env: cleanEnvironment(), windowsHide: true, shell: false, signal, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill(), 60_000);
    const collect = (chunk: Buffer) => { if (output.length < 60_000) output += chunk.toString("utf8").slice(0, 60_000 - output.length); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", error => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (signal?.aborted) return rejectPromise(signal.reason);
      if (code !== 0) return rejectPromise(new Error(`Comando confiável falhou (${code ?? "interrompido"}): ${output.slice(-4000)}`));
      resolve(output);
    });
  });
}
export async function qaLanding(projectId: string, signal?: AbortSignal) {
  const workspace = inspectWorkspace(projectId);
  const build = await command(process.execPath, ["scripts/build.mjs"], workspace, signal);
  inspectWorkspace(projectId);
  const tests = await command(process.execPath, ["--test", "test/landing.test.mjs"], workspace, signal);
  signal?.throwIfAborted();
  const report = { passed: true, checks: [{ name: "build", status: "passed", details: build.trim() }, { name: "node:test", status: "passed", details: tests.trim() }], checked_at: new Date().toISOString() };
  writeFileSync(safeFile(workspace, "qa-report.json"), JSON.stringify(report, null, 2) + "\n");
  return { workspace, ...report };
}
export interface PublishOptions { remote: string; branch?: string }
export function validatePublishOptions(options: PublishOptions, projectId: string): { remote: string; branch: string } {
  const branch = options.branch ?? `joao2709/forge-${projectId}`;
  if (!/^(?:joao2709|forge)\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,149}$/.test(branch) || /\.\.|\/\/|\.$|\/$|\.lock(?:\/|$)/.test(branch) || branch.split("/").some(p => /^(?:main|master|production|prod)$/i.test(p))) reject("Publicação exige branch de desenvolvimento joao2709/ ou forge/");
  const remote = options.remote;
  if (typeof remote !== "string" || !remote || /[\u0000-\u0020\u007f]/.test(remote)) reject("Remoto de publicação inválido");
  if (remote.startsWith("https://")) {
    let url: URL;
    try { url = new URL(remote); } catch { reject("URL remota inválida"); }
    if (url!.username || url!.password || url!.search || url!.hash || !url!.hostname || /\\/.test(remote)) reject("Remoto não pode incluir credenciais, query ou fragmento");
  } else if (!path.isAbsolute(remote) || remote.startsWith("\\\\") || remote.startsWith("//")) reject("Use remoto HTTPS sem credenciais ou caminho local absoluto");
  return { remote, branch };
}
export async function publishLanding(projectId: string, publish?: PublishOptions, signal?: AbortSignal) {
  const target = publish ? validatePublishOptions(publish, projectId) : undefined;
  const workspace = inspectWorkspace(projectId);
  const report = JSON.parse(readFileSync(safeFile(workspace, "qa-report.json"), "utf8")) as { passed?: boolean };
  if (report.passed !== true) reject("Entrega exige QA aprovado");
  // Recheck current content because files might change between tasks.
  await qaLanding(projectId, signal);
  const gitArgs = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=always"];
  const git = (args: string[]) => command("git", [...gitArgs, ...args], workspace, signal);
  if (!lstatSync(path.join(workspace, ".git"), { throwIfNoEntry: false })) await git(["init", "--initial-branch=forge/local"]);
  const branch = target?.branch ?? "forge/local";
  await git(["checkout", "-B", branch]);
  await git(["add", "--", ...ARTIFACT_FILES]);
  const staged = await git(["diff", "--cached", "--name-only"]);
  if (staged.trim()) await git(["-c", "user.name=JPXFORGE", "-c", "user.email=forge@localhost", "commit", "-m", "Build validated static landing page"]);
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) reject("Commit Git inválido");
  if (target) await git(["push", "--porcelain", "--", target.remote, `HEAD:refs/heads/${target.branch}`]);
  return { workspace, commit, branch, published: Boolean(target), ...(target ? { remote: target.remote } : {}) };
}

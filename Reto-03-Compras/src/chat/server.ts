import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { safePath } from "../paths.ts";
import { leer_paquete, validar, construir_payload, generar_evidencia, crear } from "../tools/oc.ts";
import type { Paquete, Validacion } from "../types.ts";
import type { LlmAdapter } from "../llm/adapter.ts";
import { SimulatedLlmAdapter } from "../llm/mock.ts";

type Call = { id: string; name: string; arguments: Record<string, unknown>; result: string; status: "ok" | "blocked" | "pending" };
type Pending = { operationId: string; caso: string; paquete: Paquete; validacion: Validacion; payload: unknown };
type ChatMessage = { role: "user" | "assistant"; content: string; ts: string };
type Session = { id: string; messages: ChatMessage[]; toolCalls: Call[]; pending?: Pending };
type AppOptions = { directory?: string; adapter?: LlmAdapter };

const BodySchema = z.object({ sessionId: z.string().uuid().optional(), message: z.string().trim().min(1).max(1000) }).strict();
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const sessions = new Map<string, Session>();
const command = /\b(sol-00[1-6])\b/i;
const affirmative = /^(confirmo|confirmar|sí,? confirmo|si,? confirmo)$/i;

export function createChatServer(options: AppOptions = {}): Server {
  const directory = path.resolve(options.directory ?? rootDefault);
  const adapter = options.adapter ?? new SimulatedLlmAdapter();
  return createServer((req, res) => {
    void route(req, res, directory, adapter).catch(() => {
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, 500, { error: "No se pudo completar la solicitud. Intenta de nuevo." });
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, directory: string, adapter: LlmAdapter): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true, provider: adapter.provider, model: adapter.model });
  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.slice("/api/sessions/".length);
    if (!z.string().uuid().safeParse(id).success) return sendJson(res, 400, { error: "Identificador de sesión inválido." });
    const session = sessions.get(id);
    return session ? sendJson(res, 200, publicSession(session)) : sendJson(res, 404, { error: "No se encontró la sesión." });
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body: unknown;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: "No se pudo leer el mensaje." }); }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) return sendJson(res, 400, { error: "Envía un mensaje y, si aplica, un sessionId válido." });
    const session = parsed.data.sessionId ? sessions.get(parsed.data.sessionId) : undefined;
    if (parsed.data.sessionId && !session) return sendJson(res, 404, { error: "No se encontró la sesión." });
    const active = session ?? createSession();
    const message = parsed.data.message;
    active.messages.push({ role: "user", content: message, ts: new Date().toISOString() });
    const response = await handleMessage(active, message, directory, adapter);
    active.messages.push({ role: "assistant", content: response.reply, ts: new Date().toISOString() });
    return sendJson(res, 200, { sessionId: active.id, reply: response.reply, toolCalls: response.calls, needsConfirmation: Boolean(active.pending), pending: active.pending ? { case: active.pending.caso, operationId: active.pending.operationId } : null });
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/app.js" || url.pathname === "/style.css")) {
    const filename = url.pathname === "/app.js" ? "app.js" : url.pathname === "/style.css" ? "style.css" : "index.html";
    const mime = filename.endsWith(".js") ? "text/javascript; charset=utf-8" : filename.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
    try { res.writeHead(200, { "content-type": mime, "x-content-type-options": "nosniff" }); res.end(await readFile(safePath(directory, "web", filename))); } catch { res.writeHead(404).end("No encontrado"); }
    return;
  }
  sendJson(res, 404, { error: "Ruta no encontrada." });
}

function createSession(): Session { const id = randomUUID(); const session = { id, messages: [], toolCalls: [] }; sessions.set(id, session); return session; }

async function handleMessage(session: Session, message: string, directory: string, adapter: LlmAdapter): Promise<{ reply: string; calls: Call[] }> {
  const calls: Call[] = [];
  const context = { directory, sessionId: session.id };
  if (session.pending && affirmative.test(message)) {
    const pending = session.pending;
    session.pending = undefined;
    const result = await invoke("oc_crear", { caso: pending.caso, paquete: pending.paquete, validacion: pending.validacion, payload: pending.payload, confirmado: true }, context);
    const created = nestedData<{ ok: boolean; numero_oc?: string; error?: string }>(result);
    const call = makeCall("oc_crear", { caso: pending.caso, operationId: pending.operationId }, created.ok && created.data?.ok ? `OC ${created.data.numero_oc} creada` : created.data?.error ?? "No fue posible crear la orden", created.ok && created.data?.ok ? "ok" : "blocked");
    await record(directory, session, call); calls.push(call);
    const text = created.ok && created.data?.ok ? `Confirmación aceptada para ${pending.caso} y operación ${pending.operationId}. Se creó la OC ${created.data.numero_oc}.` : `La solicitud ${pending.caso} no se creó: ${created.data?.error ?? "error interno"}.`;
    return { reply: (await adapter.respond({ userMessage: message, toolSummaries: calls.map(x => x.result), outcome: { kind: created.ok && created.data?.ok ? "created" : "blocked", caso: pending.caso, message: text } })).text, calls };
  }
  if (session.pending) {
    const text = `La operación ${session.pending.operationId} de ${session.pending.caso} sigue pendiente. Para autorizarla, responde “Confirmo”; cualquier otro mensaje no la ejecuta.`;
    return { reply: (await adapter.respond({ userMessage: message, toolSummaries: [], outcome: { kind: "awaiting_confirmation", caso: session.pending.caso, message: text } })).text, calls };
  }
  const match = message.match(command);
  if (!match) {
    const text = "Indica una solicitud para procesar, por ejemplo: «Procesa sol-001». También puedes usar una sesión nueva desde el botón correspondiente.";
    return { reply: (await adapter.respond({ userMessage: message, toolSummaries: [], outcome: { kind: "ready", message: text } })).text, calls };
  }
  const caso = match[1].toLowerCase();
  const read = nestedData<{ paquete: Paquete }>(await invoke("oc_leer_paquete", { caso }, context));
  calls.push(await record(directory, session, makeCall("oc_leer_paquete", { caso }, read.ok ? "Paquete local leído y normalizado" : "No se pudo leer el paquete", read.ok ? "ok" : "blocked")));
  if (!read.ok || !read.data?.paquete) return { reply: "No pude leer ese paquete. Revisa que el caso exista y que sus archivos estén completos.", calls };
  const paquete = read.data.paquete;
  const checked = nestedData<Validacion>(await invoke("oc_validar", { caso, paquete }, context));
  if (!checked.ok || !checked.data) return { reply: "No fue posible completar las validaciones del caso.", calls };
  const validacion = checked.data;
  calls.push(await record(directory, session, makeCall("oc_validar", { caso }, `${validacion.bloqueos.length} bloqueo(s), ${validacion.confirmaciones.length} confirmación(es)`, !validacion.apta ? "blocked" : validacion.confirmaciones.length ? "pending" : "ok")));
  if (!validacion.apta) {
    const blocked = nestedData<{ ok: boolean; error?: string }>(await invoke("oc_crear", { caso, paquete, validacion, payload: {} }, context));
    calls.push(await record(directory, session, makeCall("oc_crear", { caso }, blocked.data?.error ?? "Creación bloqueada por reglas de control", "blocked")));
    const text = `No se creó la orden para ${caso}. Bloqueos: ${validacion.bloqueos.join("; ")}.`;
    return { reply: (await adapter.respond({ userMessage: message, toolSummaries: calls.map(x => x.result), outcome: { kind: "blocked", caso, message: text } })).text, calls };
  }
  const evidence = nestedData<{ ruta: string; sha256: string }>(await invoke("oc_generar_evidencia", { caso }, context));
  calls.push(await record(directory, session, makeCall("oc_generar_evidencia", { caso }, evidence.ok ? "Evidencia de aprobación generada en out/" : "No se pudo generar la evidencia", evidence.ok ? "ok" : "blocked")));
  if (!evidence.ok || !evidence.data) return { reply: "No se pudo preparar la evidencia de aprobación; no se creó la orden.", calls };
  const built = nestedData<{ payload: unknown }>(await invoke("oc_construir_payload", { caso, paquete, derivados: validacion.derivados, evidencia_sha256: evidence.data.sha256 }, context));
  calls.push(await record(directory, session, makeCall("oc_construir_payload", { caso }, built.ok ? "Payload construido y validado localmente" : "Payload no válido", built.ok ? "ok" : "blocked")));
  if (!built.ok || !built.data?.payload) return { reply: "No se pudo preparar un payload válido; no se creó la orden.", calls };
  if (validacion.confirmaciones.length) {
    const operationId = randomUUID();
    session.pending = { operationId, caso, paquete, validacion, payload: built.data.payload };
    const details = validacion.confirmaciones.map(c => `${c.codigo}: ${c.detalle}`).join("; ");
    const text = `El caso ${caso} está validado, pero requiere confirmación: ${details}. Para crear la OC, responde “Confirmo”. Operación pendiente ${operationId}.`;
    return { reply: (await adapter.respond({ userMessage: message, toolSummaries: calls.map(x => x.result), outcome: { kind: "awaiting_confirmation", caso, message: text } })).text, calls };
  }
  const created = nestedData<{ ok: boolean; numero_oc?: string; error?: string }>(await invoke("oc_crear", { caso, paquete, validacion, payload: built.data.payload }, context));
  calls.push(await record(directory, session, makeCall("oc_crear", { caso }, created.data?.numero_oc ? `OC ${created.data.numero_oc} creada` : created.data?.error ?? "No se creó la OC", created.data?.ok ? "ok" : "blocked")));
  const text = created.data?.ok ? `Solicitud ${caso} procesada correctamente. Se creó la OC ${created.data.numero_oc}.` : `No se creó la orden de ${caso}.`;
  return { reply: (await adapter.respond({ userMessage: message, toolSummaries: calls.map(x => x.result), outcome: { kind: created.data?.ok ? "created" : "blocked", caso, message: text } })).text, calls };
}

async function invoke(name: string, args: Record<string, unknown>, context: { directory: string; sessionId: string }): Promise<unknown> {
  const tools: Record<string, { execute: (a: never, c: typeof context) => Promise<string> }> = { oc_leer_paquete: leer_paquete as never, oc_validar: validar as never, oc_construir_payload: construir_payload as never, oc_generar_evidencia: generar_evidencia as never, oc_crear: crear as never };
  const tool = tools[name]; if (!tool) return { ok: false, error: "Herramienta no disponible" };
  return JSON.parse(await tool.execute(args as never, context));
}
function nestedData<T>(value: unknown): { ok: boolean; data?: T } {
  if (!value || typeof value !== "object") return { ok: false };
  const outer = value as { ok?: boolean; data?: unknown };
  if (!outer.ok || !outer.data || typeof outer.data !== "object") return { ok: false };
  return { ok: true, data: outer.data as T };
}
function makeCall(name: string, args: Record<string, unknown>, result: string, status: Call["status"]): Call { return { id: randomUUID(), name, arguments: args, result, status }; }
async function record(directory: string, session: Session, call: Call): Promise<Call> {
  session.toolCalls.push(call);
  const file = safePath(directory, "out", "log.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ sessionId: session.id, call })}\n`, "utf8");
  return call;
}
function publicSession(session: Session) { return { sessionId: session.id, messages: session.messages, toolCalls: session.toolCalls, needsConfirmation: Boolean(session.pending), pending: session.pending ? { case: session.pending.caso, operationId: session.pending.operationId } : null }; }
async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 16_384) throw new Error("body demasiado largo"); }
  return JSON.parse(raw);
}
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, jsonHeaders); res.end(JSON.stringify(body)); }

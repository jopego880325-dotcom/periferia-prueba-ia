import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { safePath } from "../paths.ts";
import { leer_paquete, validar, construir_payload, generar_evidencia, crear } from "../tools/oc.ts";
import type { Paquete, Validacion } from "../types.ts";
import type { LlmAdapter } from "../llm/adapter.ts";
import { SimulatedLlmAdapter } from "../llm/mock.ts";
import { OllamaAdapter } from "../llm/ollama.ts";
import { ollamaToolDefinitions, registeredTools, type RegisteredToolName } from "../llm/tools.ts";
import type { LlmMessage } from "../llm/adapter.ts";

type Call = { id: string; name: string; arguments: Record<string, unknown>; result: string; status: "ok" | "blocked" | "pending" };
type Pending = { operationId: string; caso: string; paquete: Paquete; validacion: Validacion; payload: unknown; payloadHash: string };
type ChatMessage = { role: "user" | "assistant"; content: string; ts: string };
type Session = { id: string; messages: ChatMessage[]; toolCalls: Call[]; llmMessages: LlmMessage[]; pending?: Pending };
type AppOptions = { directory?: string; adapter?: LlmAdapter };
type AgentState = { caso: string; paquete?: Paquete; validacion?: Validacion; evidenciaSha256?: string; payload?: unknown; createdNumber?: string; pendingRequest: boolean; createAttempted: boolean };

const BodySchema = z.object({ sessionId: z.string().uuid().optional(), message: z.string().trim().min(1).max(1000) }).strict();
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const sessions = new Map<string, Session>();
const command = /\b(sol-00[1-6])\b/i;
const affirmative = /^(confirmo|confirmar|sí,? confirmo|si,? confirmo)$/i;

export function createChatServer(options: AppOptions = {}): Server {
  const directory = path.resolve(options.directory ?? rootDefault);
  const adapter = options.adapter ?? (process.env.LLM_ADAPTER === "mock" ? new SimulatedLlmAdapter() : new OllamaAdapter());
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

function createSession(): Session { const id = randomUUID(); const session = { id, messages: [], toolCalls: [], llmMessages: [] }; sessions.set(id, session); return session; }

async function handleMessage(session: Session, message: string, directory: string, adapter: LlmAdapter): Promise<{ reply: string; calls: Call[] }> {
  if (adapter.chatWithTools) return handleOllamaMessage(session, message, directory, adapter);
  const calls: Call[] = [];
  const context = { directory, sessionId: session.id };
  if (session.pending && affirmative.test(message)) {
    const pending = session.pending;
    if (hashPayload(pending.payload) !== pending.payloadHash) { session.pending = undefined; return { reply: "La operación pendiente ya no coincide con su payload; no se creó la orden.", calls }; }
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
    session.pending = { operationId, caso, paquete, validacion, payload: built.data.payload, payloadHash: hashPayload(built.data.payload) };
    const details = validacion.confirmaciones.map(c => `${c.codigo}: ${c.detalle}`).join("; ");
    const text = `El caso ${caso} está validado, pero requiere confirmación: ${details}. Para crear la OC, responde “Confirmo”. Operación pendiente ${operationId}.`;
    return { reply: (await adapter.respond({ userMessage: message, toolSummaries: calls.map(x => x.result), outcome: { kind: "awaiting_confirmation", caso, message: text } })).text, calls };
  }
  const created = nestedData<{ ok: boolean; numero_oc?: string; error?: string }>(await invoke("oc_crear", { caso, paquete, validacion, payload: built.data.payload }, context));
  calls.push(await record(directory, session, makeCall("oc_crear", { caso }, created.data?.numero_oc ? `OC ${created.data.numero_oc} creada` : created.data?.error ?? "No se creó la OC", created.data?.ok ? "ok" : "blocked")));
  const text = created.data?.ok ? `Solicitud ${caso} procesada correctamente. Se creó la OC ${created.data.numero_oc}.` : `No se creó la orden de ${caso}.`;
  return { reply: (await adapter.respond({ userMessage: message, toolSummaries: calls.map(x => x.result), outcome: { kind: created.data?.ok ? "created" : "blocked", caso, message: text } })).text, calls };
}

async function handleOllamaMessage(session: Session, message: string, directory: string, adapter: LlmAdapter): Promise<{ reply: string; calls: Call[] }> {
  const calls: Call[] = [];
  const context = { directory, sessionId: session.id };
  if (session.pending) {
    session.llmMessages.push({ role: "user", content: message });
    if (!affirmative.test(message)) return { reply: `La operación ${session.pending.operationId} de ${session.pending.caso} sigue pendiente. Para autorizarla, responde “Confirmo”; cualquier otro mensaje no la ejecuta.`, calls };
    const pending = session.pending;
    if (hashPayload(pending.payload) !== pending.payloadHash) { session.pending = undefined; return { reply: "La operación pendiente ya no coincide con su payload; no se creó la orden.", calls }; }
    session.pending = undefined;
    const result = parseToolResult(await crear.execute({ caso: pending.caso, paquete: pending.paquete, validacion: pending.validacion, payload: pending.payload, confirmado: true }, context));
    session.llmMessages.push({ role: "tool", tool_name: "oc_crear", content: JSON.stringify(result) });
    const created = nestedData<{ ok: boolean; numero_oc?: string; error?: string }>(result);
    const succeeded = Boolean(created.data?.ok && created.data.numero_oc);
    calls.push(await record(directory, session, makeCall("oc_crear", { caso: pending.caso, operationId: pending.operationId, payloadHash: pending.payloadHash }, succeeded ? `OC ${created.data!.numero_oc} creada` : "Creación rechazada por el backend", succeeded ? "ok" : "blocked")));
    session.llmMessages.push({ role: "assistant", content: succeeded ? `Confirmación aceptada. OC ${created.data!.numero_oc} creada.` : "El backend rechazó la creación de la OC." });
    return { reply: succeeded ? `Confirmación aceptada para ${pending.caso} y operación ${pending.operationId}. Se creó la OC ${created.data!.numero_oc}.` : `La solicitud ${pending.caso} no se creó: ${created.data?.error ?? "falló el control del backend"}.`, calls };
  }

  const match = message.match(command);
  if (!match) return { reply: "Indica una solicitud para procesar, por ejemplo: «Procesa sol-001».", calls };
  const caso = match[1].toLowerCase();
  const state: AgentState = { caso, pendingRequest: false, createAttempted: false };
  const chat = adapter.chatWithTools;
  if (!chat) return { reply: "El adaptador local no soporta llamadas a herramientas.", calls };
  try {
    if (!session.llmMessages.length) {
      const prompt = await readFile(safePath(directory, "agent", "prompt.md"), "utf8");
      session.llmMessages.push({ role: "system", content: `${prompt}\n\nUsa únicamente las herramientas registradas. Procesa secuencialmente: leer, validar, generar evidencia, construir payload y crear. El backend decide bloqueos y autorizaciones.` });
    }
    session.llmMessages.push({ role: "user", content: message });
    let usedCalls = 0, finished = false, limitReached = false;
    for (let iteration = 0; iteration < 6; iteration++) {
      const answer = await chat.call(adapter, { messages: session.llmMessages, tools: ollamaToolDefinitions() });
      session.llmMessages.push(answer.message);
      const modelCalls = answer.message.tool_calls ?? [];
      if (!modelCalls.length) { finished = true; break; }
      for (const toolCall of modelCalls) {
        if (usedCalls >= 6) { limitReached = true; break; }
        usedCalls++;
        const name = toolCall.function.name;
        const execution = await executeModelTool(name, toolCall.function.arguments, state, context);
        if (execution.call) { calls.push(await record(directory, session, execution.call)); }
        session.llmMessages.push({ role: "tool", tool_name: name, content: execution.result });
      }
      if (limitReached) break;
    }
    if (!finished && !limitReached) limitReached = true;
    if (state.validacion && !state.validacion.apta) {
      if (!state.createAttempted) await logBlockedCreate(state, directory, session, context, calls);
      const text = `No se creó la orden para ${caso}. Bloqueos: ${state.validacion.bloqueos.join("; ")}.`;
      session.llmMessages.push({ role: "assistant", content: text });
      return { reply: text, calls };
    }
    if (!state.paquete) return { reply: limitReached ? "El modelo alcanzó el límite de herramientas sin leer el paquete; no se ejecutó ninguna acción." : "El modelo local no solicitó leer el paquete. No se ejecutó ninguna acción.", calls };
    if (!state.validacion) {
      await executeModelTool("oc_validar", { caso }, state, context).then(async r => { if (r.call) calls.push(await record(directory, session, r.call)); });
    }
    if (state.validacion && !state.validacion.apta) {
      if (!state.createAttempted) await logBlockedCreate(state, directory, session, context, calls);
      const text = `No se creó la orden para ${caso}. Bloqueos: ${state.validacion.bloqueos.join("; ")}.`;
      session.llmMessages.push({ role: "assistant", content: text });
      return { reply: text, calls };
    }
    if (!state.validacion?.apta) return { reply: "El backend no pudo completar las validaciones; no se creó la orden.", calls };
    if (!state.evidenciaSha256) {
      const evidence = await executeModelTool("oc_generar_evidencia", { caso }, state, context);
      if (evidence.call) calls.push(await record(directory, session, evidence.call));
    }
    if (!state.payload) {
      const built = await executeModelTool("oc_construir_payload", { caso }, state, context);
      if (built.call) calls.push(await record(directory, session, built.call));
    }
    if (!state.payload) return { reply: "No se pudo construir un payload SAP válido; no se creó la orden.", calls };
    if (state.validacion.confirmaciones.length) {
      if (!state.createAttempted) await attemptCreate(state, directory, session, context, calls);
      const payloadHash = hashPayload(state.payload);
      const operationId = randomUUID();
      session.pending = { operationId, caso, paquete: state.paquete, validacion: state.validacion, payload: state.payload, payloadHash };
      const details = state.validacion.confirmaciones.map(item => `${item.codigo}: ${item.detalle}`).join("; ");
      const text = `El caso ${caso} está validado, pero requiere confirmación: ${details}. Para crear la OC, responde “Confirmo”. Operación pendiente ${operationId}.`;
      session.llmMessages.push({ role: "assistant", content: text });
      return { reply: text, calls };
    }
    if (limitReached && !state.createAttempted) return { reply: "Se alcanzó el límite de seis iteraciones de herramientas. No se creó la OC; puedes reintentar en otro turno.", calls };
    if (!state.createAttempted) await attemptCreate(state, directory, session, context, calls);
    const text = state.createdNumber ? `Solicitud ${caso} procesada correctamente. Se creó la OC ${state.createdNumber}.` : "No se creó la orden; el backend rechazó la operación.";
    session.llmMessages.push({ role: "assistant", content: text });
    return { reply: text, calls };
  } catch (error) {
    const text = error instanceof Error && error.message.includes("tiempo límite") ? "El modelo local excedió el tiempo límite. No se autorizó ni creó ninguna OC." : "No fue posible completar el turno con el modelo local. Revisa que Ollama esté activo y vuelve a intentar.";
    return { reply: text, calls };
  }
}

async function executeModelTool(name: string, rawArgs: unknown, state: AgentState, context: { directory: string; sessionId: string }): Promise<{ result: string; call?: Call }> {
  const registered = registeredTools().find(item => item.name === name);
  if (!registered) return { result: JSON.stringify({ ok: false, error: "Herramienta desconocida; rechazada por allowlist." }), call: makeCall("herramienta_desconocida", {}, "Herramienta rechazada por allowlist", "blocked") };
  let argsValue = rawArgs;
  if (typeof argsValue === "string") { try { argsValue = JSON.parse(argsValue); } catch { argsValue = null; } }
  const parsed = registered.schema.safeParse(argsValue);
  if (!parsed.success) return { result: JSON.stringify({ ok: false, error: "Argumentos inválidos; rechazados por Zod." }), call: makeCall(name, {}, "Argumentos inválidos rechazados por Zod", "blocked") };
  const caso = parsed.data.caso;
  if (caso !== state.caso) return { result: JSON.stringify({ ok: false, error: "El caso no coincide con la solicitud activa." }), call: makeCall(name, { caso }, "Caso distinto al solicitado; acción rechazada", "blocked") };
  if (name === "oc_crear" && state.createAttempted) return { result: JSON.stringify({ ok: false, error: "Intento duplicado rechazado." }), call: makeCall(name, { caso }, "Intento duplicado rechazado", "blocked") };
  const ctx = context;
  if (name === "oc_leer_paquete") {
    const data = parseToolResult(await leer_paquete.execute({ caso }, ctx));
    state.paquete = nestedData<{ paquete: Paquete }>(data).data?.paquete;
    return { result: JSON.stringify(data), call: makeCall(name, { caso }, state.paquete ? "Paquete local leído y normalizado" : "No se pudo leer el paquete", state.paquete ? "ok" : "blocked") };
  }
  if (name === "oc_validar") {
    if (!state.paquete) return rejectedTool(name, caso, "Primero debes leer el paquete.");
    const data = parseToolResult(await validar.execute({ caso, paquete: state.paquete }, ctx));
    state.validacion = nestedData<Validacion>(data).data;
    const ok = Boolean(state.validacion);
    return { result: JSON.stringify(data), call: makeCall(name, { caso }, ok ? `${state.validacion!.bloqueos.length} bloqueo(s), ${state.validacion!.confirmaciones.length} confirmación(es)` : "Validación fallida", ok && !state.validacion!.apta ? "blocked" : ok && state.validacion!.confirmaciones.length ? "pending" : ok ? "ok" : "blocked") };
  }
  if (name === "oc_generar_evidencia") {
    if (!state.paquete || !state.validacion?.apta) return rejectedTool(name, caso, "Solo se genera evidencia después de validar un paquete apto.");
    const data = parseToolResult(await generar_evidencia.execute({ caso }, ctx));
    state.evidenciaSha256 = nestedData<{ sha256: string }>(data).data?.sha256;
    return { result: JSON.stringify(data), call: makeCall(name, { caso }, state.evidenciaSha256 ? "Evidencia generada en out/" : "No se pudo generar la evidencia", state.evidenciaSha256 ? "ok" : "blocked") };
  }
  if (name === "oc_construir_payload") {
    if (!state.paquete || !state.validacion?.apta || !state.evidenciaSha256) return rejectedTool(name, caso, "Primero lee, valida y genera la evidencia.");
    const data = parseToolResult(await construir_payload.execute({ caso, paquete: state.paquete, derivados: state.validacion.derivados, evidencia_sha256: state.evidenciaSha256 }, ctx));
    state.payload = nestedData<{ payload: unknown }>(data).data?.payload;
    return { result: JSON.stringify(data), call: makeCall(name, { caso }, state.payload ? "Payload SAP construido y validado" : "Payload rechazado por su esquema", state.payload ? "ok" : "blocked") };
  }
  if (name === "oc_crear") {
    if (!state.paquete || !state.validacion) return rejectedTool(name, caso, "No existe un resultado de validación del backend.");
    if (!state.validacion.apta) { state.createAttempted = true; const data = parseToolResult(await crear.execute({ caso, paquete: state.paquete, validacion: state.validacion, payload: {} }, ctx)); return { result: JSON.stringify(data), call: makeCall(name, { caso }, "Creación bloqueada por validaciones", "blocked") }; }
    if (!state.payload) return rejectedTool(name, caso, "No existe un payload construido por el backend.");
    state.createAttempted = true;
    const data = parseToolResult(await crear.execute({ caso, paquete: state.paquete, validacion: state.validacion, payload: state.payload }, ctx));
    const created = nestedData<{ ok: boolean; numero_oc?: string }>(data).data;
    if (created?.ok) state.createdNumber = created.numero_oc;
    if (state.validacion.confirmaciones.length) state.pendingRequest = true;
    return { result: JSON.stringify(data), call: makeCall(name, { caso }, created?.numero_oc ? `OC ${created.numero_oc} creada` : state.pendingRequest ? "Se requiere confirmación humana" : "Creación rechazada por el backend", created?.ok ? "ok" : state.pendingRequest ? "pending" : "blocked") };
  }
  return rejectedTool(name, caso, "Herramienta no implementada.");
}

async function attemptCreate(state: AgentState, directory: string, session: Session, context: { directory: string; sessionId: string }, calls: Call[]): Promise<void> {
  if (!state.paquete || !state.validacion || !state.payload || state.createAttempted) return;
  state.createAttempted = true;
  const data = parseToolResult(await crear.execute({ caso: state.caso, paquete: state.paquete, validacion: state.validacion, payload: state.payload }, context));
  const created = nestedData<{ ok: boolean; numero_oc?: string }>(data).data;
  if (created?.ok) state.createdNumber = created.numero_oc;
  const status = created?.ok ? "ok" : state.validacion.confirmaciones.length ? "pending" : "blocked";
  calls.push(await record(directory, session, makeCall("oc_crear", { caso: state.caso }, created?.numero_oc ? `OC ${created.numero_oc} creada` : state.validacion.confirmaciones.length ? "Se requiere confirmación humana" : "Creación rechazada por el backend", status)));
}

async function logBlockedCreate(state: AgentState, directory: string, session: Session, context: { directory: string; sessionId: string }, calls: Call[]): Promise<void> {
  if (!state.paquete || !state.validacion || state.validacion.apta || state.createAttempted) return;
  state.createAttempted = true;
  await crear.execute({ caso: state.caso, paquete: state.paquete, validacion: state.validacion, payload: {} }, context);
  calls.push(await record(directory, session, makeCall("oc_crear", { caso: state.caso }, "Creación bloqueada por controles RC", "blocked")));
}

function rejectedTool(name: string, caso: string, message: string) { return { result: JSON.stringify({ ok: false, error: message }), call: makeCall(name, { caso }, message, "blocked") }; }
function parseToolResult(raw: string): unknown { try { return JSON.parse(raw); } catch { return { ok: false, error: "La herramienta produjo una respuesta inválida." }; } }
function hashPayload(payload: unknown): string { return createHash("sha256").update(JSON.stringify(payload)).digest("hex"); }

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

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createChatServer } from "../src/chat/server.ts";

const server = createChatServer();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = async (body: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
test.after(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

test("health y la interfaz estática responden", async () => {
  const health = await fetch(`${base}/api/health`); assert.equal(health.status, 200);
  const data = await health.json() as { ok: boolean; provider: string }; assert.equal(data.ok, true); assert.equal(data.provider, "simulado-local");
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Órdenes de compra/);
  const js = await fetch(`${base}/app.js`); assert.equal(js.status, 200); assert.match(await js.text(), /Confirmar operación/);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
});

test("confirmation is stored per session and pending operation", async () => {
  const first = await post({ message: "Procesa sol-004" }); assert.equal(first.status, 200);
  const started = await first.json() as { sessionId: string; needsConfirmation: boolean; pending: { case: string; operationId: string }; toolCalls: Array<{ name: string }> };
  assert.equal(started.needsConfirmation, true); assert.equal(started.pending.case, "sol-004");
  assert.deepEqual(started.toolCalls.map(call => call.name), ["oc_leer_paquete", "oc_validar", "oc_generar_evidencia", "oc_construir_payload"]);
  const otherSession = await post({ message: "Confirmo" }); const other = await otherSession.json() as { reply: string; needsConfirmation: boolean };
  assert.equal(other.needsConfirmation, false); assert.match(other.reply, /Indica una solicitud/);
  const ignored = await post({ sessionId: started.sessionId, message: "No confirmo todavía" });
  assert.equal((await ignored.json() as { needsConfirmation: boolean }).needsConfirmation, true);
  const confirmed = await post({ sessionId: started.sessionId, message: "Confirmo", payload: { numero_oc: "forjado" }, confirmado: true });
  assert.equal(confirmed.status, 400, "el navegador no puede enviar payload ni confirmado");
  const accepted = await post({ sessionId: started.sessionId, message: "Confirmo" });
  const result = await accepted.json() as { needsConfirmation: boolean; reply: string; toolCalls: Array<{ name: string }> };
  assert.equal(result.needsConfirmation, false); assert.match(result.reply, /Se creó la OC/); assert.equal(result.toolCalls.at(-1)?.name, "oc_crear");
  const repeated = await post({ sessionId: started.sessionId, message: "Confirmo" });
  assert.equal((await repeated.json() as { needsConfirmation: boolean }).needsConfirmation, false);
});

test("a valid case without exceptions creates the order in the same session", async () => {
  const response = await post({ message: "Procesa sol-001" });
  const body = await response.json() as { sessionId: string; reply: string; needsConfirmation: boolean; toolCalls: Array<{ name: string }> };
  assert.equal(response.status, 200); assert.equal(body.needsConfirmation, false); assert.match(body.reply, /Se creó la OC/);
  assert.equal(body.toolCalls.at(-1)?.name, "oc_crear");
  const history = await fetch(`${base}/api/sessions/${body.sessionId}`);
  assert.equal(history.status, 200);
});

test("blocked cases cannot create orders and session history is available", async () => {
  let blockedSession = "";
  for (const caso of ["sol-002", "sol-003"]) {
    const response = await post({ message: `Procesa ${caso}` });
    const body = await response.json() as { sessionId: string; reply: string; needsConfirmation: boolean; toolCalls: Array<{ name: string; status: string }> };
    assert.equal(body.needsConfirmation, false); assert.match(body.reply, /No se creó la orden/);
    assert.equal(body.toolCalls.at(-1)?.name, "oc_crear"); assert.equal(body.toolCalls.at(-1)?.status, "blocked");
    blockedSession = body.sessionId;
  }
  const history = await fetch(`${base}/api/sessions/${blockedSession}`); assert.equal(history.status, 200);
  const session = await history.json() as { messages: unknown[]; toolCalls: unknown[] }; assert.equal(session.messages.length, 2); assert.equal(session.toolCalls.length, 3);
  const invalid = await post({ sessionId: blockedSession, message: "Confirmo" });
  const invalidBody = await invalid.json() as { reply: string; needsConfirmation: boolean };
  assert.equal(invalidBody.needsConfirmation, false); assert.match(invalidBody.reply, /Indica una solicitud/);
});

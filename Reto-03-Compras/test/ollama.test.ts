import test from "node:test";
import assert from "node:assert/strict";
import { OllamaAdapter } from "../src/llm/ollama.ts";
import { ollamaToolDefinitions } from "../src/llm/tools.ts";

test("Ollama usa exclusivamente el endpoint local y parámetros fijados", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input); requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "oc_leer_paquete", arguments: { caso: "sol-001" } } }] } });
  };
  try {
    const adapter = new OllamaAdapter({ timeoutMs: 5000, numPredict: 77 });
    const response = await adapter.chatWithTools!({ messages: [{ role: "user", content: "Procesa sol-001" }], tools: ollamaToolDefinitions() });
    assert.equal(requestUrl, "http://127.0.0.1:11434/api/chat");
    assert.equal(requestBody.model, "qwen3.5:4b-q4_K_M"); assert.equal(requestBody.stream, false); assert.equal(requestBody.think, false);
    assert.deepEqual(requestBody.options, { temperature: 0, num_predict: 77 });
    assert.equal(response.message.tool_calls?.[0]?.function.name, "oc_leer_paquete");
    const tools = requestBody.tools as Array<{ function: { parameters: { additionalProperties?: boolean; properties?: Record<string, unknown> } } }>;
    assert.equal(tools[0].function.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tools[0].function.parameters.properties ?? {}), ["caso"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Ollama rechaza respuestas vacías y errores HTTP", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ message: { role: "assistant", content: "" } });
    await assert.rejects(new OllamaAdapter().chatWithTools!({ messages: [], tools: [] }), /respuesta vacía/);
    globalThis.fetch = async () => new Response("fallo", { status: 503 });
    await assert.rejects(new OllamaAdapter().chatWithTools!({ messages: [], tools: [] }), /HTTP 503/);
  } finally { globalThis.fetch = originalFetch; }
});

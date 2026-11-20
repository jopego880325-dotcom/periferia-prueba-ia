import type { AdapterRequest, LlmAdapter, LlmMessage, ToolChatRequest, ToolChatResponse } from "./adapter.ts";

const ENDPOINT = "http://127.0.0.1:11434/api/chat";
const MODEL = "qwen3.5:4b-q4_K_M";

export class OllamaAdapter implements LlmAdapter {
  readonly provider = "ollama-local";
  readonly model = MODEL;
  private readonly timeoutMs: number;
  private readonly numPredict: number;

  constructor(options: { timeoutMs?: number; numPredict?: number } = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs ?? readIntegerEnv("OLLAMA_TIMEOUT_MS", 90_000), "timeoutMs");
    this.numPredict = positiveInteger(options.numPredict ?? readIntegerEnv("OLLAMA_NUM_PREDICT", 384), "numPredict");
  }

  async respond(request: AdapterRequest): Promise<{ text: string }> {
    const system = "Eres un asistente local de órdenes de compra. No inventes resultados ni confirmaciones.";
    const prompt = JSON.stringify({ mensaje: request.userMessage, herramientas: request.toolSummaries, resultado_backend: request.outcome });
    const response = await this.request({ messages: [{ role: "system", content: system }, { role: "user", content: prompt }], tools: [] });
    return { text: response.message.content.trim() };
  }

  chatWithTools(request: ToolChatRequest): Promise<ToolChatResponse> { return this.request(request); }

  private async request(request: ToolChatRequest): Promise<ToolChatResponse> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: MODEL,
          messages: request.messages,
          tools: request.tools,
          stream: false,
          think: false,
          options: { temperature: 0, num_predict: this.numPredict }
        })
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("Ollama excedió el tiempo límite configurado.");
      throw new Error("No se pudo conectar con Ollama local en 127.0.0.1:11434.");
    }
    if (!response.ok) throw new Error(`Ollama respondió HTTP ${response.status}.`);
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error("Ollama devolvió una respuesta JSON inválida."); }
    const message = parseMessage(raw);
    if (!message.content.trim() && !message.tool_calls?.length) throw new Error("Ollama devolvió una respuesta vacía.");
    return { message };
  }
}

function parseMessage(value: unknown): LlmMessage {
  if (!value || typeof value !== "object") throw new Error("Ollama devolvió una respuesta inválida.");
  const message = (value as { message?: unknown }).message;
  if (!message || typeof message !== "object") throw new Error("Ollama no incluyó el mensaje esperado.");
  const item = message as { role?: unknown; content?: unknown; tool_calls?: unknown };
  if (item.role !== "assistant" || typeof item.content !== "string") throw new Error("Ollama devolvió un mensaje con formato inválido.");
  let toolCalls: LlmMessage["tool_calls"];
  if (item.tool_calls !== undefined) {
    if (!Array.isArray(item.tool_calls)) throw new Error("Ollama devolvió tool_calls con formato inválido.");
    toolCalls = item.tool_calls.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("Llamada a herramienta malformada.");
      const fn = (entry as { function?: unknown }).function;
      if (!fn || typeof fn !== "object") throw new Error("Llamada a herramienta sin función.");
      const functionCall = fn as { name?: unknown; arguments?: unknown };
      if (typeof functionCall.name !== "string") throw new Error("Llamada a herramienta sin nombre.");
      return { id: typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : undefined, function: { name: functionCall.name, arguments: functionCall.arguments } };
    });
  }
  return { role: "assistant", content: item.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function readIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return positiveInteger(parsed, name);
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} debe ser un entero positivo.`);
  return value;
}

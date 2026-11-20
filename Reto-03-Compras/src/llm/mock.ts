import type { AdapterRequest, LlmAdapter } from "./adapter.ts";

export class SimulatedLlmAdapter implements LlmAdapter {
  readonly provider = "simulado-local";
  readonly model = "plantillas-deterministas";

  async respond(request: AdapterRequest): Promise<{ text: string }> {
    const { outcome } = request;
    if (outcome.kind === "awaiting_confirmation") return { text: outcome.message };
    if (outcome.kind === "blocked") return { text: outcome.message };
    if (outcome.kind === "created") return { text: outcome.message };
    if (outcome.kind === "invalid") return { text: outcome.message };
    return { text: outcome.message };
  }
}

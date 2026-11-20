export type AdapterOutcome = {
  kind: "ready" | "blocked" | "awaiting_confirmation" | "created" | "invalid";
  caso?: string;
  message: string;
};

export type AdapterRequest = {
  userMessage: string;
  toolSummaries: string[];
  outcome: AdapterOutcome;
};

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  respond(request: AdapterRequest): Promise<{ text: string }>;
}

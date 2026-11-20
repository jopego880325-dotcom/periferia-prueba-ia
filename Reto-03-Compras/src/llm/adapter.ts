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

export type ToolCall = { id?: string; function: { name: string; arguments: unknown } };
export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};
export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ToolChatRequest = { messages: LlmMessage[]; tools: ToolDefinition[] };
export type ToolChatResponse = { message: LlmMessage };

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  respond(request: AdapterRequest): Promise<{ text: string }>;
  chatWithTools?(request: ToolChatRequest): Promise<ToolChatResponse>;
}

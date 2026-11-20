import { z } from "zod";
import { leer_paquete, validar, construir_payload, generar_evidencia, crear } from "../tools/oc.ts";
import type { ToolDefinition } from "./adapter.ts";

const caseSchema = z.object({ caso: z.enum(["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]).describe("Identificador del caso indicado por la persona usuaria") }).strict();
const definitions = [
  { name: "oc_leer_paquete", description: leer_paquete.description },
  { name: "oc_validar", description: validar.description },
  { name: "oc_generar_evidencia", description: generar_evidencia.description },
  { name: "oc_construir_payload", description: construir_payload.description },
  { name: "oc_crear", description: crear.description }
] as const;

export type RegisteredToolName = typeof definitions[number]["name"];
export type RegisteredTool = { name: RegisteredToolName; description: string; schema: typeof caseSchema };

export function registeredTools(): RegisteredTool[] {
  return definitions.map(definition => ({ ...definition, schema: caseSchema }));
}

export function ollamaToolDefinitions(): ToolDefinition[] {
  return registeredTools().map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.schema, { unrepresentable: "any" }) as Record<string, unknown> } }));
}

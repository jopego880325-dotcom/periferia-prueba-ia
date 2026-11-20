import { readFile } from "node:fs/promises";
import { caseName, safePath } from "./paths.ts";
import type { Paquete, Solicitud } from "./types.ts";

const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T;
const numberAfter = (text: string, pattern: RegExp): number => {
  const match = text.match(pattern);
  if (!match) throw new Error("No se encontró un monto numérico válido en el adjunto");
  const value = Number(match[1].replace(/[.,]/g, ""));
  if (!Number.isFinite(value)) throw new Error("Monto no numérico en el adjunto");
  return value;
};
const dateFrom = (text: string, pattern: RegExp): string | null => text.match(pattern)?.[1] ?? null;

export async function readPackage(root: string, name: string): Promise<Paquete> {
  const caso = caseName(name);
  const dir = safePath(root, "fixtures", "reto-03", "solicitudes", caso);
  const solicitud = await json<Solicitud>(safePath(dir, "solicitud.json"));
  if (typeof solicitud.valor_total !== "number" || !Number.isFinite(solicitud.valor_total)) throw new Error("El valor_total de la solicitud no es numérico");
  const correo = await json<Paquete["correo"]>(safePath(dir, "correo.json"));
  const aprobacionRaw = await json<{ de: string; para?: string; fecha: string; asunto: string; cuerpo: string }>(safePath(dir, "aprobacion.json"));
  const cotText = await readFile(safePath(dir, "cotizacion.txt"), "utf8");
  const cotTotal = numberAfter(cotText, /TOTAL[^\n]*?COP\s*([\d.,]+)/i);
  const cotNit = cotText.match(/NIT:\s*([\d.\-]+)/i)?.[1]?.replace(/\D/g, "") ?? null;
  const cotizacion = { proveedor: cotText.match(/Proveedor:\s*(.+)/i)?.[1]?.trim() ?? "", nit: cotNit, total: cotTotal, moneda: "COP", validez_hasta: dateFrom(cotText, /Validez hasta:\s*(\d{4}-\d{2}-\d{2})/i), texto: cotText };
  let factura: Paquete["factura"] = null;
  try {
    const invoice = await readFile(safePath(dir, "factura.txt"), "utf8");
    factura = { numero: invoice.match(/No\.\s*([^\n]+)/i)?.[1]?.trim() ?? "", fecha: dateFrom(invoice, /Fecha de emisi[oó]n:\s*(\d{4}-\d{2}-\d{2})/i) ?? "", total: numberAfter(invoice, /TOTAL:\s*COP\s*([\d.,]+)/i) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { correo, solicitud, cotizacion, aprobacion: { ...aprobacionRaw, aprobado: /\baprobado\b/i.test(aprobacionRaw.cuerpo), texto: aprobacionRaw.cuerpo }, factura };
}

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { safePath } from "../paths.ts";
import type { OrdenCompra } from "../types.ts";
import type { SapAdapter } from "./adapter.ts";

export class FileSapAdapter implements SapAdapter {
  private readonly file: string;
  constructor(private readonly root: string) { this.file = safePath(root, "out", "sap", "ordenes.jsonl"); }
  async consultarProveedor(nit: string) {
    const vendors = JSON.parse(await readFile(safePath(this.root, "fixtures", "reto-03", "maestros", "proveedores.json"), "utf8")) as Array<{ nit: string; codigo_sap: string; activo: boolean }>;
    const found = vendors.find(v => v.nit.replace(/\D/g, "") === nit.replace(/\D/g, ""));
    return found ? { codigo_sap: found.codigo_sap, activo: found.activo } : null;
  }
  async buscarOrdenPorReferencia(id: string) {
    try { const lines = (await readFile(this.file, "utf8")).split(/\r?\n/).filter(Boolean); for (const line of lines) { const row = JSON.parse(line) as { orden: OrdenCompra; numero_oc: string }; if (row.orden.referencia.solicitud_id === id) return { numero_oc: row.numero_oc }; } } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return null;
  }
  async crearOrden(orden: OrdenCompra) {
    const existing = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id);
    if (existing) return { ...existing, fecha: new Date().toISOString().slice(0, 10) };
    await mkdir(safePath(this.root, "out", "sap"), { recursive: true });
    let last = 4500000000;
    try { for (const line of (await readFile(this.file, "utf8")).split(/\r?\n/).filter(Boolean)) last = Math.max(last, Number((JSON.parse(line) as { numero_oc: string }).numero_oc)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const numero_oc = String(last + 1), fecha = new Date().toISOString().slice(0, 10);
    await appendFile(this.file, `${JSON.stringify({ numero_oc, fecha, orden })}\n`, "utf8");
    return { numero_oc, fecha };
  }
}

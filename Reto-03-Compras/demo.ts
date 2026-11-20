import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safePath } from "./src/paths.ts";
import { leer_paquete, validar, construir_payload, generar_evidencia, crear } from "./src/tools/oc.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = safePath(root, "out");
if (out === root || !out.startsWith(`${root}${path.sep}`)) throw new Error("Ruta de salida no segura");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const ctx = { directory: root, sessionId: "demo-local" };
const decode = <T>(raw: string) => JSON.parse(raw) as { ok: boolean; data?: T; error?: string };
const cases = (await readdir(safePath(root, "fixtures", "reto-03", "solicitudes"), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
for (const caso of cases) {
  const read = decode<{ paquete: Awaited<ReturnType<typeof import("./src/parse.ts").readPackage>> }>(await leer_paquete.execute({ caso }, ctx));
  if (!read.ok || !read.data) { console.log(`${caso}: error leyendo paquete: ${read.error}`); continue; }
  const paquete = read.data.paquete;
  const check = decode<ValidReturn>(await validar.execute({ caso, paquete }, ctx));
  if (!check.ok || !check.data) { console.log(`${caso}: error validando: ${check.error}`); continue; }
  const v = check.data;
  console.log(`${caso}: apta=${v.apta}; bloqueos=${v.bloqueos.join("; ") || "ninguno"}; confirmaciones=${v.confirmaciones.map(c => c.codigo).join(", ") || "ninguna"}; retroactiva=${v.retroactiva}`);
  if (!v.apta) { decode(await crear.execute({ caso, paquete, validacion: v, payload: {} }, ctx)); continue; }
  const evidence = decode<{ ruta: string; sha256: string }>(await generar_evidencia.execute({ caso }, ctx));
  if (!evidence.ok || !evidence.data) { console.log(`${caso}: error evidencia ${evidence.error}`); continue; }
  const built = decode<{ payload: OrdenReturn; trazabilidad: string }>(await construir_payload.execute({ caso, paquete, derivados: v.derivados, evidencia_sha256: evidence.data.sha256 }, ctx));
  if (!built.ok || !built.data) { console.log(`${caso}: error payload ${built.error}`); continue; }
  const confirm = v.confirmaciones.length > 0;
  if (confirm) {
    const pending = decode<{ ok?: boolean; error?: string }>(await crear.execute({ caso, paquete, validacion: v, payload: built.data.payload }, ctx));
    console.log(`${caso}: sin confirmar => ${pending.data?.error ?? pending.error ?? "creación permitida"}`);
  }
  const created = decode<{ numero_oc?: string; idempotente?: boolean; error?: string }>(await crear.execute({ caso, paquete, validacion: v, payload: built.data.payload, confirmado: confirm }, ctx));
  console.log(`${caso}: ${created.data?.numero_oc ? `OC ${created.data.numero_oc}` : created.data?.error ?? created.error}${confirm ? " (demo confirmó explícitamente)" : ""}`);
  if (caso === "sol-001" && created.data?.numero_oc) {
    const again = decode<{ numero_oc?: string; idempotente?: boolean }>(await crear.execute({ caso, paquete, validacion: v, payload: built.data.payload }, ctx));
    console.log(`sol-001 repetida: OC ${again.data?.numero_oc}; idempotente=${again.data?.idempotente}`);
  }
}
type ValidReturn = { apta: boolean; bloqueos: string[]; confirmaciones: Array<{ codigo: string; detalle: string }>; derivados: Record<string, string>; retroactiva: boolean };
type OrdenReturn = import("./src/types.ts").OrdenCompra;

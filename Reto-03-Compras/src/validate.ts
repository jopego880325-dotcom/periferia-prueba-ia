import { readFile } from "node:fs/promises";
import { safePath } from "./paths.ts";
import type { Paquete, Validacion } from "./types.ts";

type Proveedor = { codigo_sap: string; nit: string; nombre: string; condiciones_pago_default: string; indicador_iva_default: string; activo: boolean };
type Centro = { centro_costo: string; subareas: string[]; aprobadores: Array<{ email: string; tope: number }> };
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
const read = async <T>(root: string, file: string) => JSON.parse(await readFile(safePath(root, "fixtures", "reto-03", "maestros", file), "utf8")) as T;

export async function validatePackage(root: string, p: Paquete): Promise<Validacion> {
  const [vendors, centers, taxes, payments] = await Promise.all([
    read<Proveedor[]>(root, "proveedores.json"), read<Centro[]>(root, "centros-costo.json"),
    read<Array<{ codigo: string }>>(root, "indicadores-iva.json"), read<Array<{ codigo: string }>>(root, "condiciones-pago.json")
  ]);
  const { solicitud: s, aprobacion: a, cotizacion: q } = p;
  const bloqueos: string[] = [], confirmaciones: Validacion["confirmaciones"] = [], derivados: Record<string, string> = {};
  const proveedor = s.proveedor_nit ? vendors.find(v => v.nit.replace(/\D/g, "") === s.proveedor_nit!.replace(/\D/g, "")) : vendors.find(v => norm(v.nombre) === norm(s.proveedor_nombre));
  if (!proveedor || !proveedor.activo) bloqueos.push("RC1: proveedor inexistente o inactivo en el maestro");
  const centro = centers.find(c => c.centro_costo === s.centro_costo);
  const aprobador = centro?.aprobadores.find(x => x.email.toLowerCase() === a?.de.toLowerCase());
  if (!a || !a.aprobado || !aprobador) bloqueos.push("RC2: aprobación ausente, sin 'Aprobado' o de aprobador no autorizado para el centro");
  if (aprobador && s.valor_total > aprobador.tope) bloqueos.push("RC3: valor_total excede el tope del aprobador");
  if (!centro?.subareas.includes(s.subarea)) bloqueos.push("RC4: subárea no pertenece al centro de costo");
  if (!q) confirmaciones.push({ codigo: "RC5", detalle: "No hay cotización; confirmar para continuar" });
  else if (Math.abs(q.total - s.valor_total) / s.valor_total > .02) confirmaciones.push({ codigo: "RC5", detalle: `Diferencia de cotización: solicitud ${s.valor_total}, cotización ${q.total}` });
  if (!s.indicador_iva && proveedor) { derivados.indicador_iva = proveedor.indicador_iva_default; confirmaciones.push({ codigo: "RC6", detalle: `IVA derivado del maestro: ${proveedor.indicador_iva_default}; confirmar` }); }
  if (!s.condiciones_pago && proveedor) derivados.condiciones_pago = proveedor.condiciones_pago_default;
  const iva = s.indicador_iva ?? derivados.indicador_iva;
  if (iva && !taxes.some(x => x.codigo === iva)) bloqueos.push("RC6: indicador de IVA no existe en el maestro");
  const payment = s.condiciones_pago ?? derivados.condiciones_pago;
  if (payment && !payments.some(x => x.codigo === payment)) bloqueos.push("RC7: condición de pago no existe en el maestro");
  const retroactiva = Boolean(p.factura && p.factura.fecha < s.fecha_solicitud);
  if (retroactiva) confirmaciones.push({ codigo: "RC8", detalle: `Compra retroactiva: factura ${p.factura!.fecha} anterior a solicitud ${s.fecha_solicitud}` });
  if (a && a.fecha < s.fecha_solicitud) confirmaciones.push({ codigo: "RC9", detalle: "Fecha de aprobación anterior a fecha de solicitud" });
  if (Math.abs(s.cantidad * s.valor_unitario - s.valor_total) > 1) bloqueos.push("RC10: cantidad × valor_unitario no coincide con valor_total (tolerancia 1)");
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva };
}

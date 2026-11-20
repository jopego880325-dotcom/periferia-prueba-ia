export type Solicitud = {
  solicitud_id: string; solicitante: string; proveedor_nombre: string; proveedor_nit?: string;
  descripcion: string; centro_costo: string; subarea: string; cantidad: number;
  valor_unitario: number; valor_total: number; moneda: "COP" | "USD";
  indicador_iva?: string; condiciones_pago?: string; fecha_solicitud: string;
};
export type Paquete = {
  correo: { id: string; de: string; para?: string; asunto: string; fecha: string; cuerpo: string };
  solicitud: Solicitud;
  cotizacion: { proveedor: string; nit: string | null; total: number; moneda: string; validez_hasta: string | null; texto: string } | null;
  aprobacion: { de: string; para?: string; fecha: string; aprobado: boolean; asunto: string; texto: string } | null;
  factura: { numero: string; fecha: string; total: number } | null;
};
export type Confirmacion = { codigo: string; detalle: string };
export type Validacion = { apta: boolean; bloqueos: string[]; confirmaciones: Confirmacion[]; derivados: Record<string, string>; retroactiva: boolean };
export type OrdenCompra = {
  referencia: { solicitud_id: string; correo_id: string; cotizacion_ref: string | null };
  sociedad: "1000"; organizacion_compras: "1000";
  proveedor: { codigo_sap: string; nit: string; nombre: string };
  moneda: "COP" | "USD"; condiciones_pago: string;
  aprobador: { email: string; fecha_aprobacion: string; evidencia_sha256: string };
  posiciones: Array<{ numero: number; descripcion: string; cantidad: number; unidad: "UN" | "H" | "MES"; precio_unitario: number; centro_costo: string; subarea: string; indicador_iva: string }>;
  excepciones: Array<{ codigo: string; detalle: string; confirmado_por: string | null }>;
};
export type ToolContext = { directory: string; sessionId: string };

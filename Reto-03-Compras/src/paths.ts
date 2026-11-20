import path from "node:path";

export function safePath(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Ruta fuera del proyecto");
  return target;
}

export function caseName(value: string): string {
  if (!/^sol-00[1-6]$/.test(value)) throw new Error("Caso inválido; use sol-001 a sol-006");
  return value;
}

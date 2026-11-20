# Reto 3 — Órdenes de compra SAP

Solución local para procesar las solicitudes de compra de los fixtures del Reto 3. No describe ni implementa los retos 1 y 2.

## Alcance y arquitectura

El proyecto combina:

- Un backend HTTP con `node:http` en `Reto-03-Compras/src/chat/server.ts`.
- Herramientas TypeScript en `src/tools/oc.ts`, con validación Zod.
- Controles determinísticos RC1–RC10 y maestros JSON bajo `fixtures/reto-03/`.
- Un adaptador LLM intercambiable: Ollama local por defecto y un adaptador de simulación para pruebas.
- Una interfaz en español hecha con HTML, CSS y JavaScript en `web/`.
- Salidas locales de SAP simulado y auditoría bajo `out/`.

El backend mantiene la autoridad sobre validaciones, payloads y confirmaciones. El modelo solo puede solicitar funciones registradas; sus argumentos se validan con Zod y el backend construye los datos del negocio desde los fixtures y herramientas.

## Controles de compra

- **RC1–RC4:** proveedor existente y activo, aprobación válida de un aprobador autorizado, monto dentro del tope y subárea asociada al centro de costo. Son bloqueos.
- **RC5:** compara cotización y solicitud con tolerancia del 2%; una diferencia mayor o una cotización ausente requiere confirmación.
- **RC6:** si falta el indicador de IVA, se deriva del proveedor y requiere confirmación.
- **RC7:** si faltan las condiciones de pago, se derivan del proveedor.
- **RC8:** detecta factura anterior a la solicitud, marca la compra como retroactiva y requiere confirmación.
- **RC9:** una aprobación anterior a la solicitud requiere confirmación.
- **RC10:** bloquea si cantidad × precio unitario difiere del total por más de una unidad monetaria.

Las confirmaciones se guardan en el backend asociadas a sesión, caso, operación pendiente y hash del payload. El frontend no envía payloads de SAP ni un indicador de autorización. La creación es idempotente por `solicitud_id`; el adaptador simulado guarda órdenes en `out/sap/ordenes.jsonl` y registra intentos en `out/control.csv`.

## Requisitos locales

- Node.js 20 o superior y npm.
- Para el adaptador predeterminado: Ollama local, disponible únicamente en `127.0.0.1:11434`, con el modelo `qwen3.5:4b-q4_K_M` ya instalado.
- La aplicación escucha en `127.0.0.1:3000` por defecto; el puerto se puede cambiar con `PORT`.

Desde PowerShell, instala las dependencias en el proyecto:

```powershell
Set-Location .\Reto-03-Compras
npm.cmd install
```

Scripts disponibles:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run demo
```

La demo limpia y regenera `out/` al iniciar. El script `build` ejecuta `tsc --noEmit`; comprueba tipos y no produce archivos compilados.

## Iniciar el servidor

Sin configurar otra opción, el backend selecciona `ollama-local` y el modelo `qwen3.5:4b-q4_K_M`:

```powershell
npm.cmd start
```

Ollama recibe solicitudes en `http://127.0.0.1:11434/api/chat`, con `think=false`, `stream=false` y temperatura 0. El timeout se configura con `OLLAMA_TIMEOUT_MS` (predeterminado: 90000 ms) y el límite de generación con `OLLAMA_NUM_PREDICT` (predeterminado: 384). El ciclo limita cada turno a seis iteraciones/llamadas de herramientas.

Para usar el adaptador simulado:

```powershell
$env:LLM_ADAPTER = 'mock'
npm.cmd start
```

Health: `GET /api/health`. Chat: `POST /api/chat` con `message` y, para continuar, el `sessionId` devuelto. Historial: `GET /api/sessions/:id`.

## Límites conocidos

- SAP está simulado mediante archivos locales. No existe conexión a SAP productivo.
- Ollama debe estar ejecutándose localmente y el modelo debe estar instalado; este proyecto no descarga modelos ni integra un proveedor remoto.
- La latencia observada en las pruebas locales fue de aproximadamente un minuto por solicitud.
- La demo y las pruebas generan o actualizan archivos en `out/`; la demo elimina su contenido al comenzar.
- La solución cubre el motor, la interfaz y el backend del Reto 3; no incluye funcionalidades P1 descritas en el PRD.

# Comandá

Gestión gastronómica mobile-first y offline-first: salón, comandas, cocina, caja y stock desde el celular.
Nombre provisorio.

## Estado

| Sprint | Alcance | Estado |
| --- | --- | --- |
| 0 | Modelo de datos con seguridad por local, login, alta de local, salón en vivo, PWA instalable | Listo |
| 1 | Carta (categorías, productos, modificadores), toma de pedidos en mesa y mostrador, envío a cocina, comandas abiertas | Listo |
| 2 | Pantalla de cocina (KDS), cobro con varios medios de pago, descuentos y propinas, caja con arqueo | Listo |
| 3 | Stock con recetas, compras, mermas y conteos; reportes de ventas con costo y margen; Inicio del dueño | Listo |
| 4 | Modo sin conexión: pedidos, envío a cocina y KDS sin internet, con sincronización y aviso de conflictos | Listo |
| 5 | Publicación en Cloudflare Pages; equipo con invitaciones por link | Listo |
| 6 | Impresión de comandas y precuentas, operación de salón (pasar de mesa, dividir cuenta) | Próximo |
| 7 | Cobro con QR de Mercado Pago (modo prueba) | Listo |
| 8 | Factura electrónica ARCA (homologación) | Esperando CUIL |

## Correr el proyecto

```bash
npm install
cp .env.example .env   # URL y clave publicable de Supabase
npm run dev            # http://localhost:5173
npm run build          # chequeo de tipos + build de producción (PWA)
```

## Stack

- **Frontend:** React 18 + TypeScript + Vite, PWA instalable (`vite-plugin-pwa`). Fuentes Barlow embebidas para funcionar sin internet.
- **Backend:** Supabase (Postgres 17, Auth, Realtime), proyecto `comanda-app` en São Paulo (`mosfrmkbutyqqckjnkkd`).
- **Lógica de negocio en la base:** totales, numeración de comandas, descuento de stock y arqueo viven en triggers de Postgres, así ningún cliente (ni uno offline que sincroniza tarde) puede dejar datos inconsistentes.

## Estructura

```
supabase/migrations/   Esquema versionado (aplicar en orden)
src/lib/               Cliente Supabase, sesión, local actual, tipos, formatos
src/components/        Estructura de la app (navegación, barra superior)
src/pages/             Pantallas
tests/e2e/             Prueba de punta a punta con Playwright + backend simulado
```

## Pruebas

```bash
npm run build && npx vite preview --port 4173 &
cd tests/e2e && python3 test_flows.py
```

La prueba e2e usa un backend simulado (`tests/e2e/fake_supabase.py`) para no depender de la red.
La lógica de la base se prueba con escenarios SQL dentro de una transacción que se descarta (ver `CLAUDE.md`).

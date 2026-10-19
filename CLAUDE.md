# Comandá — guía para Claude

App de gestión para restaurantes (competidor de Fudo, fu.do). El análisis competitivo y el roadmap están en
el doc "Análisis competitivo: Fudo y bases para nuestra app gastronómica" de la cuenta del usuario.
El usuario escribe en español rioplatense: responder igual. Todo texto de interfaz va en español (Argentina).

## Decisiones tomadas (no reabrir sin preguntar)

- **PWA primero**, no app nativa. Mobile-first, con layout de tablet/PC desde 900 px.
- **Segmento del MVP:** restaurante con salón (mesas, mozos, cocina, caja).
- **Supabase** proyecto `comanda-app`, id `mosfrmkbutyqqckjnkkd`, org ALTech, región sa-east-1.
- **Multi-local (multi-tenant):** toda tabla de negocio tiene `restaurant_id`; las hijas referencian con FK
  compuesta `(restaurant_id, id)` para que sea imposible mezclar datos entre locales.
- **Lógica de negocio en Postgres** (triggers `security definer`), no en el cliente:
  - `orders.number` lo asigna el servidor; los `id` uuid pueden generarse en el dispositivo (offline).
  - `orders.subtotal/total/paid_total` se recalculan solos desde `order_items` y `payments`.
  - Una comanda no cierra sin estar paga; no se anula con pagos; cerrada no admite cambios de ítems
    (solo avanzar el estado de cocina).
  - El stock vive solo en `ingredients` y solo cambia vía `stock_movements`. Al cerrar una comanda se
    descuenta por receta; si sale de "cerrada" se devuelve. Un producto "tal cual" (gaseosa) = receta de
    1 unidad de su insumo.
  - `close_cash_session(session, contado)` calcula el efectivo esperado (apertura + cobros en efectivo con
    propina + ingresos − retiros).
- **Pagos se anulan** con `voided_at`, nunca se borran.
- **Roles:** owner, manager, cashier, waiter, kitchen. Matriz en `supabase/migrations/20261019120300_rls_and_rpc.sql`.
  Helpers de RLS en schema `private` (`private.is_member`, `private.has_role`), fuera de la API.
- **Alta de local:** RPC `create_restaurant(nombre, mesas)` crea el local con dueño, estaciones Cocina/Barra,
  Caja principal, medios de pago y un salón con N mesas.
- **Realtime** publicado en `orders`, `order_items`, `payments` (respeta RLS).

## Diseño

Sistema en `src/styles.css`. Verde botella `--bottle` (marca, mesas ocupadas), mostaza `--mustard` (algo
espera acción), tomate `--tomato` (demora/error), papel `--paper` solo para tickets/comandas.
Barlow Condensed para números grandes (mesas, totales), Barlow para el resto. Objetivo táctil mínimo 48 px.
Texto de interfaz: oraciones cortas, verbos concretos, sin disculpas en errores.

## Cómo trabajar

- **Migraciones:** archivo nuevo en `supabase/migrations/` con timestamp, y aplicarlo con el MCP de
  Supabase (`apply_migration`) con el mismo contenido. Después: `get_advisors` (security y performance)
  y actualizar `src/lib/database.types.ts`.
- **Probar lógica de base:** bloque `do $$ … raise exception 'RESULTADO: %', log; $$` que crea usuarios
  en `auth.users`, simula sesión con `set_config('request.jwt.claims', …)` + `set_config('role','authenticated')`
  y termina con excepción para que todo se descarte.
- **Probar la UI:** `npm run build`, `npx vite preview --port 4173`, `python3 tests/e2e/test_sprint0.py`.
  El sandbox no llega a supabase.co, por eso la e2e usa `tests/e2e/fake_supabase.py`; extenderlo con los
  endpoints nuevos de cada sprint. Chromium necesita `--proxy-server` y `--proxy-bypass-list=127.0.0.1;localhost`
  (ya en el script). Mirar los screenshots en `tests/e2e/screenshots/`.
- `npm run build` corre `tsc` estricto (`noUncheckedIndexedAccess`): tiene que pasar sin errores.

## Pendientes conocidos

- Invitar miembros al equipo (necesita RPC que busque usuario por email o invitación por link).
- Modo offline real: hoy la PWA cachea la app, pero los datos requieren conexión. Plan: cola local
  (IndexedDB) de operaciones con uuid generados en el dispositivo + sincronización.
- Deploy público (Cloudflare Pages o similar) y dominio.
- Confirmación de email: Supabase usa el SMTP por defecto (límite bajo); configurar SMTP propio antes de pilotos.

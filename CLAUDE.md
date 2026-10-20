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
  - Precio de ítems: el trigger `order_items_enrich` toma nombre, precio y estación del producto y
    reconstruye los modificadores desde sus ids (el cliente manda `modifiers: [{id}]`). El dispositivo no
    puede imponer precios. Validación de mínimos/máximos de cada grupo: hoy solo en el cliente (`validateSelection`).
  - Pagos (`payments_before_insert`): solo sobre comandas abiertas, nunca más de lo que falta, se
    asocian a la caja abierta del local; el efectivo exige caja abierta.
  - Descuentos (`orders.discount_amount`): solo owner/manager/cashier (chequeo en `orders_before_update`).
  - Al cerrar una comanda, los ítems pendientes pasan a `sent` (venta de mostrador cobrada antes).
  - `ingredients.stock_qty` está protegido (`ingredients_guard_stock`): solo lo cambia `apply_stock_movement`
    (bandera `comanda.stock_write`); al crear un insumo arranca en 0 y el inicial se carga como movimiento
    `adjustment` "Stock inicial". Conteo con RPC `stock_count(insumo, contado)`.
  - Reportes: RPC `sales_report(local, desde, hasta)` (solo owner/manager) devuelve totales, por hora/día en
    la zona del local, medios de pago, canales y productos con costo según receta y costo actual.
- **Pagos se anulan** con `voided_at`, nunca se borran.
- **Roles:** owner, manager, cashier, waiter, kitchen. Matriz en `supabase/migrations/20261019120300_rls_and_rpc.sql`.
  Helpers de RLS en schema `private` (`private.is_member`, `private.has_role`), fuera de la API.
- **Equipo e invitaciones:** `restaurant_invites` = link de un solo uso (`/invitacion/<token>`, vence a los 7 días)
  con rol fijo; lo crean owner/manager (manager no invita dueños) y solo se anula (`revoked_at`). Se acepta con
  RPC `accept_invite(token)` y se previsualiza con `invite_preview(token)` (security definer, solo authenticated).
  El token se guarda en el dispositivo (`lib/invites.ts`) hasta iniciar sesión; el signup redirige al mismo link.
  Trigger `restaurant_members_keep_owner`: un local nunca se queda sin dueño activo. Pantalla `pages/Equipo.tsx`.
- **Mercado Pago (QR dinámico, API de Orders):** edge function `supabase/functions/mercadopago` (verify_jwt off;
  valida la sesión con `auth.getUser` y la pertenencia al local con la service role). Acciones `status`, `create`,
  `refresh`, `cancel` y `/mercadopago/webhook`. Secretos: `MP_ACCESS_TOKEN` (hoy el de prueba, de un usuario
  vendedor de prueba) y opcional `MP_WEBHOOK_SECRET`. Crea sola la sucursal y caja del local (`mp_pos`; city_name
  tiene que ser un barrio válido de MP, nombres sin tildes). Cada QR es un `mp_charges` (el cliente solo lee); el
  pago lo registra `mp_charge_settle` (solo service_role) una sola vez; si la comanda ya no lo admite, devuelve
  'refund' y la función reembolsa. El estado siempre se toma de `GET /v1/orders/{id}`, nunca del webhook.
  La app sigue el cobro por realtime + consulta cada 4 s (`useCharge`). Desplegar con `deploy_edge_function`.
  `pg_net` está habilitado para probar la función desde SQL.
- **Alta de local:** RPC `create_restaurant(nombre, mesas)` crea el local con dueño, estaciones Cocina/Barra,
  Caja principal, medios de pago y un salón con N mesas.
- **Realtime** publicado en `orders`, `order_items`, `payments` (respeta RLS).
- **Modo sin conexión** (`src/lib/offline.ts`, IndexedDB con idb-keyval):
  - Lecturas con `cachedQuery(clave, tabla, filtros, consulta)`: con red consulta y guarda; sin red devuelve
    la caché + los cambios pendientes superpuestos (`overlay`, incluye deltas de totales de comanda).
  - Escrituras con `write()` (vía los helpers de `lib/orders.ts`): si hay red y la cola está vacía, van
    directo; si no, a la cola (`outbox`) con uuid del dispositivo. Se envía en orden al volver la red y
    cada 20 s; un 23505 (ya existía) cuenta como aplicado; un rechazo de negocio va a `outbox-failed` y
    `SyncBar` lo muestra con su motivo para descartarlo.
  - Alcance sin red: abrir mesas y ventas de mostrador, cargar/cancelar/enviar ítems, estados de cocina.
    Cobros, caja, stock y administración piden conexión. El número de comanda llega al sincronizar.
  - Al cerrar sesión se borra la caché (`clearCache`), con confirmación si hay cambios pendientes.

- **Hosting:** Cloudflare Pages conectado a GitHub (`main` publica solo). Build `npm run build`, salida `dist`,
  Node 22 (`.node-version`). Las variables públicas de Supabase van en `.env.production` (no hace falta
  cargarlas en el panel). Sin `404.html`, Pages sirve `index.html` en cualquier ruta (SPA). Cabeceras en
  `public/_headers`. En Supabase Auth, la URL del sitio y las de redirección deben incluir el dominio publicado.

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
- **Probar la UI:** `npm run build`, `npx vite preview --port 4173`, `cd tests/e2e && python3 test_flows.py`.
  El sandbox no llega a supabase.co, por eso la e2e usa `tests/e2e/fake_supabase.py`; extenderlo con los
  endpoints nuevos de cada sprint. Chromium necesita `--proxy-server` y `--proxy-bypass-list=127.0.0.1;localhost`
  (ya en el script). Mirar los screenshots en `tests/e2e/screenshots/`.
- `npm run build` corre `tsc` estricto (`noUncheckedIndexedAccess`): tiene que pasar sin errores.

## Pantallas (src/pages)

Salón (mesas en vivo; mostaza = algo sin enviar o listo para servir) · Comandas (abiertas + venta de
mostrador) · Comanda (carta + pedido, envío a cocina, cancelar, marcar entregado, cobrar con
`components/PaySheet.tsx`) · Cocina (KDS oscuro, tickets por comanda/estación, semáforo 10/20 min, aviso
sonoro con Web Audio) · Caja (apertura, ingresos/retiros, resumen por medio de pago, cierre con arqueo;
`lib/cash.ts` replica el cálculo de `close_cash_session`) · Carta y Modificadores (owner/manager; la ficha
del producto incluye receta con costo y margen) · Stock (insumos, compra/merma/ajuste/conteo, historial,
alertas de faltante) · Reportes (`components/BarChart.tsx`: una serie, un tono, tooltip y tabla) · Inicio
(home de owner/manager: ventas de hoy, ahora, faltantes) · Equipo (personas, roles, links de invitación) ·
Invitación (aceptar) · Más. Owner/manager tienen pestañas Inicio,
Salón, Comandas, Caja, Más; Cocina para ellos está en Más.

## Pendientes conocidos

- Sin conexión no se puede cobrar (los pagos dependen de la caja abierta y del saldo en el servidor).
- Validar mínimos/máximos de modificadores también en el servidor.
- Caja: hoy se usa la primera caja activa del local; múltiples cajas y arqueo ciego quedan para más adelante.
- Impresión de comandas y precuentas (ESC/POS) todavía no está.
- El costo en reportes usa el costo actual de los insumos, no el histórico al momento de la venta.
- Cantidades con decimales se escriben con coma (es-AR): `parseAmount` toma el punto como separador de miles.
- Mercado Pago: hoy usa una sola cuenta (la de prueba de ALTech) para todos los locales. Para producción falta
  OAuth para que cada local vincule su cuenta, y cargar la dirección real del local en la sucursal de MP.
- Dominio propio (hoy el subdominio de pages.dev).
- Confirmación de email: Supabase usa el SMTP por defecto (límite bajo); configurar SMTP propio antes de pilotos.

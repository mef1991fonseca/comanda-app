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
  - `close_cash_session(session, contado)` (security definer, owner/manager/cashier) calcula el efectivo esperado
    (apertura + cobros en efectivo con propina + ingresos − retiros). Es la única forma de cerrar: las sesiones no
    se editan directo (`cash_sessions_guard`, bandera `comanda.cash_close`; sin política de update).
  - **Varias cajas:** `registers` (owner/manager; nombre único entre activas; no se desactiva una abierta). Cada
    equipo elige su caja (`getDeviceRegister`/`deviceSessionId` en `lib/cash.ts`, en localStorage) y la manda en
    los cobros (`payments.cash_session_id`, `p_session` en `customer_payment`/`supplier_payment`,
    `paid.cash_session_id` en `register_purchase`). `private.pick_cash_session` decide: la pedida (abierta y del
    local), la que abrió esa persona, la única abierta; con varias y efectivo, exige elegir; otros medios van a la
    más antigua. Movimientos de caja solo en sesiones abiertas (`cash_movements_guard`).
  - **Arqueo ciego** (`registers.blind_close`): el cajero no ve esperado ni diferencia (pantalla Caja y la
    respuesta de `close_cash_session`); dueño y encargado sí. Es ocultamiento de interfaz: por RLS el cajero
    igual puede leer pagos y sesiones.
  - Precio de ítems: el trigger `order_items_enrich` toma nombre, precio y estación del producto y
    reconstruye los modificadores desde sus ids (el cliente manda `modifiers: [{id}]`). El dispositivo no
    puede imponer precios. También valida mínimos/máximos de cada grupo del producto y que no se repita una
    opción; un grupo obligatorio con menos opciones activas que su mínimo exige solo las que hay (igual que
    `validateSelection` en el cliente).
  - Pagos (`payments_before_insert`): solo sobre comandas abiertas, nunca más de lo que falta, se
    asocian a una caja abierta (`pick_cash_session`); el efectivo exige caja abierta.
  - Descuentos (`orders.discount_amount`): solo owner/manager/cashier (chequeo en `orders_before_update`).
  - Al cerrar una comanda, los ítems pendientes pasan a `sent` (venta de mostrador cobrada antes).
  - `ingredients.stock_qty` está protegido (`ingredients_guard_stock`): solo lo cambia `apply_stock_movement`
    (bandera `comanda.stock_write`); al crear un insumo arranca en 0 y el inicial se carga como movimiento
    `adjustment` "Stock inicial". Conteo con RPC `stock_count(insumo, contado)`.
  - Reportes: RPC `sales_report(local, desde, hasta)` (solo owner/manager) devuelve totales, por hora/día en
    la zona del local, medios de pago, canales y productos con costo.
  - Costo histórico: al cerrar una comanda, `orders_capture_cost` → `private.capture_item_costs` guarda en
    `order_items.unit_cost` el costo por unidad (receta × costo del insumo en ese momento; null = sin receta).
    Solo lo escribe el servidor (bandera `comanda.cost_write`); reportes y estado de resultados usan ese valor.
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
  **Cuenta propia por local (OAuth):** acciones `status`/`connect`/`disconnect` (con `restaurant_id`) y `GET /mercadopago/oauth`
  (vuelta de MP: canjea el `code` con PKCE S256, guarda y redirige a `APP_URL/mercadopago?mp=conectado|error`).
  Secretos `MP_CLIENT_ID`, `MP_CLIENT_SECRET` (aplicación de ALTech; redirect URL = `<SUPABASE_URL>/functions/v1/mercadopago/oauth`),
  opcionales `MP_OAUTH_PKCE=0` y `APP_URL`. Tablas `mp_accounts` (los miembros leen), `mp_credentials` y
  `mp_oauth_states` (sin políticas, solo service role). `accountFor(local)` usa el token del local y lo renueva con
  refresh_token si vence en menos de 15 días; si el local no vinculó, usa `MP_ACCESS_TOKEN`. Al cambiar de cuenta se
  borra `mp_pos` (sucursal y caja son de cada cuenta). Vincular: owner/manager; desvincular: solo owner y sin QR pendiente.
  Pantalla `pages/MercadoPago.tsx` (Más → Mercado Pago).
- **ARCA (factura electrónica, hoy homologación):** edge function `supabase/functions/arca` (node-forge).
  Modelo de proveedor: un certificado de ALTech firma por todos los locales; cada local delega WSFE a ese CUIT
  y factura con su CUIT (`fiscal_settings`, editable solo por owner; `environment` lo cambia solo soporte).
  Clave privada, certificado, CUIT del proveedor y `arca_admin_key` en Vault (`arca_get_secret`/`arca_put_secret`,
  solo service_role). Acciones de admin con header `x-admin-key` (se llaman desde SQL con `net.http_post`):
  `csr`, `set_cert`, `test`. Acción con sesión `invoice`: Factura C (monotributo) o B/A con IVA 21 %
  (responsable inscripto); pide el último número, reintenta ante 10016 y guarda el CAE en `invoices`
  (el cliente solo lee). Ticket WSAA cacheado en `arca_tokens` (ARCA no da otro mientras esté vigente).
  Pantallas: Más → Facturación, cierre "Cerrar y facturar" en el cobro, Comandas → Cerradas (últimos 7 días, filtro
  "Solo sin factura", botón Facturar con fecha de hoy; owner/manager/cashier), `/factura/:id` imprimible con QR fiscal.
  Notas de crédito (acción `credit_note`, owner/manager): por el total, tipo 3/8/13 con `CbtesAsoc`, en la misma
  tabla `invoices` (`associated_id` → factura; la factura guarda `credit_note_id`). Una factura vigente por comanda
  (índice parcial sin `credit_note_id`), así que después de anular se puede facturar de nuevo desde `/factura/:id`.
- **Operación de salón:** `orders.waiter_id` (por defecto quien abre; trigger `orders_salon_guard` exige que sea
  del equipo y que solo se cambie de mesa una comanda abierta). RPC `merge_orders(destino, origen)`: pasa los
  ítems, recalcula el destino, suma comensales y anula el origen ("Unida a la comanda #N"); no une comandas con
  pagos. En la app: botón Opciones de la comanda (`components/OrderActions.tsx`), mozo en las mesas del salón y
  filtro "Mis mesas" para mozos. Dividir la cuenta (en partes o por productos) solo sugiere el monto del pago.
- **Clientes y cuenta corriente:** `customers` (doc para facturar, límite de cuenta) y `customer_movements`
  (+ debe / − pagó; nadie los escribe directo). Medio de pago `account` ("Cuenta corriente", trigger
  `restaurants_add_account_method` en locales nuevos): exige `orders.customer_id`, respeta el límite, no admite
  propina (`payments_xaccount_check`) y genera el cargo; anular el pago genera la reversa
  (`payments_account_movement`). Cobro de deuda con RPC `customer_payment` (owner/manager/cashier; en efectivo
  entra a la caja abierta como `cash_movements` 'in'). Saldos en la vista `customer_balances` (security_invoker).
  Pantallas: Más → Clientes, ficha `/clientes/:id`, cliente de la comanda en Opciones; la factura toma sus datos.
- **Proveedores, compras y gastos:** `suppliers`, `purchases` (+ `purchase_items`) con categoría de gasto
  (`expense_category`) y `supplier_movements` (+ le debemos / − pagamos; vista `supplier_balances`). Todo se
  escribe por RPC: `register_purchase(jsonb)` (owner/manager; renglones con insumo generan `stock_movements`
  'purchase' con costo unitario = importe/cantidad; el total puede sumar impuestos y otros cargos; opcional pago en
  el momento), `supplier_payment` (owner/manager/cashier; efectivo sale de la caja abierta como retiro) y
  `cancel_purchase` (devuelve stock y deuda; el costo del insumo no vuelve atrás). Pantallas: Más → Compras y
  gastos (`/compras`, `/compras/nueva`, `/proveedores/:id`).
- **Carta QR:** `restaurants.menu_slug/menu_public/menu_note`; RPC `set_public_menu` (owner/manager) y
  `public_menu(slug)` (única puerta para `anon`: nombre, descripción, precio y opciones de productos activos; nada
  de costos ni stock). Ruta pública `/m/:slug?mesa=N` (`pages/PublicMenu.tsx`), que `App` atiende antes del login.
  Pantallas: Más → Carta QR (`/carta/qr`) e `/imprimir/qr` (un QR por mesa + uno general).
- **Estado de resultados:** RPC `income_statement(local, meses)` (owner/manager, security invoker, meses en la zona del
  local): ventas de comandas cerradas, costo de lo vendido con el costo guardado al cerrar, gastos por categoría (compras
  no anuladas por fecha del comprobante, sin mercadería ni bebidas porque van a stock y ya entran como costo),
  compras de mercadería y propinas informativas, y ventas sin receta. Resultado = ventas − costo − gastos, se calcula
  en el cliente. Pantalla `pages/Resultados.tsx` (Más → Estado de resultados).
- **Impresión:** `/imprimir/precuenta/:id`, `/imprimir/cocina/:id` (`?items=` solo esos ítems, sale "AGREGADO" si ya
  había otros enviados) y `/imprimir/prueba` (`pages/Imprimir.tsx`), con la impresión del navegador (páginas con nombre
  `@page receipt` 80 mm y `receipt58` 58 mm; el resto imprime en A4). Configuración por equipo en `lib/printer.ts`
  (localStorage): ancho de papel, `autoKitchen` y estaciones. Con `autoKitchen`, `useKitchenAutoPrint` (montado en
  `AppShell`) escucha `order_items` por realtime + cada 15 s e imprime lo recién enviado en un iframe oculto
  (`printInBackground`, `?embed=1`, avisa con postMessage); recuerda lo impreso (`comanda.printed.<local>`) y al
  activarse da por impreso lo que ya estaba en cocina. Sin diálogo: Chrome/Edge abierto con `--kiosk-printing` y la
  impresora como predeterminada (instrucciones en Más → Impresora, `pages/Impresora.tsx`). Windows no deja usar
  WebUSB con impresoras que tienen driver, por eso no hay ESC/POS directo.
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
  - Alcance sin red: abrir mesas y ventas de mostrador, cargar/cancelar/enviar ítems, estados de cocina,
    cobrar en efectivo, tarjeta o transferencia (`OFFLINE_PAYMENT_KINDS`, helpers `addPayment`/`closeOrder` de
    `lib/orders.ts`; el pago va con `reference` "Cobrado sin conexión" y la caja del equipo tomada de la caché
    `cash:open:<local>`) y cerrar la comanda sin factura. Los deltas `paid` muestran lo cobrado mientras está
    pendiente. Mercado Pago, cuenta corriente, descuentos, anular pagos, facturar, caja, stock y administración
    piden conexión. El número de comanda llega al sincronizar. Un cobro rechazado al sincronizar (comanda ya
    cerrada por otro equipo, monto de más, caja cerrada) queda en `outbox-failed` y `SyncBar` avisa que es plata
    sin registrar.
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
mostrador; pestaña Cerradas para facturar) · Comanda (carta + pedido, envío a cocina, cancelar, marcar entregado, cobrar con
`components/PaySheet.tsx`) · Cocina (KDS oscuro, tickets por comanda/estación, semáforo 10/20 min, aviso
sonoro con Web Audio) · Caja (selector de caja del equipo, apertura, ingresos/retiros, resumen por medio de pago, cierre con arqueo o arqueo ciego, "Administrar cajas";
`lib/cash.ts` replica el cálculo de `close_cash_session`) · Carta y Modificadores (owner/manager; la ficha
del producto incluye receta con costo y margen) · Stock (insumos, compra/merma/ajuste/conteo, historial,
alertas de faltante) · Reportes (`components/BarChart.tsx`: una serie, un tono, tooltip y tabla) · Estado de resultados · Inicio
(home de owner/manager: ventas de hoy, ahora, faltantes) · Equipo (personas, roles, links de invitación) ·
Invitación (aceptar) · Impresora (por equipo) · Más. Owner/manager tienen pestañas Inicio,
Salón, Comandas, Caja, Más; Cocina para ellos está en Más.

## Pendientes conocidos

- Sin conexión no se cobra con Mercado Pago ni cuenta corriente, ni se factura (se factura después desde Comandas → Cerradas).
- Caja: el arqueo ciego oculta en la interfaz; para que sea estricto habría que restringir por RLS la lectura de pagos del cajero.
- Impresión: ESC/POS directo (WebUSB/Bluetooth) para celulares Android; hoy la impresión automática necesita una PC con la app abierta.
- Cantidades con decimales se escriben con coma (es-AR): `parseAmount` toma el punto como separador de miles.
- Mercado Pago: la vinculación por local está hecha pero necesita los secretos `MP_CLIENT_ID`/`MP_CLIENT_SECRET` de una
  aplicación de MP con credenciales de producción. Falta cargar la dirección real del local en la sucursal de MP.
- ARCA: notas de crédito parciales y pasar a producción (certificado de producción y delegación de cada local).
  Comandas cerradas hace más de 7 días no aparecen para facturar.
- Dominio propio (hoy el subdominio de pages.dev).
- Confirmación de email: Supabase usa el SMTP por defecto (límite bajo); configurar SMTP propio antes de pilotos.

-- =============================================================
-- Comandá · 004 · Seguridad (RLS), alta de local y tiempo real
-- =============================================================
-- Matriz de permisos:
--   owner    → todo
--   manager  → todo menos administrar dueños
--   cashier  → vender, cobrar, caja
--   waiter   → vender y cobrar (sin caja ni carta)
--   kitchen  → ver y avanzar el estado de los ítems (KDS)

-- -------------------------------------------------------------
-- Habilitar RLS en todas las tablas
-- -------------------------------------------------------------
alter table public.profiles                enable row level security;
alter table public.restaurants             enable row level security;
alter table public.restaurant_members      enable row level security;
alter table public.order_counters          enable row level security;  -- sin políticas: solo vía trigger
alter table public.orders                  enable row level security;
alter table public.order_items             enable row level security;
alter table public.payments                enable row level security;
alter table public.cash_sessions           enable row level security;
alter table public.cash_movements          enable row level security;
alter table public.stock_movements         enable row level security;

-- -------------------------------------------------------------
-- Tablas de configuración: las ve todo el equipo, las edita owner/manager
-- -------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'stations', 'categories', 'products', 'modifier_groups', 'modifiers',
    'product_modifier_groups', 'ingredients', 'recipe_items',
    'dining_areas', 'tables', 'registers', 'payment_methods'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_member(restaurant_id))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_role(restaurant_id, ''{owner,manager}''))',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_role(restaurant_id, ''{owner,manager}'')) with check (public.has_role(restaurant_id, ''{owner,manager}''))',
      t || '_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_role(restaurant_id, ''{owner,manager}''))',
      t || '_delete', t);
  end loop;
end;
$$;

-- -------------------------------------------------------------
-- Perfiles
-- -------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
        from public.restaurant_members mine
        join public.restaurant_members theirs on theirs.restaurant_id = mine.restaurant_id
       where mine.user_id = (select auth.uid())
         and theirs.user_id = profiles.id
    )
  );

create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- -------------------------------------------------------------
-- Locales (el alta se hace con la función create_restaurant)
-- -------------------------------------------------------------
create policy restaurants_select on public.restaurants for select to authenticated
  using (public.is_member(id));

create policy restaurants_update on public.restaurants for update to authenticated
  using (public.has_role(id, '{owner}'))
  with check (public.has_role(id, '{owner}'));

-- -------------------------------------------------------------
-- Miembros
-- -------------------------------------------------------------
create policy members_select on public.restaurant_members for select to authenticated
  using (public.is_member(restaurant_id));

create policy members_insert on public.restaurant_members for insert to authenticated
  with check (
    public.has_role(restaurant_id, '{owner}')
    or (public.has_role(restaurant_id, '{manager}') and role <> 'owner')
  );

create policy members_update on public.restaurant_members for update to authenticated
  using (
    public.has_role(restaurant_id, '{owner}')
    or (public.has_role(restaurant_id, '{manager}') and role <> 'owner')
  )
  with check (
    public.has_role(restaurant_id, '{owner}')
    or (public.has_role(restaurant_id, '{manager}') and role <> 'owner')
  );

create policy members_delete on public.restaurant_members for delete to authenticated
  using (
    public.has_role(restaurant_id, '{owner}')
    or (public.has_role(restaurant_id, '{manager}') and role <> 'owner')
  );

-- -------------------------------------------------------------
-- Comandas
-- -------------------------------------------------------------
create policy orders_select on public.orders for select to authenticated
  using (public.is_member(restaurant_id));

create policy orders_insert on public.orders for insert to authenticated
  with check (public.has_role(restaurant_id, '{owner,manager,cashier,waiter}'));

create policy orders_update on public.orders for update to authenticated
  using (public.has_role(restaurant_id, '{owner,manager,cashier,waiter}'))
  with check (public.has_role(restaurant_id, '{owner,manager,cashier,waiter}'));

create policy order_items_select on public.order_items for select to authenticated
  using (public.is_member(restaurant_id));

create policy order_items_insert on public.order_items for insert to authenticated
  with check (public.has_role(restaurant_id, '{owner,manager,cashier,waiter}'));

create policy order_items_update on public.order_items for update to authenticated
  using (public.has_role(restaurant_id, '{owner,manager,cashier,waiter,kitchen}'))
  with check (public.has_role(restaurant_id, '{owner,manager,cashier,waiter,kitchen}'));

-- Un ítem ya enviado a cocina solo lo borra owner/manager (para el resto: cancelar)
create policy order_items_delete on public.order_items for delete to authenticated
  using (
    public.has_role(restaurant_id, '{owner,manager}')
    or (status = 'pending' and public.has_role(restaurant_id, '{cashier,waiter}'))
  );

-- -------------------------------------------------------------
-- Pagos (se anulan con voided_at, nunca se borran)
-- -------------------------------------------------------------
create policy payments_select on public.payments for select to authenticated
  using (public.is_member(restaurant_id));

create policy payments_insert on public.payments for insert to authenticated
  with check (public.has_role(restaurant_id, '{owner,manager,cashier,waiter}'));

create policy payments_update on public.payments for update to authenticated
  using (public.has_role(restaurant_id, '{owner,manager}'))
  with check (public.has_role(restaurant_id, '{owner,manager}'));

-- -------------------------------------------------------------
-- Caja
-- -------------------------------------------------------------
create policy cash_sessions_select on public.cash_sessions for select to authenticated
  using (public.is_member(restaurant_id));

create policy cash_sessions_insert on public.cash_sessions for insert to authenticated
  with check (public.has_role(restaurant_id, '{owner,manager,cashier}'));

create policy cash_sessions_update on public.cash_sessions for update to authenticated
  using (public.has_role(restaurant_id, '{owner,manager,cashier}'))
  with check (public.has_role(restaurant_id, '{owner,manager,cashier}'));

create policy cash_movements_select on public.cash_movements for select to authenticated
  using (public.is_member(restaurant_id));

create policy cash_movements_insert on public.cash_movements for insert to authenticated
  with check (public.has_role(restaurant_id, '{owner,manager,cashier}'));

-- -------------------------------------------------------------
-- Stock: movimientos manuales solo owner/manager (las ventas los genera el sistema)
-- -------------------------------------------------------------
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (public.is_member(restaurant_id));

create policy stock_movements_insert on public.stock_movements for insert to authenticated
  with check (
    public.has_role(restaurant_id, '{owner,manager}')
    and reason in ('purchase', 'adjustment', 'waste', 'count')
  );

-- =============================================================
-- Alta de un local con su configuración inicial
-- =============================================================
create or replace function public.create_restaurant(p_name text, p_tables int default 10)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := (select auth.uid());
  v_id    uuid;
  v_area  uuid;
  i       int;
begin
  if v_user is null then
    raise exception 'Necesitás iniciar sesión' using errcode = '28000';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'El nombre del local es obligatorio' using errcode = '22023';
  end if;
  if p_tables < 0 or p_tables > 200 then
    raise exception 'Cantidad de mesas inválida' using errcode = '22023';
  end if;

  insert into public.restaurants (name, created_by)
  values (trim(p_name), v_user)
  returning id into v_id;

  insert into public.restaurant_members (restaurant_id, user_id, role)
  values (v_id, v_user, 'owner');

  insert into public.stations (restaurant_id, name, sort_order)
  values (v_id, 'Cocina', 0), (v_id, 'Barra', 1);

  insert into public.registers (restaurant_id, name)
  values (v_id, 'Caja principal');

  insert into public.payment_methods (restaurant_id, name, kind, sort_order) values
    (v_id, 'Efectivo',      'cash',        0),
    (v_id, 'Débito',        'debit',       1),
    (v_id, 'Crédito',       'credit',      2),
    (v_id, 'Transferencia', 'transfer',    3),
    (v_id, 'Mercado Pago',  'mercadopago', 4);

  insert into public.dining_areas (restaurant_id, name)
  values (v_id, 'Salón')
  returning id into v_area;

  for i in 1 .. p_tables loop
    insert into public.tables (restaurant_id, area_id, name, sort_order, pos_x, pos_y)
    values (v_id, v_area, i::text, i, (i - 1) % 5, (i - 1) / 5);
  end loop;

  return v_id;
end;
$$;

revoke execute on function public.create_restaurant(text, int) from public, anon;
grant execute on function public.create_restaurant(text, int) to authenticated;

-- =============================================================
-- Tiempo real: comandas y cocina se actualizan al instante entre dispositivos
-- (Realtime respeta las políticas RLS de arriba)
-- =============================================================
alter publication supabase_realtime add table public.orders, public.order_items, public.payments;

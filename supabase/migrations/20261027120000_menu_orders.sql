-- =============================================================
-- Pedidos desde la carta QR
-- El cliente arma el pedido en /m/<slug>?mesa=N y lo manda. Queda "esperando" hasta que alguien del
-- salón lo acepta (se suma a la comanda abierta de esa mesa, o abre una, y va a cocina) o lo rechaza.
-- El cliente nunca escribe en orders/order_items: solo en menu_orders y solo con public_menu_order().
-- =============================================================

alter table public.restaurants
  add column menu_ordering boolean not null default false;

create type public.menu_order_status as enum ('pending', 'accepted', 'rejected');

create table public.menu_orders (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  table_id      uuid not null,
  customer_name text check (char_length(customer_name) <= 40),
  note          text check (char_length(note) <= 200),
  -- Renglones ya resueltos por el servidor: [{product_id, name, quantity, unit_price, modifiers:[{id,name,price_delta}], notes}]
  items         jsonb not null check (jsonb_typeof(items) = 'array'),
  total         numeric(12, 2) not null,
  status        public.menu_order_status not null default 'pending',
  order_id      uuid,
  reject_reason text check (char_length(reject_reason) <= 120),
  handled_by    uuid references auth.users (id),
  handled_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, table_id) references public.tables (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, order_id) references public.orders (restaurant_id, id) on delete set null (order_id)
);

create index menu_orders_pending_idx on public.menu_orders (restaurant_id, status, created_at desc);
create index menu_orders_table_idx on public.menu_orders (table_id);
create index menu_orders_order_idx on public.menu_orders (order_id);
create index menu_orders_handled_by_idx on public.menu_orders (handled_by);

alter table public.menu_orders enable row level security;
create policy menu_orders_select on public.menu_orders for select to authenticated
  using (private.is_member(restaurant_id));

alter publication supabase_realtime add table public.menu_orders;

-- ---------- Resolver un renglón (mismas reglas que order_items_enrich) ----------
create or replace function private.menu_line(p_restaurant uuid, p_line jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product  record;
  v_mods_in  jsonb := coalesce(p_line -> 'modifiers', '[]'::jsonb);
  v_mods     jsonb;
  v_delta    numeric(12, 2);
  v_qty      int;
  v_notes    text := nullif(trim(coalesce(p_line ->> 'notes', '')), '');
  v_bad      record;
begin
  begin
    v_qty := (p_line ->> 'quantity')::int;
  exception when others then
    v_qty := null;
  end;
  if v_qty is null or v_qty < 1 or v_qty > 20 then
    raise exception 'La cantidad va de 1 a 20' using errcode = 'P0001';
  end if;
  if char_length(v_notes) > 120 then
    raise exception 'La aclaración de un plato puede tener hasta 120 letras' using errcode = 'P0001';
  end if;

  select p.id, p.name, p.price into v_product
    from public.products p
   where p.restaurant_id = p_restaurant and p.active
     and p.id = case when (p_line ->> 'product_id') ~ '^[0-9a-f-]{36}$' then (p_line ->> 'product_id')::uuid end;
  if not found then
    raise exception 'Uno de los platos ya no está disponible. Actualizá la carta.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_mods_in) <> 'array' or jsonb_array_length(v_mods_in) > 30 then
    raise exception 'Opciones inválidas' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_mods_in) e where (e ->> 'id') !~ '^[0-9a-f-]{36}$') then
    raise exception 'Opciones inválidas' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_array_elements(v_mods_in))
     <> (select count(distinct e ->> 'id') from jsonb_array_elements(v_mods_in) e) then
    raise exception 'Hay una opción repetida en %', v_product.name using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'price_delta', m.price_delta)
                            order by pmg.sort_order, m.sort_order, m.name), '[]'::jsonb),
         coalesce(sum(m.price_delta), 0)
    into v_mods, v_delta
    from jsonb_array_elements(v_mods_in) e
    join public.modifiers m on m.id = (e ->> 'id')::uuid and m.restaurant_id = p_restaurant and m.active
    join public.product_modifier_groups pmg on pmg.group_id = m.group_id and pmg.product_id = v_product.id;
  if jsonb_array_length(v_mods) <> jsonb_array_length(v_mods_in) then
    raise exception 'Alguna opción de % ya no está disponible. Actualizá la carta.', v_product.name using errcode = 'P0001';
  end if;

  select g.name, g.min_select, g.max_select, x.chosen, x.available into v_bad
    from public.product_modifier_groups pmg
    join public.modifier_groups g on g.id = pmg.group_id
    cross join lateral (
      select count(*) filter (where m.id in (select (e ->> 'id')::uuid from jsonb_array_elements(v_mods) e)) as chosen,
             count(*) as available
        from public.modifiers m where m.group_id = g.id and m.active
    ) x
   where pmg.product_id = v_product.id
     and (x.chosen < least(g.min_select, x.available) or x.chosen > g.max_select)
   order by pmg.sort_order, g.name
   limit 1;
  if found then
    if v_bad.chosen > v_bad.max_select then
      raise exception 'En % se pueden elegir hasta %', v_bad.name, v_bad.max_select using errcode = 'P0001';
    elsif least(v_bad.min_select, v_bad.available) = 1 then
      raise exception 'Elegí una opción de % (%)', v_bad.name, v_product.name using errcode = 'P0001';
    else
      raise exception 'Elegí al menos % en % (%)', least(v_bad.min_select, v_bad.available), v_bad.name, v_product.name using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'product_id', v_product.id, 'name', v_product.name, 'quantity', v_qty,
    'unit_price', v_product.price + v_delta, 'modifiers', v_mods, 'notes', v_notes
  );
end;
$$;

revoke all on function private.menu_line(uuid, jsonb) from public, anon, authenticated;

-- ---------- Mandar un pedido desde la carta (sin sesión) ----------
create or replace function public.public_menu_order(
  p_slug text, p_table text, p_items jsonb, p_name text default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest   uuid;
  v_table  uuid;
  v_lines  jsonb := '[]'::jsonb;
  v_line   jsonb;
  v_total  numeric(12, 2) := 0;
  v_id     uuid;
  v_name   text := nullif(trim(coalesce(p_name, '')), '');
  v_note   text := nullif(trim(coalesce(p_note, '')), '');
begin
  select r.id into v_rest from public.restaurants r
   where r.menu_slug = lower(p_slug) and r.menu_public and r.menu_ordering;
  if v_rest is null then
    raise exception 'Esta carta no recibe pedidos. Pedile al mozo.' using errcode = 'P0001';
  end if;

  select t.id into v_table from public.tables t
   where t.restaurant_id = v_rest and t.active and lower(t.name) = lower(trim(coalesce(p_table, '')))
   order by t.sort_order limit 1;
  if v_table is null then
    raise exception 'No encontramos esa mesa. Pedile al mozo.' using errcode = 'P0001';
  end if;

  if char_length(v_name) > 40 then
    raise exception 'El nombre puede tener hasta 40 letras' using errcode = 'P0001';
  end if;
  if char_length(v_note) > 200 then
    raise exception 'La nota puede tener hasta 200 letras' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agregá al menos un plato' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 30 then
    raise exception 'El pedido puede tener hasta 30 renglones' using errcode = 'P0001';
  end if;

  -- Freno al abuso: pocos pedidos esperando por mesa y por local
  if (select count(*) from public.menu_orders m
       where m.table_id = v_table and m.status = 'pending' and m.created_at > now() - interval '30 minutes') >= 3 then
    raise exception 'Esta mesa ya tiene pedidos esperando. Esperá que el mozo los confirme.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.menu_orders m
       where m.restaurant_id = v_rest and m.status = 'pending' and m.created_at > now() - interval '10 minutes') >= 40 then
    raise exception 'El local tiene muchos pedidos en este momento. Llamá al mozo.' using errcode = 'P0001';
  end if;

  for v_line in select value from jsonb_array_elements(p_items) loop
    v_line := private.menu_line(v_rest, v_line);
    v_lines := v_lines || jsonb_build_array(v_line);
    v_total := v_total + (v_line ->> 'unit_price')::numeric * (v_line ->> 'quantity')::int;
  end loop;

  insert into public.menu_orders (restaurant_id, table_id, customer_name, note, items, total)
  values (v_rest, v_table, v_name, v_note, v_lines, v_total)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'total', v_total);
end;
$$;

revoke all on function public.public_menu_order(text, text, jsonb, text, text) from public;
grant execute on function public.public_menu_order(text, text, jsonb, text, text) to anon, authenticated;

-- ---------- Estado del pedido, para la pantalla del cliente ----------
create or replace function public.public_menu_order_status(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('status', m.status, 'reject_reason', m.reject_reason, 'total', m.total,
                            'created_at', m.created_at, 'handled_at', m.handled_at)
    from public.menu_orders m
   where m.id = p_id
$$;

revoke all on function public.public_menu_order_status(uuid) from public;
grant execute on function public.public_menu_order_status(uuid) to anon, authenticated;

-- ---------- Aceptar: se suma a la comanda de la mesa (o abre una) y va a cocina ----------
create or replace function public.accept_menu_order(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mo    public.menu_orders%rowtype;
  v_order uuid;
  v_line  jsonb;
begin
  select * into v_mo from public.menu_orders where id = p_id for update;
  if not found or not private.has_role(v_mo.restaurant_id, '{owner,manager,cashier,waiter}') then
    raise exception 'No podés atender pedidos de este local' using errcode = '42501';
  end if;
  if v_mo.status <> 'pending' then
    raise exception 'Este pedido ya lo atendió otra persona' using errcode = 'P0001';
  end if;

  select o.id into v_order from public.orders o
   where o.restaurant_id = v_mo.restaurant_id and o.table_id = v_mo.table_id and o.status = 'open'
   order by o.opened_at desc limit 1;

  if v_order is null then
    insert into public.orders (restaurant_id, type, table_id, customer_name, waiter_id, created_by)
    values (v_mo.restaurant_id, 'dine_in', v_mo.table_id, v_mo.customer_name, auth.uid(), auth.uid())
    returning id into v_order;
  end if;

  if v_mo.note is not null then
    update public.orders
       set notes = concat_ws(' · ', nullif(notes, ''), 'Carta QR: ' || v_mo.note)
     where id = v_order;
  end if;

  for v_line in select value from jsonb_array_elements(v_mo.items) loop
    insert into public.order_items (restaurant_id, order_id, product_id, name, unit_price, quantity, modifiers, notes, status, created_by)
    values (v_mo.restaurant_id, v_order, (v_line ->> 'product_id')::uuid, v_line ->> 'name', 0,
            (v_line ->> 'quantity')::int,
            coalesce((select jsonb_agg(jsonb_build_object('id', m ->> 'id')) from jsonb_array_elements(v_line -> 'modifiers') m), '[]'::jsonb),
            v_line ->> 'notes', 'sent', auth.uid());
  end loop;

  update public.menu_orders
     set status = 'accepted', order_id = v_order, handled_by = auth.uid(), handled_at = now()
   where id = p_id;
  return v_order;
end;
$$;

revoke all on function public.accept_menu_order(uuid) from public, anon;
grant execute on function public.accept_menu_order(uuid) to authenticated;

create or replace function public.reject_menu_order(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mo public.menu_orders%rowtype;
begin
  select * into v_mo from public.menu_orders where id = p_id for update;
  if not found or not private.has_role(v_mo.restaurant_id, '{owner,manager,cashier,waiter}') then
    raise exception 'No podés atender pedidos de este local' using errcode = '42501';
  end if;
  if v_mo.status <> 'pending' then
    raise exception 'Este pedido ya lo atendió otra persona' using errcode = 'P0001';
  end if;
  update public.menu_orders
     set status = 'rejected', reject_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 120),
         handled_by = auth.uid(), handled_at = now()
   where id = p_id;
end;
$$;

revoke all on function public.reject_menu_order(uuid, text) from public, anon;
grant execute on function public.reject_menu_order(uuid, text) to authenticated;

-- ---------- Activar o pausar los pedidos (dueño o encargado) ----------
create or replace function public.set_menu_ordering(p_restaurant uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_role(p_restaurant, '{owner,manager}') then
    raise exception 'Solo el dueño o el encargado cambian esto' using errcode = '42501';
  end if;
  update public.restaurants set menu_ordering = coalesce(p_enabled, false) where id = p_restaurant;
end;
$$;

revoke all on function public.set_menu_ordering(uuid, boolean) from public, anon;
grant execute on function public.set_menu_ordering(uuid, boolean) to authenticated;

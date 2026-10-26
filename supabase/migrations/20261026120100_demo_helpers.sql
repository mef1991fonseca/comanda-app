-- Local de demostración (2): ayudantes internos (solo los usan las funciones demo_*).

create or replace function private.demo_guard(p_restaurant uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant and r.is_demo)
     or not private.has_role(p_restaurant, '{owner}') then
    raise exception 'Solo el dueño de un local de demostración puede hacer esto' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.demo_guard(uuid) from public, anon, authenticated;

-- ---------- Una venta completa (comanda, ítems, pagos y cierre) en un momento dado ----------
create or replace function private.demo_sale(
  p_restaurant uuid, p_session uuid, p_at timestamptz, p_table uuid, p_type public.order_type,
  p_name text, p_customer uuid, p_close boolean, p_item_status public.item_status
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid;
  v_lines int := 1 + floor(random() * 3)::int + case when p_table is not null then 1 else 0 end;
  v_prod record;
  v_mods jsonb;
  v_total numeric;
  v_method uuid;
  v_kind public.payment_kind;
  v_tip numeric := 0;
  v_split numeric;
  r float8;
  i int;
begin
  insert into public.orders (restaurant_id, type, table_id, customer_name, customer_id, guests, opened_at)
  values (p_restaurant, p_type, p_table, p_name, p_customer,
          case when p_table is not null then 1 + floor(random() * 4)::int end, p_at)
  returning id into v_order;

  for i in 1 .. v_lines loop
    -- Productos con peso: los favoritos salen más
    select p.id, p.station_id into v_prod
      from public.products p
     where p.restaurant_id = p_restaurant and p.active
       and (i > 1 or p.station_id is distinct from (select s.id from public.stations s where s.restaurant_id = p_restaurant and s.name = 'Barra'))
     order by random() * (case when p.is_favorite then 3 else 1 end) desc
     limit 1;
    -- Una opción al azar de cada grupo obligatorio
    select coalesce(jsonb_agg(jsonb_build_object('id', pick.id)), '[]'::jsonb) into v_mods
      from public.product_modifier_groups pmg
      join public.modifier_groups g on g.id = pmg.group_id and g.min_select > 0
      cross join lateral (
        select m.id from public.modifiers m where m.group_id = g.id and m.active order by random() limit 1
      ) pick
     where pmg.product_id = v_prod.id;
    insert into public.order_items (restaurant_id, order_id, product_id, name, unit_price, quantity, modifiers, status, sent_at, ready_at)
    values (p_restaurant, v_order, v_prod.id, 'x', 0, case when random() < 0.2 then 2 else 1 end, v_mods, p_item_status,
            case when p_item_status <> 'pending' then p_at + interval '4 minutes' end,
            case when p_item_status in ('ready', 'delivered') then p_at + interval '18 minutes' end);
  end loop;

  -- Una bebida por mesa casi siempre
  if p_table is not null and random() < 0.8 then
    select p.id into v_prod from public.products p
      join public.stations s on s.id = p.station_id and s.name = 'Barra'
     where p.restaurant_id = p_restaurant and p.active order by random() limit 1;
    insert into public.order_items (restaurant_id, order_id, product_id, name, unit_price, quantity, status, sent_at, ready_at)
    values (p_restaurant, v_order, v_prod.id, 'x', 0, 1 + floor(random() * 2)::int, p_item_status,
            case when p_item_status <> 'pending' then p_at + interval '2 minutes' end,
            case when p_item_status in ('ready', 'delivered') then p_at + interval '6 minutes' end);
  end if;

  if not p_close then
    return v_order;
  end if;

  -- Descuento de vez en cuando
  if random() < 0.06 then
    update public.orders set discount_amount = round(subtotal * 0.1, -2) where id = v_order;
  end if;
  select total into v_total from public.orders where id = v_order;

  r := random();
  select pm.id, pm.kind into v_method, v_kind
    from public.payment_methods pm
   where pm.restaurant_id = p_restaurant
     and pm.kind = case
                     when p_customer is not null then 'account'::public.payment_kind
                     when r < 0.42 then 'cash'
                     when r < 0.67 then 'debit'
                     when r < 0.82 then 'credit'
                     when r < 0.92 then 'mercadopago'
                     else 'transfer'
                   end
   limit 1;
  if v_kind not in ('account', 'mercadopago') and p_table is not null and random() < 0.35 then
    v_tip := round(v_total * 0.1, -2);
  end if;

  -- A veces pagan entre dos: mitad en efectivo y mitad con débito
  if p_customer is null and p_table is not null and random() < 0.12 then
    v_split := round(v_total / 2, -2);
    insert into public.payments (restaurant_id, order_id, payment_method_id, amount, tip, cash_session_id, created_at)
    select p_restaurant, v_order, pm.id, v_split, 0, p_session, p_at + interval '48 minutes'
      from public.payment_methods pm where pm.restaurant_id = p_restaurant and pm.kind = 'cash' limit 1;
    insert into public.payments (restaurant_id, order_id, payment_method_id, amount, tip, cash_session_id, created_at)
    select p_restaurant, v_order, pm.id, v_total - v_split, v_tip, p_session, p_at + interval '49 minutes'
      from public.payment_methods pm where pm.restaurant_id = p_restaurant and pm.kind = 'debit' limit 1;
  else
    insert into public.payments (restaurant_id, order_id, payment_method_id, amount, tip, cash_session_id, created_at, reference)
    values (p_restaurant, v_order, v_method, v_total, v_tip, p_session, p_at + interval '48 minutes',
            case when v_kind = 'mercadopago' then 'QR Mercado Pago (demo)' end);
  end if;

  update public.orders
     set status = 'closed',
         closed_at = p_at + case when p_table is not null then interval '55 minutes' else interval '12 minutes' end
   where id = v_order;
  return v_order;
end;
$$;

revoke all on function private.demo_sale(uuid, uuid, timestamptz, uuid, public.order_type, text, uuid, boolean, public.item_status) from public, anon, authenticated;

-- ---------- Abrir una caja con fecha pasada ----------
create or replace function private.demo_open_session(p_restaurant uuid, p_at timestamptz, p_opening numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session uuid;
begin
  insert into public.cash_sessions (restaurant_id, register_id, opening_amount)
  select p_restaurant, r.id, p_opening from public.registers r
   where r.restaurant_id = p_restaurant and r.active order by r.created_at limit 1
  returning id into v_session;
  perform set_config('comanda.cash_close', 'on', true);
  update public.cash_sessions set opened_at = p_at where id = v_session;
  perform set_config('comanda.cash_close', 'off', true);
  return v_session;
end;
$$;

revoke all on function private.demo_open_session(uuid, timestamptz, numeric) from public, anon, authenticated;

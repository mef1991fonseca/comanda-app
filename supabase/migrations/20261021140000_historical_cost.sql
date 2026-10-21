-- =============================================================
-- Costo histórico de lo vendido
--   order_items.unit_cost = costo por unidad según receta y costo de los insumos en el momento de cerrar
--   la comanda (null = el producto no tenía receta). Lo escribe solo el servidor.
--   Reportes y estado de resultados usan este costo: si después sube un insumo, los meses pasados no cambian.
-- =============================================================

alter table public.order_items add column unit_cost numeric(14, 4);

comment on column public.order_items.unit_cost is
  'Costo por unidad al cerrar la comanda (receta × costo del insumo). Null: sin receta. Solo lo escribe el servidor.';

-- El cliente no puede escribir el costo
create or replace function public.order_items_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.order_status;
begin
  if tg_op <> 'DELETE' and coalesce(current_setting('comanda.cost_write', true), '') <> 'on' then
    new.unit_cost := case when tg_op = 'UPDATE' then old.unit_cost else null end;
  end if;

  select o.status into v_status
    from public.orders o
   where o.id = coalesce(new.order_id, old.order_id);

  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status <> 'open' then
    if tg_op <> 'UPDATE'
       or new.quantity        is distinct from old.quantity
       or new.unit_price      is distinct from old.unit_price
       or new.modifiers_total is distinct from old.modifiers_total
       or new.product_id      is distinct from old.product_id
       or (new.status = 'cancelled' and old.status <> 'cancelled') then
      raise exception 'La comanda ya no está abierta' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.status in ('sent', 'preparing', 'ready', 'delivered') and new.sent_at is null then
    new.sent_at := now();
  end if;
  if new.status in ('ready', 'delivered') and new.ready_at is null then
    new.ready_at := now();
  end if;

  return new;
end;
$$;

-- Fija el costo de cada ítem para las comandas dadas (con el costo actual de los insumos)
create or replace function private.capture_item_costs(p_orders uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('comanda.cost_write', 'on', true);
  update public.order_items oi
     set unit_cost = c.unit_cost
    from public.order_items x
    left join lateral (
      select sum(r.quantity * i.cost_per_unit) as unit_cost
        from public.recipe_items r
        join public.ingredients i on i.id = r.ingredient_id
       where r.product_id = x.product_id
      having count(*) > 0
    ) c on true
   where x.id = oi.id
     and oi.order_id = any (p_orders)
     and oi.unit_cost is distinct from c.unit_cost;
  perform set_config('comanda.cost_write', 'off', true);
end;
$$;

revoke all on function private.capture_item_costs(uuid[]) from public, anon, authenticated;

create or replace function public.orders_capture_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'closed' and old.status <> 'closed' then
    perform private.capture_item_costs(array[new.id]);
  end if;
  return new;
end;
$$;

revoke all on function public.orders_capture_cost() from public, anon, authenticated;

create trigger orders_capture_cost
  after update of status on public.orders
  for each row execute function public.orders_capture_cost();

-- Comandas ya cerradas: se toma el costo actual (es lo mejor que hay)
select private.capture_item_costs(array(select id from public.orders where status = 'closed'));

-- ---------- Reportes con el costo guardado ----------
create or replace function public.sales_report(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz     text;
  v_result jsonb;
begin
  if not private.has_role(p_restaurant, '{owner,manager}') then
    raise exception 'Solo el dueño o el encargado pueden ver reportes' using errcode = '42501';
  end if;
  select r.timezone into v_tz from public.restaurants r where r.id = p_restaurant;

  with o as (
    select *
      from public.orders
     where restaurant_id = p_restaurant
       and status = 'closed'
       and closed_at >= p_from
       and closed_at < p_to
  ),
  pay as (
    select p.amount, p.tip, pm.name as method, pm.kind
      from public.payments p
      join o on o.id = p.order_id
      join public.payment_methods pm on pm.id = p.payment_method_id
     where p.voided_at is null
  ),
  it as (
    select oi.*
      from public.order_items oi
      join o on o.id = oi.order_id
     where oi.status <> 'cancelled'
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'orders',    count(*),
        'sales',     coalesce(sum(total), 0),
        'subtotal',  coalesce(sum(subtotal), 0),
        'discounts', coalesce(sum(discount_amount), 0),
        'tips',      (select coalesce(sum(tip), 0) from pay)
      ) from o
    ),
    'by_hour', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'sales', s, 'orders', c) order by h), '[]'::jsonb)
        from (select extract(hour from closed_at at time zone v_tz)::int as h, sum(total) as s, count(*) as c
                from o group by 1) x
    ),
    'by_day', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d, 'sales', s, 'orders', c) order by d), '[]'::jsonb)
        from (select (closed_at at time zone v_tz)::date as d, sum(total) as s, count(*) as c
                from o group by 1) x
    ),
    'by_payment', (
      select coalesce(jsonb_agg(jsonb_build_object('method', method, 'kind', kind, 'amount', a, 'tips', t, 'count', c) order by a desc), '[]'::jsonb)
        from (select method, kind, sum(amount) as a, sum(tip) as t, count(*) as c from pay group by 1, 2) x
    ),
    'by_type', (
      select coalesce(jsonb_agg(jsonb_build_object('type', type, 'sales', s, 'orders', c) order by s desc), '[]'::jsonb)
        from (select type, sum(total) as s, count(*) as c from o group by 1) x
    ),
    'products', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'product_id', product_id, 'name', name, 'qty', qty, 'revenue', revenue,
               'cost', cost, 'has_recipe', has_recipe) order by revenue desc), '[]'::jsonb)
        from (select it.product_id, it.name,
                     sum(it.quantity) as qty,
                     sum(it.line_total) as revenue,
                     round(sum(it.quantity * coalesce(it.unit_cost, 0)), 2) as cost,
                     bool_or(it.unit_cost is not null) as has_recipe
                from it
               group by it.product_id, it.name) x
    )
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.income_statement(p_restaurant uuid, p_months int default 6)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text;
  v_first date;
  v_last date;
begin
  if not private.has_role(p_restaurant, '{owner,manager}') then
    raise exception 'Solo el dueño o el encargado pueden ver el estado de resultados' using errcode = '42501';
  end if;
  if p_months is null or p_months < 1 or p_months > 24 then
    raise exception 'Elegí entre 1 y 24 meses' using errcode = 'P0001';
  end if;
  select r.timezone into v_tz from public.restaurants r where r.id = p_restaurant;
  v_last := date_trunc('month', (now() at time zone v_tz))::date;
  v_first := (v_last - make_interval(months => p_months - 1))::date;

  return (
    with months as (
      select generate_series(v_first, v_last, interval '1 month')::date as m
    ),
    o as (
      select id, total, discount_amount,
             (select coalesce(sum(pa.tip), 0) from public.payments pa where pa.order_id = orders.id and pa.voided_at is null) as tips,
             date_trunc('month', closed_at at time zone v_tz)::date as m
        from public.orders
       where restaurant_id = p_restaurant and status = 'closed'
         and closed_at >= (v_first::timestamp at time zone v_tz)
    ),
    it as (
      select o.m, oi.quantity * coalesce(oi.unit_cost, 0) as cost,
             case when oi.unit_cost is null then oi.line_total else 0 end as no_recipe
        from public.order_items oi
        join o on o.id = oi.order_id
       where oi.status <> 'cancelled'
    ),
    pu as (
      select date_trunc('month', issued_on)::date as m, category, total
        from public.purchases
       where restaurant_id = p_restaurant and cancelled_at is null and issued_on >= v_first
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'month', to_char(months.m, 'YYYY-MM'),
             'orders', coalesce((select count(*) from o where o.m = months.m), 0),
             'sales', coalesce((select sum(total) from o where o.m = months.m), 0),
             'discounts', coalesce((select sum(discount_amount) from o where o.m = months.m), 0),
             'tips', coalesce((select sum(tips) from o where o.m = months.m), 0),
             'cogs', round(coalesce((select sum(cost) from it where it.m = months.m), 0), 2),
             'sales_without_recipe', coalesce((select sum(no_recipe) from it where it.m = months.m), 0),
             'inventory_purchases', coalesce((select sum(total) from pu where pu.m = months.m and pu.category in ('mercaderia', 'bebidas')), 0),
             'expenses', coalesce((
               select jsonb_object_agg(category, amount)
                 from (select category, sum(total) as amount from pu
                        where pu.m = months.m and pu.category not in ('mercaderia', 'bebidas')
                        group by category) e
             ), '{}'::jsonb)
           ) order by months.m), '[]'::jsonb)
      from months
  );
end;
$$;

-- =============================================================
-- Comandá · 008 · Stock protegido, conteo de inventario y reporte de ventas
-- =============================================================

-- -------------------------------------------------------------
-- El stock de un insumo solo cambia a través de stock_movements.
-- apply_stock_movement levanta una bandera local a la transacción;
-- cualquier otro intento de tocar stock_qty se rechaza.
-- Al crear un insumo el stock arranca en 0 (el inicial se carga como movimiento).
-- -------------------------------------------------------------
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('comanda.stock_write', 'on', true);
  update public.ingredients i
     set stock_qty     = i.stock_qty + new.qty_delta,
         cost_per_unit = case
                           when new.reason = 'purchase' and new.unit_cost is not null then new.unit_cost
                           else i.cost_per_unit
                         end
   where i.id = new.ingredient_id;
  perform set_config('comanda.stock_write', 'off', true);
  return new;
end;
$$;

create or replace function public.ingredients_guard_stock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.stock_qty := 0;
  elsif new.stock_qty is distinct from old.stock_qty
        and coalesce(current_setting('comanda.stock_write', true), 'off') <> 'on' then
    raise exception 'El stock se modifica registrando una compra, merma, ajuste o conteo' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger ingredients_guard_stock before insert or update on public.ingredients
  for each row execute function public.ingredients_guard_stock();

revoke execute on function public.ingredients_guard_stock() from public, anon, authenticated;

-- -------------------------------------------------------------
-- Conteo de inventario: registra la diferencia entre lo contado y el sistema
-- -------------------------------------------------------------
create or replace function public.stock_count(p_ingredient uuid, p_counted numeric, p_note text default null)
returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ing   public.ingredients;
  v_delta numeric;
begin
  if p_counted < 0 then
    raise exception 'El conteo no puede ser negativo' using errcode = '22023';
  end if;
  select * into v_ing from public.ingredients where id = p_ingredient for update;
  if not found then
    raise exception 'Insumo inexistente' using errcode = 'P0002';
  end if;
  v_delta := p_counted - v_ing.stock_qty;
  if v_delta <> 0 then
    insert into public.stock_movements (restaurant_id, ingredient_id, qty_delta, reason, note)
    values (v_ing.restaurant_id, v_ing.id, v_delta, 'count', coalesce(p_note, 'Conteo de inventario'));
  end if;
  return v_delta;
end;
$$;

revoke execute on function public.stock_count(uuid, numeric, text) from public, anon;
grant execute on function public.stock_count(uuid, numeric, text) to authenticated;

-- -------------------------------------------------------------
-- Reporte de ventas de un período (comandas cerradas por fecha de cierre)
-- Solo dueño o encargado. Las horas y días van en la zona horaria del local.
-- El costo de cada producto sale de su receta actual y del costo vigente de
-- los insumos (es una estimación: no guarda el costo histórico).
-- -------------------------------------------------------------
create or replace function public.sales_report(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security invoker
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
  ),
  cost as (
    select r.product_id, sum(r.quantity * i.cost_per_unit) as unit_cost
      from public.recipe_items r
      join public.ingredients i on i.id = r.ingredient_id
     where r.restaurant_id = p_restaurant
     group by r.product_id
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
                     round(sum(it.quantity * coalesce(c.unit_cost, 0)), 2) as cost,
                     bool_or(c.unit_cost is not null) as has_recipe
                from it
                left join cost c on c.product_id = it.product_id
               group by it.product_id, it.name) x
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.sales_report(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.sales_report(uuid, timestamptz, timestamptz) to authenticated;

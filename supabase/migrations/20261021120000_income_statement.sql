-- =============================================================
-- Estado de resultados mensual (dueño o encargado)
--   Ventas            comandas cerradas (total con descuentos), por mes de cierre en la zona del local
--   Costo de ventas   recetas × costo actual de los insumos (igual que en Reportes)
--   Gastos            compras no anuladas por categoría, por fecha del comprobante.
--                     Mercadería y bebidas van a stock: su costo ya entra por "Costo de ventas", así que
--                     se informan aparte (compras de mercadería) y no se restan dos veces.
--   Propinas          informativas: son del personal, no entran en ventas
--   Resultado         ventas − costo de ventas − gastos
-- =============================================================

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
    cost as (
      select r.product_id, sum(r.quantity * i.cost_per_unit) as unit_cost
        from public.recipe_items r
        join public.ingredients i on i.id = r.ingredient_id
       where r.restaurant_id = p_restaurant
       group by r.product_id
    ),
    it as (
      select o.m, oi.quantity * coalesce(c.unit_cost, 0) as cost, case when c.unit_cost is null then oi.line_total else 0 end as no_recipe
        from public.order_items oi
        join o on o.id = oi.order_id
        left join cost c on c.product_id = oi.product_id
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

revoke all on function public.income_statement(uuid, int) from public, anon;
grant execute on function public.income_statement(uuid, int) to authenticated;

-- Reportes: costed_revenue = ventas del producto que tienen costo guardado; el margen se calcula sobre esas
-- (un producto puede tener ventas de antes de cargar su receta, sin costo).

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
               'cost', cost, 'costed_revenue', costed_revenue, 'has_recipe', has_recipe) order by revenue desc), '[]'::jsonb)
        from (select it.product_id, it.name,
                     sum(it.quantity) as qty,
                     sum(it.line_total) as revenue,
                     round(sum(it.quantity * coalesce(it.unit_cost, 0)), 2) as cost,
                     sum(it.line_total) filter (where it.unit_cost is not null) as costed_revenue,
                     bool_or(it.unit_cost is not null) as has_recipe
                from it
               group by it.product_id, it.name) x
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Local de demostración (5): el "ahora" del local.

-- ---------- El "ahora" del local ----------
create or replace function public.demo_finish(p_restaurant uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_session uuid;
  v_order uuid;
  v_table record;
  v_cash uuid;
  x record;
  i int;
begin
  perform private.demo_guard(p_restaurant);

  -- Caja abierta hace unas horas y algunas ventas de hoy
  v_session := private.demo_open_session(p_restaurant, v_now - interval '4 hours', 20000);
  for i in 1 .. 7 loop
    perform private.demo_sale(p_restaurant, v_session, v_now - interval '3 hours 30 minutes' + i * interval '22 minutes',
      (select t.id from public.tables t where t.restaurant_id = p_restaurant and t.name::int > 8 order by random() limit 1),
      'dine_in', null, null, true, 'delivered');
  end loop;
  insert into public.cash_movements (restaurant_id, cash_session_id, kind, amount, reason)
  values (p_restaurant, v_session, 'out', 15000, 'Hielo y pan para el servicio');

  -- Mesas ocupadas, cada una en un momento distinto
  for x in select * from (values ('2', 26, 'preparing'), ('3', 9, 'sent'), ('5', 32, 'ready'), ('6', 3, 'pending'), ('8', 15, 'sent')) t(mesa, mins, st) loop
    select t.id into v_table from public.tables t where t.restaurant_id = p_restaurant and t.name = x.mesa;
    v_order := private.demo_sale(p_restaurant, v_session, v_now - make_interval(mins => x.mins) - interval '4 minutes',
      v_table.id, 'dine_in', null, null, false, x.st::public.item_status);
  end loop;
  -- Una para llevar esperando en cocina
  perform private.demo_sale(p_restaurant, v_session, v_now - interval '12 minutes', null, 'takeaway', 'Lucía', null, false, 'preparing');

  -- Martín Gómez debe una cuenta; el estudio pagó parte de lo suyo
  select pm.id into v_cash from public.payment_methods pm where pm.restaurant_id = p_restaurant and pm.kind = 'transfer';
  perform public.customer_payment(c.id, least(80000, b.balance), v_cash, 'Pago parcial')
     from public.customers c join public.customer_balances b on b.id = c.id
    where c.restaurant_id = p_restaurant and c.name = 'Estudio Contable Ruiz' and b.balance > 0;

  -- Conteo de stock: la mayoría bien, tres insumos por debajo del mínimo
  for x in select i.id, i.min_stock, i.name from public.ingredients i where i.restaurant_id = p_restaurant loop
    perform public.stock_count(x.id,
      case x.name
        when 'Muzzarella' then 3.5
        when 'Papa' then 12
        when 'Agua mineral 500 ml' then 18
        else round((x.min_stock * (1.6 + random()))::numeric, 1)
      end,
      'Conteo de inventario');
  end loop;
end;
$$;

revoke all on function public.demo_finish(uuid) from public, anon;
grant execute on function public.demo_finish(uuid) to authenticated;

-- Local de demostración (4): ventas cerradas de un día pasado, con su caja.

-- ---------- Ventas de un día pasado ----------
create or replace function public.demo_fill_day(p_restaurant uuid, p_days_ago int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'America/Argentina/Buenos_Aires')::date - p_days_ago;
  v_dow int := extract(isodow from v_day);
  v_n int;
  v_session uuid;
  v_at timestamptz;
  v_table uuid;
  v_type public.order_type;
  v_cust uuid;
  v_expected numeric;
  i int;
  r float8;
begin
  perform private.demo_guard(p_restaurant);
  if p_days_ago < 1 or p_days_ago > 60 then
    raise exception 'Día fuera de rango' using errcode = 'P0001';
  end if;
  -- Lunes cerrado; viernes y sábado, más movimiento
  if v_dow = 1 then
    return 0;
  end if;
  v_n := case when v_dow in (5, 6) then 30 when v_dow = 7 then 24 else 16 end + floor(random() * 6)::int;

  v_session := private.demo_open_session(p_restaurant, (v_day + time '11:30') at time zone 'America/Argentina/Buenos_Aires', 20000);

  for i in 1 .. v_n loop
    r := random();
    -- 40 % al mediodía (12 a 15 h) y 60 % a la noche (20 a 23.30 h)
    v_at := (v_day + case when r < 0.4 then time '12:00' + (random() * interval '3 hours')
                          else time '20:00' + (random() * interval '3 hours 30 minutes') end)
            at time zone 'America/Argentina/Buenos_Aires';
    r := random();
    v_type := case when r < 0.72 then 'dine_in'::public.order_type when r < 0.88 then 'takeaway' else 'counter' end;
    v_table := null;
    if v_type = 'dine_in' then
      select t.id into v_table from public.tables t where t.restaurant_id = p_restaurant order by random() limit 1;
    end if;
    -- Algunos almuerzos del estudio contable van a cuenta corriente
    v_cust := null;
    if v_type = 'dine_in' and v_dow between 2 and 5 and random() < 0.06 then
      -- Solo si le queda margen en la cuenta
      select c.id into v_cust from public.customers c
        left join public.customer_balances b on b.id = c.id
       where c.restaurant_id = p_restaurant and c.name = 'Estudio Contable Ruiz'
         and coalesce(b.balance, 0) < c.credit_limit - 150000;
    end if;
    perform private.demo_sale(p_restaurant, v_session, v_at, v_table, v_type,
      case when v_type = 'takeaway' then (array['Juan', 'Sofi', 'Carla', 'Nico', 'Marta', 'Pablo'])[1 + floor(random() * 6)::int] end,
      v_cust, true, 'delivered');
  end loop;

  -- Cierre de caja de ese día, a veces con una diferencia chica
  select s.opening_amount
       + coalesce((select sum(p.amount + p.tip) from public.payments p join public.payment_methods pm on pm.id = p.payment_method_id
                    where p.cash_session_id = s.id and p.voided_at is null and pm.kind = 'cash'), 0)
    into v_expected from public.cash_sessions s where s.id = v_session;
  perform set_config('comanda.cash_close', 'on', true);
  update public.cash_sessions
     set closed_at = (v_day + time '23:58') at time zone 'America/Argentina/Buenos_Aires',
         closed_by = (select auth.uid()),
         expected_cash = v_expected,
         counted_cash = v_expected + case when random() < 0.2 then (array[-1500, -500, 500, 1000])[1 + floor(random() * 4)::int] else 0 end
   where id = v_session;
  perform set_config('comanda.cash_close', 'off', true);
  return v_n;
end;
$$;

revoke all on function public.demo_fill_day(uuid, int) from public, anon;
grant execute on function public.demo_fill_day(uuid, int) to authenticated;

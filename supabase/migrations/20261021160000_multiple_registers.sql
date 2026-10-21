-- =============================================================
-- Varias cajas y arqueo ciego
--   * registers.blind_close: en esa caja el cajero cierra sin ver el efectivo esperado ni la diferencia
--     (el dueño y el encargado sí los ven).
--   * private.pick_cash_session: a qué caja va un cobro. La que pide el dispositivo (tiene que estar abierta
--     y ser del local); si no pide ninguna, la que abrió esa persona; si hay una sola abierta, esa. Con varias
--     abiertas y ninguna propia, el efectivo exige elegir caja; los otros medios van a la más antigua.
--   * Las sesiones de caja ya no se editan directo: se abren con insert (validado) y se cierran solo con
--     close_cash_session (security definer, bandera comanda.cash_close).
--   * Los movimientos de caja solo entran a una sesión abierta.
--   * No se desactiva una caja abierta ni se repite el nombre de una caja activa.
-- =============================================================

alter table public.registers add column blind_close boolean not null default false;

comment on column public.registers.blind_close is
  'Arqueo ciego: el cajero cierra sin ver el efectivo esperado ni la diferencia.';

-- ---------- Elegir la sesión de caja ----------
create or replace function private.pick_cash_session(p_restaurant uuid, p_requested uuid, p_user uuid, p_cash boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_open int;
begin
  if p_requested is not null then
    select s.id into v_id from public.cash_sessions s
     where s.id = p_requested and s.restaurant_id = p_restaurant and s.closed_at is null;
    if v_id is null then
      raise exception 'La caja elegida está cerrada' using errcode = 'P0001';
    end if;
    return v_id;
  end if;

  if p_user is not null then
    select s.id into v_id from public.cash_sessions s
     where s.restaurant_id = p_restaurant and s.closed_at is null and s.opened_by = p_user
     order by s.opened_at desc limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  select count(*) into v_open from public.cash_sessions s where s.restaurant_id = p_restaurant and s.closed_at is null;
  if v_open = 0 then
    return null;
  end if;
  if v_open > 1 and p_cash then
    raise exception 'Hay varias cajas abiertas: elegí en cuál se cobra desde la pantalla Caja' using errcode = 'P0001';
  end if;
  select s.id into v_id from public.cash_sessions s
   where s.restaurant_id = p_restaurant and s.closed_at is null
   order by s.opened_at limit 1;
  return v_id;
end;
$$;

revoke all on function private.pick_cash_session(uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- ---------- Pagos de comandas ----------
create or replace function public.payments_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_kind    public.payment_kind;
begin
  select * into v_order from public.orders where id = new.order_id for update;
  if not found or v_order.status <> 'open' then
    raise exception 'Solo se puede cobrar una comanda abierta' using errcode = 'P0001';
  end if;

  if new.amount > (v_order.total - v_order.paid_total) + 0.009 then
    raise exception 'El pago supera lo que falta cobrar (%)', v_order.total - v_order.paid_total
      using errcode = 'P0001';
  end if;

  select pm.kind into v_kind from public.payment_methods pm where pm.id = new.payment_method_id;

  new.cash_session_id := private.pick_cash_session(
    new.restaurant_id, new.cash_session_id, coalesce((select auth.uid()), new.created_by), v_kind = 'cash');

  if v_kind = 'cash' and new.cash_session_id is null then
    raise exception 'Abrí la caja para cobrar en efectivo' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- ---------- Cobros de cuenta corriente ----------
drop function public.customer_payment(uuid, numeric, uuid, text);

create function public.customer_payment(p_customer uuid, p_amount numeric, p_method uuid, p_note text default null, p_session uuid default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.customers;
  pm public.payment_methods;
  v_session uuid;
  v_cash uuid;
  v_balance numeric;
begin
  select * into c from public.customers where id = p_customer;
  if c.id is null or not private.has_role(c.restaurant_id, '{owner,manager,cashier}') then
    raise exception 'No se encontró el cliente' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Ingresá el monto que paga' using errcode = 'P0001';
  end if;
  select * into pm from public.payment_methods where id = p_method and restaurant_id = c.restaurant_id;
  if pm.id is null or pm.kind = 'account' then
    raise exception 'Elegí con qué paga' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into v_balance from public.customer_movements where customer_id = c.id;
  if p_amount > v_balance + 0.009 then
    raise exception 'El pago supera la deuda (%)', v_balance using errcode = 'P0001';
  end if;

  if pm.kind = 'cash' then
    v_session := private.pick_cash_session(c.restaurant_id, p_session, (select auth.uid()), true);
    if v_session is null then
      raise exception 'Abrí la caja para cobrar en efectivo' using errcode = 'P0001';
    end if;
    insert into public.cash_movements (restaurant_id, cash_session_id, kind, amount, reason)
    values (c.restaurant_id, v_session, 'in', p_amount, 'Cobro de cuenta corriente · ' || c.name)
    returning id into v_cash;
  end if;

  insert into public.customer_movements (restaurant_id, customer_id, kind, amount, payment_method_id, cash_movement_id, note)
  values (c.restaurant_id, c.id, 'payment', -p_amount, pm.id, v_cash, nullif(trim(coalesce(p_note, '')), ''));

  return v_balance - p_amount;
end;
$$;

revoke all on function public.customer_payment(uuid, numeric, uuid, text, uuid) from public, anon;
grant execute on function public.customer_payment(uuid, numeric, uuid, text, uuid) to authenticated;

-- ---------- Pagos a proveedores ----------
drop function private.pay_supplier(public.suppliers, numeric, uuid, text, uuid);

create function private.pay_supplier(p_supplier public.suppliers, p_amount numeric, p_method uuid, p_note text, p_purchase uuid, p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pm public.payment_methods;
  v_session uuid;
  v_cash uuid;
begin
  select * into pm from public.payment_methods where id = p_method and restaurant_id = p_supplier.restaurant_id;
  if pm.id is null or pm.kind = 'account' then
    raise exception 'Elegí con qué se paga' using errcode = 'P0001';
  end if;
  if pm.kind = 'cash' then
    v_session := private.pick_cash_session(p_supplier.restaurant_id, p_session, (select auth.uid()), true);
    if v_session is null then
      raise exception 'Abrí la caja para pagar en efectivo' using errcode = 'P0001';
    end if;
    insert into public.cash_movements (restaurant_id, cash_session_id, kind, amount, reason)
    values (p_supplier.restaurant_id, v_session, 'out', p_amount, 'Pago a proveedor · ' || p_supplier.name)
    returning id into v_cash;
  end if;
  insert into public.supplier_movements (restaurant_id, supplier_id, kind, amount, purchase_id, payment_method_id, cash_movement_id, note)
  values (p_supplier.restaurant_id, p_supplier.id, 'payment', -p_amount, p_purchase, pm.id, v_cash, nullif(trim(coalesce(p_note, '')), ''));
end;
$$;

revoke all on function private.pay_supplier(public.suppliers, numeric, uuid, text, uuid, uuid) from public, anon, authenticated;

drop function public.supplier_payment(uuid, numeric, uuid, text);

create function public.supplier_payment(p_supplier uuid, p_amount numeric, p_method uuid, p_note text default null, p_session uuid default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.suppliers;
  v_balance numeric;
begin
  select * into s from public.suppliers where id = p_supplier;
  if s.id is null or not private.has_role(s.restaurant_id, '{owner,manager,cashier}') then
    raise exception 'No se encontró el proveedor' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Ingresá el monto a pagar' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into v_balance from public.supplier_movements where supplier_id = s.id;
  if p_amount > v_balance + 0.009 then
    raise exception 'El pago supera lo que se le debe (%)', v_balance using errcode = 'P0001';
  end if;
  perform private.pay_supplier(s, p_amount, p_method, p_note, null, p_session);
  return v_balance - p_amount;
end;
$$;

revoke all on function public.supplier_payment(uuid, numeric, uuid, text, uuid) from public, anon;
grant execute on function public.supplier_payment(uuid, numeric, uuid, text, uuid) to authenticated;

-- register_purchase: el pago en el momento puede indicar la caja (paid.cash_session_id)
create or replace function public.register_purchase(p_purchase jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.suppliers;
  v_id uuid;
  v_item jsonb;
  v_lines numeric := 0;
  v_total numeric;
  v_ing public.ingredients;
  v_qty numeric;
  v_line numeric;
  v_paid numeric;
  v_label text;
begin
  select * into s from public.suppliers where id = (p_purchase ->> 'supplier_id')::uuid;
  if s.id is null or not private.has_role(s.restaurant_id, '{owner,manager}') then
    raise exception 'Elegí el proveedor' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_purchase -> 'items') <> 'array' or jsonb_array_length(p_purchase -> 'items') = 0 then
    raise exception 'Cargá al menos un renglón' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p_purchase -> 'items') loop
    v_line := coalesce((v_item ->> 'line_total')::numeric, 0);
    if v_line < 0 or coalesce((v_item ->> 'quantity')::numeric, 0) <= 0 then
      raise exception 'Revisá cantidades e importes de los renglones' using errcode = 'P0001';
    end if;
    v_lines := v_lines + v_line;
  end loop;
  v_total := coalesce(nullif(p_purchase ->> 'total', '')::numeric, v_lines);
  if v_total <= 0 then
    raise exception 'El total de la compra tiene que ser mayor a cero' using errcode = 'P0001';
  end if;
  if v_total + 0.009 < v_lines then
    raise exception 'El total no puede ser menor que la suma de los renglones' using errcode = 'P0001';
  end if;

  v_label := 'Compra · ' || s.name || coalesce(' · ' || nullif(p_purchase ->> 'doc_number', ''), '');

  insert into public.purchases (restaurant_id, supplier_id, issued_on, due_on, doc_kind, doc_number, category, total, notes)
  values (
    s.restaurant_id, s.id,
    coalesce((p_purchase ->> 'issued_on')::date, (now() at time zone 'America/Argentina/Buenos_Aires')::date),
    nullif(p_purchase ->> 'due_on', '')::date,
    coalesce(nullif(p_purchase ->> 'doc_kind', ''), 'factura'),
    nullif(trim(coalesce(p_purchase ->> 'doc_number', '')), ''),
    coalesce(nullif(p_purchase ->> 'category', ''), 'mercaderia')::public.expense_category,
    v_total,
    nullif(trim(coalesce(p_purchase ->> 'notes', '')), '')
  )
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_purchase -> 'items') loop
    v_qty := (v_item ->> 'quantity')::numeric;
    v_line := coalesce((v_item ->> 'line_total')::numeric, 0);
    v_ing := null;
    if nullif(v_item ->> 'ingredient_id', '') is not null then
      select * into v_ing from public.ingredients
       where id = (v_item ->> 'ingredient_id')::uuid and restaurant_id = s.restaurant_id;
      if v_ing.id is null then
        raise exception 'Uno de los insumos no existe' using errcode = 'P0001';
      end if;
    end if;
    insert into public.purchase_items (restaurant_id, purchase_id, ingredient_id, description, quantity, line_total)
    values (s.restaurant_id, v_id, v_ing.id, coalesce(nullif(trim(v_item ->> 'description'), ''), v_ing.name, 'Sin descripción'), v_qty, v_line);
    if v_ing.id is not null then
      insert into public.stock_movements (restaurant_id, ingredient_id, qty_delta, reason, unit_cost, note)
      values (s.restaurant_id, v_ing.id, v_qty, 'purchase', case when v_line > 0 then round(v_line / v_qty, 4) end, v_label);
    end if;
  end loop;

  insert into public.supplier_movements (restaurant_id, supplier_id, kind, amount, purchase_id, note)
  values (s.restaurant_id, s.id, 'purchase', v_total, v_id, nullif(p_purchase ->> 'doc_number', ''));

  v_paid := nullif(p_purchase #>> '{paid,amount}', '')::numeric;
  if v_paid is not null and v_paid > 0 then
    if v_paid > v_total + 0.009 then
      raise exception 'Lo pagado supera el total de la compra' using errcode = 'P0001';
    end if;
    perform private.pay_supplier(s, v_paid, (p_purchase #>> '{paid,method_id}')::uuid, 'Pago al registrar la compra', v_id,
                                 nullif(p_purchase #>> '{paid,cash_session_id}', '')::uuid);
  end if;

  return v_id;
end;
$$;

-- ---------- Sesiones de caja ----------
create or replace function public.cash_sessions_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.registers r
                    where r.id = new.register_id and r.restaurant_id = new.restaurant_id and r.active) then
      raise exception 'Esa caja no está habilitada' using errcode = 'P0001';
    end if;
    if new.opening_amount is null or new.opening_amount < 0 then
      raise exception 'Ingresá el efectivo inicial' using errcode = 'P0001';
    end if;
    new.opened_by     := (select auth.uid());
    new.opened_at     := now();
    new.closed_at     := null;
    new.closed_by     := null;
    new.expected_cash := null;
    new.counted_cash  := null;
    return new;
  end if;

  if coalesce(current_setting('comanda.cash_close', true), '') <> 'on' then
    raise exception 'La caja se cierra con el arqueo' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.cash_sessions_guard() from public, anon, authenticated;

create trigger cash_sessions_guard
  before insert or update on public.cash_sessions
  for each row execute function public.cash_sessions_guard();

drop policy cash_sessions_update on public.cash_sessions;

drop function public.close_cash_session(uuid, numeric, text);

create function public.close_cash_session(p_session uuid, p_counted numeric, p_notes text default null)
returns public.cash_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.cash_sessions;
  v_expected numeric(12, 2);
  v_blind boolean;
begin
  select * into v_session from public.cash_sessions where id = p_session for update;
  if not found or not private.has_role(v_session.restaurant_id, '{owner,manager,cashier}') then
    raise exception 'Sesión de caja inexistente' using errcode = 'P0002';
  end if;
  if v_session.closed_at is not null then
    raise exception 'La caja ya está cerrada' using errcode = 'P0001';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'Ingresá el efectivo que contaste' using errcode = 'P0001';
  end if;

  select v_session.opening_amount
       + coalesce((select sum(p.amount + p.tip)
                     from public.payments p
                     join public.payment_methods pm on pm.id = p.payment_method_id
                    where p.cash_session_id = p_session
                      and p.voided_at is null
                      and pm.kind = 'cash'), 0)
       + coalesce((select sum(case when m.kind = 'in' then m.amount else -m.amount end)
                     from public.cash_movements m
                    where m.cash_session_id = p_session), 0)
    into v_expected;

  perform set_config('comanda.cash_close', 'on', true);
  update public.cash_sessions
     set closed_at     = now(),
         closed_by     = (select auth.uid()),
         expected_cash = v_expected,
         counted_cash  = p_counted,
         notes         = coalesce(nullif(trim(p_notes), ''), notes)
   where id = p_session
  returning * into v_session;
  perform set_config('comanda.cash_close', 'off', true);

  -- Arqueo ciego: el cajero no recibe lo esperado
  select r.blind_close into v_blind from public.registers r where r.id = v_session.register_id;
  if v_blind and not private.has_role(v_session.restaurant_id, '{owner,manager}') then
    v_session.expected_cash := null;
  end if;

  return v_session;
end;
$$;

revoke all on function public.close_cash_session(uuid, numeric, text) from public, anon;
grant execute on function public.close_cash_session(uuid, numeric, text) to authenticated;

-- ---------- Movimientos de caja ----------
create or replace function public.cash_movements_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.cash_sessions s
                  where s.id = new.cash_session_id and s.restaurant_id = new.restaurant_id and s.closed_at is null) then
    raise exception 'La caja está cerrada' using errcode = 'P0001';
  end if;
  if new.amount is null or new.amount <= 0 then
    raise exception 'Ingresá un monto mayor a cero' using errcode = 'P0001';
  end if;
  new.created_by := coalesce((select auth.uid()), new.created_by);
  return new;
end;
$$;

revoke all on function public.cash_movements_guard() from public, anon, authenticated;

create trigger cash_movements_guard
  before insert on public.cash_movements
  for each row execute function public.cash_movements_guard();

-- ---------- Cajas ----------
create or replace function public.registers_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.active and not new.active
     and exists (select 1 from public.cash_sessions s where s.register_id = old.id and s.closed_at is null) then
    raise exception 'Cerrá la caja antes de desactivarla' using errcode = 'P0001';
  end if;
  new.name := trim(new.name);
  if exists (select 1 from public.registers r
              where r.restaurant_id = new.restaurant_id and r.id <> new.id and r.active
                and lower(r.name) = lower(new.name)) and new.active then
    raise exception 'Ya hay una caja con ese nombre' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.registers_guard() from public, anon, authenticated;

create trigger registers_guard
  before insert or update on public.registers
  for each row execute function public.registers_guard();

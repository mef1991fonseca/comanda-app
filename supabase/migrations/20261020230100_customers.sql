-- =============================================================
-- Clientes y cuenta corriente
-- El saldo de un cliente es la suma de sus movimientos (+ debe, − pagó) y solo cambia por:
--  * un pago con el medio "Cuenta corriente" en una comanda (cargo) o su anulación (reversa)
--  * un cobro de la deuda con customer_payment (en efectivo entra a la caja abierta)
-- =============================================================

create table public.customers (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  name           text not null check (char_length(trim(name)) between 1 and 120),
  doc_type       int check (doc_type in (80, 96)),           -- 80 CUIT, 96 DNI (para facturar)
  doc_number     text check (doc_number ~ '^\d{7,11}$'),
  iva_condition  int not null default 5 check (iva_condition in (1, 4, 5, 6)),
  phone          text,
  email          text,
  notes          text,
  credit_limit   numeric(12, 2) check (credit_limit is null or credit_limit >= 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id)
);
create index customers_restaurant_idx on public.customers (restaurant_id, name);
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

alter table public.customers enable row level security;
create policy customers_select on public.customers for select to authenticated
  using (private.is_member(restaurant_id));
create policy customers_insert on public.customers for insert to authenticated
  with check (private.has_role(restaurant_id, '{owner,manager,cashier}'));
create policy customers_update on public.customers for update to authenticated
  using (private.has_role(restaurant_id, '{owner,manager,cashier}'))
  with check (private.has_role(restaurant_id, '{owner,manager,cashier}'));

create table public.customer_movements (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants (id) on delete cascade,
  customer_id      uuid not null,
  kind             text not null check (kind in ('charge', 'payment', 'reversal')),
  amount           numeric(12, 2) not null check (amount <> 0),   -- + aumenta la deuda, − la baja
  order_id         uuid,
  payment_id       uuid references public.payments (id) on delete set null,
  payment_method_id uuid,
  cash_movement_id uuid references public.cash_movements (id) on delete set null,
  note             text,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  foreign key (restaurant_id, customer_id) references public.customers (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, order_id) references public.orders (restaurant_id, id) on delete set null (order_id),
  foreign key (restaurant_id, payment_method_id) references public.payment_methods (restaurant_id, id) on delete set null (payment_method_id)
);
create index customer_movements_customer_idx on public.customer_movements (restaurant_id, customer_id, created_at desc);
create index customer_movements_order_idx on public.customer_movements (restaurant_id, order_id);
create index customer_movements_payment_idx on public.customer_movements (payment_id);
create index customer_movements_cash_idx on public.customer_movements (cash_movement_id);
create index customer_movements_method_idx on public.customer_movements (restaurant_id, payment_method_id);
create index customer_movements_created_by_idx on public.customer_movements (created_by);

alter table public.customer_movements enable row level security;
-- Las deudas las ven quienes manejan plata; nadie las escribe directo
create policy customer_movements_select on public.customer_movements for select to authenticated
  using (private.has_role(restaurant_id, '{owner,manager,cashier}'));

-- Saldos (respeta RLS de quien consulta)
create view public.customer_balances with (security_invoker = on) as
  select c.id, c.restaurant_id, coalesce(sum(m.amount), 0)::numeric(12, 2) as balance, max(m.created_at) as last_movement_at
    from public.customers c
    left join public.customer_movements m on m.customer_id = c.id and m.restaurant_id = c.restaurant_id
   group by c.id, c.restaurant_id;

-- Cliente de la comanda
alter table public.orders add column customer_id uuid;
alter table public.orders add constraint orders_customer_fk
  foreign key (restaurant_id, customer_id) references public.customers (restaurant_id, id) on delete set null (customer_id);
create index orders_customer_idx on public.orders (restaurant_id, customer_id);

-- Medio "Cuenta corriente" en los locales existentes y en los nuevos
insert into public.payment_methods (restaurant_id, name, kind, sort_order)
select r.id, 'Cuenta corriente', 'account', 5 from public.restaurants r
 where not exists (select 1 from public.payment_methods pm where pm.restaurant_id = r.id and pm.kind = 'account');

create or replace function public.restaurants_add_account_method()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.payment_methods (restaurant_id, name, kind, sort_order) values (new.id, 'Cuenta corriente', 'account', 5);
  return null;
end;
$$;
revoke all on function public.restaurants_add_account_method() from public, anon, authenticated;
create trigger restaurants_add_account_method after insert on public.restaurants
  for each row execute function public.restaurants_add_account_method();

-- -------------------------------------------------------------
-- Pagos a cuenta corriente
-- -------------------------------------------------------------
create or replace function public.payments_account_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.payment_kind;
  v_customer uuid;
  c public.customers;
  v_balance numeric;
begin
  select pm.kind into v_kind from public.payment_methods pm where pm.id = new.payment_method_id;
  if v_kind is distinct from 'account' then
    return new;
  end if;
  select o.customer_id into v_customer from public.orders o where o.id = new.order_id;
  if v_customer is null then
    raise exception 'Para cobrar a cuenta corriente, asigná un cliente a la comanda' using errcode = 'P0001';
  end if;
  select * into c from public.customers where id = v_customer;
  if not c.active then
    raise exception 'El cliente % está inactivo', c.name using errcode = 'P0001';
  end if;
  if new.tip > 0 then
    raise exception 'La propina no se puede cargar a cuenta corriente' using errcode = 'P0001';
  end if;
  if c.credit_limit is not null then
    select coalesce(sum(amount), 0) into v_balance from public.customer_movements where customer_id = c.id;
    if v_balance + new.amount > c.credit_limit + 0.009 then
      raise exception 'Supera el límite de cuenta de % (debe %, límite %)', c.name, v_balance, c.credit_limit using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.payments_account_check() from public, anon, authenticated;
-- Corre después de payments_before_insert (orden alfabético de triggers BEFORE)
create trigger payments_xaccount_check before insert on public.payments
  for each row execute function public.payments_account_check();

create or replace function public.payments_account_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.payment_kind;
  v_customer uuid;
begin
  select pm.kind into v_kind from public.payment_methods pm where pm.id = new.payment_method_id;
  if v_kind is distinct from 'account' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select o.customer_id into v_customer from public.orders o where o.id = new.order_id;
    insert into public.customer_movements (restaurant_id, customer_id, kind, amount, order_id, payment_id, payment_method_id, created_by)
    values (new.restaurant_id, v_customer, 'charge', new.amount, new.order_id, new.id, new.payment_method_id, new.created_by);
  elsif new.voided_at is not null and old.voided_at is null then
    -- Se revierte contra el mismo cliente del cargo original
    insert into public.customer_movements (restaurant_id, customer_id, kind, amount, order_id, payment_id, note)
    select m.restaurant_id, m.customer_id, 'reversal', -m.amount, m.order_id, m.payment_id, 'Pago anulado'
      from public.customer_movements m
     where m.payment_id = new.id and m.kind = 'charge';
  end if;
  return null;
end;
$$;
revoke all on function public.payments_account_movement() from public, anon, authenticated;
create trigger payments_account_movement after insert or update of voided_at on public.payments
  for each row execute function public.payments_account_movement();

-- -------------------------------------------------------------
-- Cobrar (todo o parte de) la deuda de un cliente
-- -------------------------------------------------------------
create or replace function public.customer_payment(p_customer uuid, p_amount numeric, p_method uuid, p_note text default null)
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
    select s.id into v_session from public.cash_sessions s
     where s.restaurant_id = c.restaurant_id and s.closed_at is null order by s.opened_at limit 1;
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
revoke all on function public.customer_payment(uuid, numeric, uuid, text) from public, anon;
grant execute on function public.customer_payment(uuid, numeric, uuid, text) to authenticated;

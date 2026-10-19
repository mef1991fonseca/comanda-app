-- =============================================================
-- Comandá · 003 · Operación: salón, comandas, cobros y caja
-- =============================================================
-- Los IDs (uuid) pueden generarse en el dispositivo: así una comanda creada
-- sin conexión conserva su identidad al sincronizar. El número visible de la
-- comanda (orders.number) lo asigna el servidor al insertar.

create type public.order_type   as enum ('dine_in', 'counter', 'takeaway', 'delivery');
create type public.order_status as enum ('open', 'closed', 'cancelled');
create type public.item_status  as enum ('pending', 'sent', 'preparing', 'ready', 'delivered', 'cancelled');
create type public.payment_kind as enum ('cash', 'debit', 'credit', 'transfer', 'mercadopago', 'other');

-- -------------------------------------------------------------
-- Salón: áreas y mesas
-- -------------------------------------------------------------
create table public.dining_areas (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id)
);

create table public.tables (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  area_id       uuid not null,
  name          text not null check (char_length(name) between 1 and 20),
  seats         int not null default 4 check (seats between 1 and 99),
  pos_x         int not null default 0,
  pos_y         int not null default 0,
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (area_id, name),
  foreign key (restaurant_id, area_id)
    references public.dining_areas (restaurant_id, id) on delete cascade
);

-- -------------------------------------------------------------
-- Caja: cajas, medios de pago, sesiones (turnos) y movimientos
-- -------------------------------------------------------------
create table public.registers (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id)
);

create table public.payment_methods (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  kind          public.payment_kind not null,
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id)
);

create table public.cash_sessions (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete cascade,
  register_id     uuid not null,
  opened_by       uuid references auth.users (id) on delete set null default auth.uid(),
  opened_at       timestamptz not null default now(),
  opening_amount  numeric(12, 2) not null default 0 check (opening_amount >= 0),
  closed_by       uuid references auth.users (id) on delete set null,
  closed_at       timestamptz,
  expected_cash   numeric(12, 2),
  counted_cash    numeric(12, 2),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, register_id)
    references public.registers (restaurant_id, id) on delete restrict
);

-- Una sola sesión abierta por caja
create unique index cash_sessions_one_open_idx on public.cash_sessions (register_id) where closed_at is null;

create table public.cash_movements (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete cascade,
  cash_session_id uuid not null,
  kind            text not null check (kind in ('in', 'out')),
  amount          numeric(12, 2) not null check (amount > 0),
  reason          text,
  created_by      uuid references auth.users (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  foreign key (restaurant_id, cash_session_id)
    references public.cash_sessions (restaurant_id, id) on delete cascade
);

create index cash_movements_session_idx on public.cash_movements (cash_session_id);

-- -------------------------------------------------------------
-- Comandas (ventas)
-- -------------------------------------------------------------
create table public.order_counters (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  last_number   int not null default 0
);

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants (id) on delete cascade,
  number           int,
  type             public.order_type not null default 'dine_in',
  status           public.order_status not null default 'open',
  table_id         uuid,
  waiter_id        uuid references auth.users (id) on delete set null default auth.uid(),
  customer_name    text,
  guests           int check (guests is null or guests between 1 and 999),
  notes            text,
  subtotal         numeric(12, 2) not null default 0,
  discount_amount  numeric(12, 2) not null default 0 check (discount_amount >= 0),
  total            numeric(12, 2) not null default 0,
  paid_total       numeric(12, 2) not null default 0,
  cash_session_id  uuid,
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  cancelled_reason text,
  created_by       uuid references auth.users (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, number),
  check (type <> 'dine_in' or table_id is not null or status <> 'open'),
  foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id) on delete set null (table_id),
  foreign key (restaurant_id, cash_session_id)
    references public.cash_sessions (restaurant_id, id) on delete set null (cash_session_id)
);

create index orders_restaurant_status_idx on public.orders (restaurant_id, status, opened_at desc);
create index orders_table_open_idx on public.orders (table_id) where status = 'open';
create index orders_cash_session_idx on public.orders (cash_session_id);

create table public.order_items (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete cascade,
  order_id        uuid not null,
  product_id      uuid,
  station_id      uuid,
  name            text not null,
  unit_price      numeric(12, 2) not null check (unit_price >= 0),
  modifiers       jsonb not null default '[]'::jsonb check (jsonb_typeof(modifiers) = 'array'),
  modifiers_total numeric(12, 2) not null default 0,
  quantity        numeric(10, 3) not null default 1 check (quantity > 0),
  line_total      numeric(12, 2) generated always as (round(quantity * (unit_price + modifiers_total), 2)) stored,
  notes           text,
  guest_number    int check (guest_number is null or guest_number >= 1),
  status          public.item_status not null default 'pending',
  sent_at         timestamptz,
  ready_at        timestamptz,
  created_by      uuid references auth.users (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, product_id)
    references public.products (restaurant_id, id) on delete set null (product_id),
  foreign key (restaurant_id, station_id)
    references public.stations (restaurant_id, id) on delete set null (station_id)
);

create index order_items_order_idx on public.order_items (order_id);
create index order_items_kds_idx on public.order_items (restaurant_id, station_id, status)
  where status in ('sent', 'preparing', 'ready');

-- -------------------------------------------------------------
-- Pagos
-- -------------------------------------------------------------
create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants (id) on delete cascade,
  order_id          uuid not null,
  payment_method_id uuid not null,
  amount            numeric(12, 2) not null check (amount > 0),
  tip               numeric(12, 2) not null default 0 check (tip >= 0),
  cash_session_id   uuid,
  reference         text,
  voided_at         timestamptz,
  voided_by         uuid references auth.users (id) on delete set null,
  created_by        uuid references auth.users (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete restrict,
  foreign key (restaurant_id, payment_method_id)
    references public.payment_methods (restaurant_id, id) on delete restrict,
  foreign key (restaurant_id, cash_session_id)
    references public.cash_sessions (restaurant_id, id) on delete set null (cash_session_id)
);

create index payments_order_idx on public.payments (order_id);
create index payments_cash_session_idx on public.payments (cash_session_id);
create index payments_method_idx on public.payments (payment_method_id);

-- =============================================================
-- Lógica de negocio en triggers (security definer: corren igual sin
-- importar el rol de quien dispara la acción, p. ej. cocina marcando "listo")
-- =============================================================

-- Número correlativo de comanda por local
create or replace function public.assign_order_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.order_counters as c (restaurant_id, last_number)
  values (new.restaurant_id, 1)
  on conflict (restaurant_id) do update set last_number = c.last_number + 1
  returning c.last_number into new.number;
  return new;
end;
$$;

create trigger orders_assign_number before insert on public.orders
  for each row execute function public.assign_order_number();

-- Reglas de la comanda: total, cierre y reapertura
create or replace function public.orders_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.total := greatest(new.subtotal - new.discount_amount, 0);

  if new.status is distinct from old.status then
    if new.status = 'closed' then
      if new.paid_total < new.total then
        raise exception 'La comanda % no está paga: total %, pagado %', new.number, new.total, new.paid_total
          using errcode = 'P0001';
      end if;
      new.closed_at := coalesce(new.closed_at, now());
    elsif new.status = 'open' then
      new.closed_at := null;
    elsif new.status = 'cancelled' then
      if new.paid_total > 0 then
        raise exception 'No se puede anular la comanda %: tiene pagos registrados', new.number
          using errcode = 'P0001';
      end if;
      new.closed_at := coalesce(new.closed_at, now());
    end if;
  end if;

  return new;
end;
$$;

create trigger orders_before_update before update on public.orders
  for each row execute function public.orders_before_update();

-- Descuenta stock al cerrar y lo devuelve si la comanda sale de "cerrada"
create or replace function public.orders_stock_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sign int;
begin
  if new.status = 'closed' and old.status <> 'closed' then
    v_sign := -1;
  elsif old.status = 'closed' and new.status <> 'closed' then
    v_sign := 1;
  else
    return new;
  end if;

  insert into public.stock_movements (restaurant_id, ingredient_id, qty_delta, reason, order_id, created_by)
  select new.restaurant_id,
         r.ingredient_id,
         v_sign * sum(r.quantity * oi.quantity),
         case when v_sign = -1 then 'sale'::public.stock_reason else 'sale_reversal'::public.stock_reason end,
         new.id,
         (select auth.uid())
    from public.order_items oi
    join public.recipe_items r on r.product_id = oi.product_id
   where oi.order_id = new.id
     and oi.status <> 'cancelled'
   group by r.ingredient_id
  having sum(r.quantity * oi.quantity) <> 0;

  return new;
end;
$$;

create trigger orders_stock_sync after update of status on public.orders
  for each row execute function public.orders_stock_sync();

-- Ítems: protege comandas cerradas y registra tiempos de cocina
create or replace function public.order_items_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.order_status;
begin
  select o.status into v_status
    from public.orders o
   where o.id = coalesce(new.order_id, old.order_id);

  -- Sin comanda visible: borrado en cascada (o FK que fallará igual)
  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status <> 'open' then
    -- En una comanda cerrada/anulada solo se permite avanzar el estado de cocina
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

create trigger order_items_before_write before insert or update or delete on public.order_items
  for each row execute function public.order_items_before_write();

-- Recalcula el subtotal de la comanda
create or replace function public.order_items_recalc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  -- Cambios de estado de cocina no alteran el subtotal: evitamos escrituras inútiles
  if tg_op = 'UPDATE'
     and new.line_total = old.line_total
     and (new.status = 'cancelled') = (old.status = 'cancelled') then
    return null;
  end if;

  update public.orders o
     set subtotal = coalesce((
           select sum(oi.line_total)
             from public.order_items oi
            where oi.order_id = v_order
              and oi.status <> 'cancelled'
         ), 0)
   where o.id = v_order;
  return null;
end;
$$;

create trigger order_items_recalc after insert or update or delete on public.order_items
  for each row execute function public.order_items_recalc();

-- Recalcula lo pagado
create or replace function public.payments_recalc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid := coalesce(new.order_id, old.order_id);
begin
  update public.orders o
     set paid_total = coalesce((
           select sum(p.amount)
             from public.payments p
            where p.order_id = v_order
              and p.voided_at is null
         ), 0)
   where o.id = v_order;
  return null;
end;
$$;

create trigger payments_recalc after insert or update or delete on public.payments
  for each row execute function public.payments_recalc();

-- Solo se cobra sobre comandas abiertas
create or replace function public.payments_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.orders o where o.id = new.order_id and o.status = 'open') then
    raise exception 'Solo se puede cobrar una comanda abierta' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger payments_before_insert before insert on public.payments
  for each row execute function public.payments_before_insert();

-- Cierre de caja: calcula el efectivo esperado y registra lo contado
create or replace function public.close_cash_session(p_session uuid, p_counted numeric, p_notes text default null)
returns public.cash_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.cash_sessions;
  v_expected numeric(12, 2);
begin
  select * into v_session from public.cash_sessions where id = p_session for update;
  if not found then
    raise exception 'Sesión de caja inexistente' using errcode = 'P0002';
  end if;
  if v_session.closed_at is not null then
    raise exception 'La caja ya está cerrada' using errcode = 'P0001';
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

  update public.cash_sessions
     set closed_at     = now(),
         closed_by     = (select auth.uid()),
         expected_cash = v_expected,
         counted_cash  = p_counted,
         notes         = coalesce(p_notes, notes)
   where id = p_session
  returning * into v_session;

  return v_session;
end;
$$;

revoke execute on function public.assign_order_number() from public, anon, authenticated;
revoke execute on function public.orders_before_update() from public, anon, authenticated;
revoke execute on function public.orders_stock_sync() from public, anon, authenticated;
revoke execute on function public.order_items_before_write() from public, anon, authenticated;
revoke execute on function public.order_items_recalc() from public, anon, authenticated;
revoke execute on function public.payments_recalc() from public, anon, authenticated;
revoke execute on function public.payments_before_insert() from public, anon, authenticated;
revoke execute on function public.close_cash_session(uuid, numeric, text) from public, anon;
grant execute on function public.close_cash_session(uuid, numeric, text) to authenticated;

-- updated_at
create trigger dining_areas_updated_at before update on public.dining_areas for each row execute function public.set_updated_at();
create trigger tables_updated_at before update on public.tables for each row execute function public.set_updated_at();
create trigger registers_updated_at before update on public.registers for each row execute function public.set_updated_at();
create trigger payment_methods_updated_at before update on public.payment_methods for each row execute function public.set_updated_at();
create trigger cash_sessions_updated_at before update on public.cash_sessions for each row execute function public.set_updated_at();
create trigger orders_updated_at before update on public.orders for each row execute function public.set_updated_at();
create trigger order_items_updated_at before update on public.order_items for each row execute function public.set_updated_at();
create trigger payments_updated_at before update on public.payments for each row execute function public.set_updated_at();

create index dining_areas_restaurant_idx on public.dining_areas (restaurant_id);
create index tables_restaurant_idx on public.tables (restaurant_id);
create index registers_restaurant_idx on public.registers (restaurant_id);
create index payment_methods_restaurant_idx on public.payment_methods (restaurant_id);
create index cash_sessions_restaurant_idx on public.cash_sessions (restaurant_id, opened_at desc);
create index cash_movements_restaurant_idx on public.cash_movements (restaurant_id);
create index payments_restaurant_idx on public.payments (restaurant_id, created_at desc);

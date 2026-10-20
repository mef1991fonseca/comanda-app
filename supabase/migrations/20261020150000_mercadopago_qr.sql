-- =============================================================
-- Cobro con QR de Mercado Pago
-- La edge function `mercadopago` habla con la API de Mercado Pago (con el Access Token,
-- que vive solo en el servidor) y escribe estas tablas con la service role.
-- El dispositivo solo lee: no puede marcar un cobro como pagado.
-- =============================================================

-- Sucursal y caja de Mercado Pago de cada local (se crean solas la primera vez que se cobra)
create table public.mp_pos (
  restaurant_id   uuid primary key references public.restaurants (id) on delete cascade,
  mp_user_id      text not null,
  mp_store_id     text not null,
  mp_pos_id       text,
  external_pos_id text not null unique,
  created_at      timestamptz not null default now()
);

alter table public.mp_pos enable row level security;
create policy mp_pos_select on public.mp_pos for select to authenticated
  using (private.has_role(restaurant_id, '{owner,manager}'));

create type public.mp_charge_status as enum ('created', 'processed', 'canceled', 'expired', 'refunded', 'failed');

-- Cada QR mostrado para cobrar (todo o parte de) una comanda
create table public.mp_charges (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_id      uuid not null,
  amount        numeric(12, 2) not null check (amount > 0),
  status        public.mp_charge_status not null default 'created',
  mp_order_id   text unique,
  mp_payment_id text,
  qr_data       text,
  expires_at    timestamptz,
  payment_id    uuid references public.payments (id) on delete set null,
  error         text,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (restaurant_id, order_id) references public.orders (restaurant_id, id) on delete cascade
);

create index mp_charges_order_idx on public.mp_charges (restaurant_id, order_id);
create index mp_charges_payment_idx on public.mp_charges (payment_id);
create index mp_charges_created_by_idx on public.mp_charges (created_by);

create trigger mp_charges_updated_at before update on public.mp_charges
  for each row execute function public.set_updated_at();

alter table public.mp_charges enable row level security;
create policy mp_charges_select on public.mp_charges for select to authenticated
  using (private.is_member(restaurant_id));

-- La pantalla del QR se entera al instante cuando entra el pago
alter publication supabase_realtime add table public.mp_charges;

-- -------------------------------------------------------------
-- Acreditar un cobro aprobado: registra el pago en la comanda una sola vez.
-- Si la comanda ya no lo admite (se cerró o se cobró por otro lado), devuelve 'refund'
-- para que la edge function devuelva la plata en Mercado Pago.
-- -------------------------------------------------------------
create or replace function public.mp_charge_settle(p_charge uuid, p_mp_payment text, p_amount numeric)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.mp_charges;
  v_method uuid;
  v_payment uuid;
begin
  select * into c from public.mp_charges where id = p_charge for update;
  if not found then
    raise exception 'Cobro inexistente';
  end if;
  if c.payment_id is not null or c.status = 'processed' then
    return 'already';
  end if;

  select pm.id into v_method
    from public.payment_methods pm
   where pm.restaurant_id = c.restaurant_id and pm.kind = 'mercadopago'
   order by pm.active desc, pm.sort_order
   limit 1;
  if v_method is null then
    insert into public.payment_methods (restaurant_id, name, kind)
    values (c.restaurant_id, 'Mercado Pago', 'mercadopago')
    returning id into v_method;
  end if;

  begin
    insert into public.payments (restaurant_id, order_id, payment_method_id, amount, reference, created_by)
    values (c.restaurant_id, c.order_id, v_method, least(p_amount, c.amount), 'QR Mercado Pago ' || coalesce(p_mp_payment, ''), c.created_by)
    returning id into v_payment;
  exception when others then
    update public.mp_charges
       set status = 'failed', mp_payment_id = p_mp_payment,
           error = 'Pagado en Mercado Pago pero no se pudo registrar: ' || sqlerrm
     where id = c.id;
    return 'refund';
  end;

  update public.mp_charges
     set status = 'processed', mp_payment_id = p_mp_payment, payment_id = v_payment, error = null
   where id = c.id;
  return 'settled';
end;
$$;

revoke all on function public.mp_charge_settle(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.mp_charge_settle(uuid, text, numeric) to service_role;

-- Para probar la edge function desde la base durante el desarrollo
create extension if not exists pg_net with schema extensions;

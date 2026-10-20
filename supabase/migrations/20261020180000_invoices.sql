-- =============================================================
-- Factura electrónica: datos fiscales del local y comprobantes emitidos
-- Los comprobantes los escribe solo la edge function `arca` (service_role) después de que
-- ARCA devuelve el CAE: el dispositivo no puede inventar una factura.
-- =============================================================

create type public.iva_condition as enum ('monotributo', 'responsable_inscripto');
create type public.invoice_status as enum ('pending', 'authorized', 'rejected');

create table public.fiscal_settings (
  restaurant_id     uuid primary key references public.restaurants (id) on delete cascade,
  cuit              text not null check (cuit ~ '^\d{11}$'),
  legal_name        text not null check (char_length(legal_name) between 1 and 120),
  address           text not null check (char_length(address) between 1 and 160),
  iva_condition     public.iva_condition not null,
  point_of_sale     int not null check (point_of_sale between 1 and 99998),
  activity_start    date,
  gross_income      text,
  enabled           boolean not null default false,
  environment       text not null default 'homologacion' check (environment in ('homologacion', 'produccion')),
  updated_at        timestamptz not null default now()
);

create trigger fiscal_settings_updated_at before update on public.fiscal_settings
  for each row execute function public.set_updated_at();

alter table public.fiscal_settings enable row level security;
create policy fiscal_select on public.fiscal_settings for select to authenticated
  using (private.is_member(restaurant_id));
create policy fiscal_insert on public.fiscal_settings for insert to authenticated
  with check (private.has_role(restaurant_id, '{owner}') and environment = 'homologacion');
create policy fiscal_update on public.fiscal_settings for update to authenticated
  using (private.has_role(restaurant_id, '{owner}'))
  with check (private.has_role(restaurant_id, '{owner}'));

-- El paso a producción no se hace desde la app
create or replace function public.fiscal_settings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.environment <> old.environment and current_user not in ('service_role', 'postgres') then
    raise exception 'El ambiente de facturación lo cambia el soporte de Comandá.';
  end if;
  return new;
end;
$$;
create trigger fiscal_settings_guard before update on public.fiscal_settings
  for each row execute function public.fiscal_settings_guard();

create table public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants (id) on delete cascade,
  order_id            uuid not null,
  environment         text not null,
  cbte_type           int not null,             -- 1 = A, 6 = B, 11 = C
  point_of_sale       int not null,
  number              bigint,
  issued_on           date not null,
  doc_type            int not null default 99,  -- 80 = CUIT, 96 = DNI, 99 = consumidor final
  doc_number          text not null default '0',
  receiver_name       text,
  receiver_condition  int not null default 5,   -- 5 = consumidor final, 1 = RI, 6 = monotributo, 4 = exento
  total               numeric(12, 2) not null,
  net                 numeric(12, 2) not null,
  vat                 numeric(12, 2) not null default 0,
  cae                 text,
  cae_due             date,
  status              public.invoice_status not null default 'pending',
  error               text,
  notes               text,
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  foreign key (restaurant_id, order_id) references public.orders (restaurant_id, id) on delete restrict
);

create index invoices_restaurant_idx on public.invoices (restaurant_id, created_at desc);
create index invoices_order_idx on public.invoices (restaurant_id, order_id);
create index invoices_created_by_idx on public.invoices (created_by);
-- Una sola factura autorizada por comanda y un número por punto de venta y tipo
create unique index invoices_one_per_order on public.invoices (order_id) where status = 'authorized';
create unique index invoices_number_unique on public.invoices (restaurant_id, environment, point_of_sale, cbte_type, number)
  where number is not null and status = 'authorized';

alter table public.invoices enable row level security;
create policy invoices_select on public.invoices for select to authenticated
  using (private.is_member(restaurant_id));

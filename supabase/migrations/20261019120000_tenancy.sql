-- =============================================================
-- Comandá · 001 · Multi-tenancy: locales, miembros y perfiles
-- =============================================================
-- Cada tabla de negocio lleva restaurant_id. El acceso se controla con
-- RLS usando las funciones is_member() y has_role() definidas acá.

create type public.member_role as enum ('owner', 'manager', 'cashier', 'waiter', 'kitchen');

-- Trigger genérico para mantener updated_at (lo usa la sincronización offline)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------
-- Perfiles (1:1 con auth.users)
-- -------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -------------------------------------------------------------
-- Locales
-- -------------------------------------------------------------
create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  legal_name  text,
  cuit        text check (cuit is null or cuit ~ '^\d{11}$'),
  address     text,
  phone       text,
  timezone    text not null default 'America/Argentina/Buenos_Aires',
  currency    char(3) not null default 'ARS',
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger restaurants_updated_at before update on public.restaurants
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- Miembros del local (usuarios + rol)
-- -------------------------------------------------------------
create table public.restaurant_members (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          public.member_role not null,
  display_name  text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);

create index restaurant_members_user_idx on public.restaurant_members (user_id);

create trigger restaurant_members_updated_at before update on public.restaurant_members
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- Helpers de autorización (usados por las políticas RLS)
-- security definer para poder leer restaurant_members sin recursión de RLS
-- -------------------------------------------------------------
create or replace function public.is_member(p_restaurant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_members m
    where m.restaurant_id = p_restaurant
      and m.user_id = (select auth.uid())
      and m.active
  );
$$;

create or replace function public.has_role(p_restaurant uuid, p_roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_members m
    where m.restaurant_id = p_restaurant
      and m.user_id = (select auth.uid())
      and m.active
      and m.role = any (p_roles)
  );
$$;

revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.has_role(uuid, public.member_role[]) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.has_role(uuid, public.member_role[]) to authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

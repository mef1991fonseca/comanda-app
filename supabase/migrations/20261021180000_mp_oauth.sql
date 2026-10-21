-- =============================================================
-- Mercado Pago: cada local vincula su propia cuenta (OAuth)
--   mp_accounts     cuenta vinculada (datos públicos; los ven los miembros del local)
--   mp_credentials  access/refresh token del local: sin políticas, solo la service role (edge function)
--   mp_oauth_states intentos de vinculación en curso (state + code_verifier de PKCE), vencen a los 15 min
-- Mientras un local no vincule su cuenta, la función usa la cuenta general (secreto MP_ACCESS_TOKEN).
-- =============================================================

create table public.mp_accounts (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  mp_user_id    text not null,
  nickname      text,
  live_mode     boolean not null default true,
  connected_by  uuid references auth.users (id) on delete set null,
  connected_at  timestamptz not null default now(),
  expires_at    timestamptz,
  refreshed_at  timestamptz
);

alter table public.mp_accounts enable row level security;
create policy mp_accounts_select on public.mp_accounts for select to authenticated
  using (private.is_member(restaurant_id));

create table public.mp_credentials (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  access_token  text not null,
  refresh_token text,
  updated_at    timestamptz not null default now()
);

alter table public.mp_credentials enable row level security;
revoke all on public.mp_credentials from anon, authenticated;

create table public.mp_oauth_states (
  state         text primary key,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  code_verifier text not null,
  created_at    timestamptz not null default now()
);

alter table public.mp_oauth_states enable row level security;
revoke all on public.mp_oauth_states from anon, authenticated;

create index mp_accounts_connected_by_idx on public.mp_accounts (connected_by);
create index mp_oauth_states_restaurant_idx on public.mp_oauth_states (restaurant_id);
create index mp_oauth_states_user_idx on public.mp_oauth_states (user_id);

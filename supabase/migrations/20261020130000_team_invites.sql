-- =============================================================
-- Equipo: invitaciones por link y resguardo de dueños
-- =============================================================

-- Una invitación es un link de un solo uso, con rol fijo y vencimiento.
-- No hace falta conocer el email de la persona: el dueño manda el link por WhatsApp.
create table public.restaurant_invites (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  role          public.member_role not null,
  token         text not null unique
                default replace(replace(replace(encode(extensions.gen_random_bytes(18), 'base64'), '+', '-'), '/', '_'), '=', ''),
  created_by    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  accepted_by   uuid references auth.users (id) on delete set null,
  accepted_at   timestamptz,
  revoked_at    timestamptz
);

create index restaurant_invites_restaurant_idx on public.restaurant_invites (restaurant_id, created_at desc);
create index restaurant_invites_created_by_idx on public.restaurant_invites (created_by);
create index restaurant_invites_accepted_by_idx on public.restaurant_invites (accepted_by);

alter table public.restaurant_invites enable row level security;

-- Solo dueño y encargado ven y crean invitaciones; un encargado no puede invitar dueños.
create policy invites_select on public.restaurant_invites for select to authenticated
  using (private.has_role(restaurant_id, '{owner,manager}'));

create policy invites_insert on public.restaurant_invites for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and accepted_at is null and accepted_by is null and revoked_at is null
    and expires_at <= now() + interval '30 days'
    and (
      private.has_role(restaurant_id, '{owner}')
      or (private.has_role(restaurant_id, '{manager}') and role <> 'owner')
    )
  );

-- Update = anular (revoked_at). El resto de las columnas no se toca desde la app.
create policy invites_update on public.restaurant_invites for update to authenticated
  using (
    private.has_role(restaurant_id, '{owner}')
    or (private.has_role(restaurant_id, '{manager}') and role <> 'owner')
  )
  with check (
    private.has_role(restaurant_id, '{owner}')
    or (private.has_role(restaurant_id, '{manager}') and role <> 'owner')
  );

create or replace function public.restaurant_invites_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('comanda.invite_accept', true) = 'on' then
    return new;
  end if;
  if new.restaurant_id <> old.restaurant_id or new.role <> old.role or new.token <> old.token
     or new.created_by <> old.created_by or new.created_at <> old.created_at
     or new.expires_at <> old.expires_at
     or new.accepted_by is distinct from old.accepted_by
     or new.accepted_at is distinct from old.accepted_at then
    raise exception 'Una invitación solo se puede anular.';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'La invitación ya estaba anulada.';
  end if;
  if old.accepted_at is not null then
    raise exception 'La invitación ya se usó.';
  end if;
  return new;
end;
$$;

create trigger restaurant_invites_guard before update on public.restaurant_invites
  for each row execute function public.restaurant_invites_guard();

-- -------------------------------------------------------------
-- Vista previa (antes de aceptar) y aceptación, por token
-- -------------------------------------------------------------
create or replace function public.invite_preview(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.restaurant_invites;
  v_restaurant text;
  v_by text;
  v_member boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Iniciá sesión para ver la invitación.';
  end if;

  select * into v from public.restaurant_invites where token = p_token;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select r.name into v_restaurant from public.restaurants r where r.id = v.restaurant_id;
  select p.full_name into v_by from public.profiles p where p.id = v.created_by;
  select exists (
    select 1 from public.restaurant_members m
     where m.restaurant_id = v.restaurant_id and m.user_id = (select auth.uid()) and m.active
  ) into v_member;

  return jsonb_build_object(
    'status', case
      when v_member then 'member'
      when v.revoked_at is not null then 'revoked'
      when v.accepted_at is not null then 'used'
      when v.expires_at <= now() then 'expired'
      else 'ok'
    end,
    'restaurant_id', v.restaurant_id,
    'restaurant_name', v_restaurant,
    'role', v.role,
    'invited_by', v_by,
    'expires_at', v.expires_at
  );
end;
$$;

create or replace function public.accept_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v public.restaurant_invites;
  v_current public.restaurant_members;
begin
  if v_user is null then
    raise exception 'Iniciá sesión para aceptar la invitación.';
  end if;

  select * into v from public.restaurant_invites where token = p_token for update;
  if not found then
    raise exception 'El link de invitación no es válido.';
  end if;
  if v.revoked_at is not null then
    raise exception 'Esta invitación fue anulada. Pedí un link nuevo.';
  end if;
  if v.accepted_at is not null then
    raise exception 'Esta invitación ya se usó. Pedí un link nuevo.';
  end if;
  if v.expires_at <= now() then
    raise exception 'Esta invitación venció. Pedí un link nuevo.';
  end if;

  select * into v_current from public.restaurant_members
   where restaurant_id = v.restaurant_id and user_id = v_user for update;

  if found and v_current.active then
    raise exception 'Ya sos parte de este local.';
  elsif found then
    update public.restaurant_members set role = v.role, active = true
     where restaurant_id = v.restaurant_id and user_id = v_user;
  else
    insert into public.restaurant_members (restaurant_id, user_id, role)
    values (v.restaurant_id, v_user, v.role);
  end if;

  perform set_config('comanda.invite_accept', 'on', true);
  update public.restaurant_invites set accepted_by = v_user, accepted_at = now() where id = v.id;
  perform set_config('comanda.invite_accept', 'off', true);

  return v.restaurant_id;
end;
$$;

revoke all on function public.invite_preview(text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.invite_preview(text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;

-- -------------------------------------------------------------
-- Miembros: un local nunca se queda sin dueño activo
-- -------------------------------------------------------------
create or replace function public.restaurant_members_keep_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- (si se está borrando el local entero, el cascade pasa)
  if old.role = 'owner' and old.active
     and (tg_op = 'DELETE' or new.role <> 'owner' or not new.active)
     and exists (select 1 from public.restaurants r where r.id = old.restaurant_id)
     and not exists (
       select 1 from public.restaurant_members m
        where m.restaurant_id = old.restaurant_id and m.user_id <> old.user_id
          and m.role = 'owner' and m.active
     ) then
    raise exception 'El local tiene que tener al menos un dueño activo.';
  end if;
  if tg_op = 'UPDATE' and (new.restaurant_id <> old.restaurant_id or new.user_id <> old.user_id) then
    raise exception 'No se puede mover a una persona de local.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger restaurant_members_keep_owner before update or delete on public.restaurant_members
  for each row execute function public.restaurant_members_keep_owner();

-- Es función de trigger: nadie la llama por la API
revoke all on function public.restaurant_members_keep_owner() from public, anon, authenticated;

-- =============================================================
-- ARCA (factura electrónica): credenciales del proveedor
-- La clave privada, el certificado y la clave de administración viven cifrados en Vault.
-- Solo la edge function `arca` (service_role) los lee o escribe.
-- =============================================================

create or replace function public.arca_get_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s
   where s.name = p_name and p_name like 'arca\_%'
$$;

create or replace function public.arca_put_secret(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if p_name not like 'arca\_%' then
    raise exception 'Nombre de secreto no permitido';
  end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

revoke all on function public.arca_get_secret(text) from public, anon, authenticated;
revoke all on function public.arca_put_secret(text, text) from public, anon, authenticated;
grant execute on function public.arca_get_secret(text) to service_role;
grant execute on function public.arca_put_secret(text, text) to service_role;

-- Ticket de acceso de WSAA: dura 12 h y ARCA no da otro mientras el anterior esté vigente,
-- así que se guarda. Sin políticas: solo la service role lo toca.
create table public.arca_tokens (
  environment text not null check (environment in ('homologacion', 'produccion')),
  service     text not null,
  token       text not null,
  sign        text not null,
  expires_at  timestamptz not null,
  primary key (environment, service)
);
alter table public.arca_tokens enable row level security;

-- Clave para las acciones de administración (generar el pedido de certificado, cargarlo, probar)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'arca_admin_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'arca_admin_key');
  end if;
end $$;

-- =============================================================
-- Operación de salón: pasar de mesa, mozo asignado y unir mesas
-- =============================================================

-- Mesa y mozo: solo en comandas abiertas, la mesa activa y el mozo del equipo del local
create or replace function public.orders_salon_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.waiter_id is not null
     and (tg_op = 'INSERT' or new.waiter_id is distinct from old.waiter_id)
     and not exists (
       select 1 from public.restaurant_members m
        where m.restaurant_id = new.restaurant_id and m.user_id = new.waiter_id and m.active
     ) then
    raise exception 'Esa persona no es parte del equipo del local' using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' and new.table_id is distinct from old.table_id then
    if old.status <> 'open' then
      raise exception 'Solo se puede cambiar de mesa una comanda abierta' using errcode = 'P0001';
    end if;
    if new.table_id is not null and not exists (
      select 1 from public.tables t where t.id = new.table_id and t.restaurant_id = new.restaurant_id and t.active
    ) then
      raise exception 'La mesa no existe o está inactiva' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.orders_salon_guard() from public, anon, authenticated;

create trigger orders_salon_guard before insert or update of table_id, waiter_id on public.orders
  for each row execute function public.orders_salon_guard();

create index if not exists orders_waiter_idx on public.orders (waiter_id);

-- -------------------------------------------------------------
-- Unir mesas: los ítems de la comanda de origen pasan a la de destino
-- y la de origen queda anulada ("Unida a la comanda #N").
-- -------------------------------------------------------------
create or replace function public.merge_orders(p_target uuid, p_source uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.orders;
  s public.orders;
begin
  if p_target = p_source then
    raise exception 'Elegí otra comanda' using errcode = 'P0001';
  end if;
  select * into t from public.orders where id = p_target for update;
  select * into s from public.orders where id = p_source for update;
  if t.id is null or s.id is null or t.restaurant_id <> s.restaurant_id then
    raise exception 'No se encontró la comanda' using errcode = 'P0001';
  end if;
  if not private.has_role(t.restaurant_id, '{owner,manager,cashier,waiter}') then
    raise exception 'Tu rol no puede unir mesas' using errcode = '42501';
  end if;
  if t.status <> 'open' or s.status <> 'open' then
    raise exception 'Las dos comandas tienen que estar abiertas' using errcode = 'P0001';
  end if;
  if s.paid_total > 0 then
    raise exception 'La comanda % ya tiene pagos: cobrala o anulá los pagos antes de unirla', s.number using errcode = 'P0001';
  end if;

  update public.order_items set order_id = t.id where order_id = s.id;

  -- El origen queda vacío
  update public.orders
     set subtotal = 0, discount_amount = 0, status = 'cancelled',
         cancelled_reason = 'Unida a la comanda #' || t.number
   where id = s.id;

  -- Y el destino se recalcula explícito: mover un ítem no cambia su importe, así que el trigger no lo hace
  update public.orders
     set subtotal = coalesce((select sum(oi.line_total) from public.order_items oi
                               where oi.order_id = t.id and oi.status <> 'cancelled'), 0),
         guests = case when t.guests is null and s.guests is null then null
                       else coalesce(t.guests, 0) + coalesce(s.guests, 0) end
   where id = t.id;

  return t.id;
end;
$$;

revoke all on function public.merge_orders(uuid, uuid) from public, anon;
grant execute on function public.merge_orders(uuid, uuid) to authenticated;

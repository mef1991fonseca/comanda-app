-- =============================================================
-- Comandá · 007 · Reglas de cobro, descuentos y cierre
-- =============================================================

-- -------------------------------------------------------------
-- Pagos:
--  * solo sobre comandas abiertas
--  * no se puede cobrar más que lo que falta (el vuelto lo calcula la app)
--  * se asocian a la caja abierta del local; el efectivo exige caja abierta
-- -------------------------------------------------------------
create or replace function public.payments_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_kind    public.payment_kind;
  v_session uuid;
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

  if new.cash_session_id is not null then
    if not exists (select 1 from public.cash_sessions s
                    where s.id = new.cash_session_id and s.closed_at is null) then
      raise exception 'La caja indicada está cerrada' using errcode = 'P0001';
    end if;
  else
    -- Sin caja indicada: si hay una sola abierta, se usa esa
    select s.id into v_session
      from public.cash_sessions s
     where s.restaurant_id = new.restaurant_id and s.closed_at is null
     order by s.opened_at
     limit 1;
    new.cash_session_id := v_session;
  end if;

  if v_kind = 'cash' and new.cash_session_id is null then
    raise exception 'Abrí la caja para cobrar en efectivo' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- -------------------------------------------------------------
-- Descuentos: solo dueño, encargado o cajero
-- -------------------------------------------------------------
create or replace function public.orders_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.discount_amount is distinct from old.discount_amount
     and not private.has_role(new.restaurant_id, '{owner,manager,cashier}') then
    raise exception 'Solo el dueño, el encargado o el cajero pueden aplicar descuentos' using errcode = '42501';
  end if;

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

-- -------------------------------------------------------------
-- Al cerrar una comanda, lo que quedó sin enviar va a cocina
-- (caso típico: venta de mostrador que se cobra antes de prepararse)
-- -------------------------------------------------------------
create or replace function public.orders_send_pending_on_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'closed' and old.status <> 'closed' then
    update public.order_items
       set status = 'sent'
     where order_id = new.id
       and status = 'pending';
  end if;
  return new;
end;
$$;

create trigger orders_send_pending_on_close after update of status on public.orders
  for each row execute function public.orders_send_pending_on_close();

revoke execute on function public.orders_send_pending_on_close() from public, anon, authenticated;

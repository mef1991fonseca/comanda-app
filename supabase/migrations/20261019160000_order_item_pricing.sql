-- =============================================================
-- Comandá · 006 · El precio de cada ítem lo define la carta, no el dispositivo
-- =============================================================
-- Al cargar un ítem con product_id, el servidor completa nombre, precio y
-- estación desde products, y reconstruye los modificadores desde la tabla
-- modifiers a partir de sus ids. El cliente solo manda:
--   { product_id, quantity, notes, modifiers: [{ "id": "<uuid>" }, ...] }
-- Así un mozo no puede cambiar precios y la cocina recibe nombres reales.
-- Los ítems sin product_id (ítem libre) conservan lo que manda el cliente.

create or replace function public.order_items_enrich()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product record;
  v_mods    jsonb;
  v_total   numeric(12, 2);
begin
  -- Producto: solo al insertar (un cambio de precio posterior no reescribe ventas)
  if tg_op = 'INSERT' and new.product_id is not null then
    select p.name, p.price, p.station_id, p.active
      into v_product
      from public.products p
     where p.id = new.product_id
       and p.restaurant_id = new.restaurant_id;

    if not found then
      raise exception 'Producto inexistente' using errcode = 'P0002';
    end if;
    if not v_product.active then
      raise exception 'El producto % no está disponible', v_product.name using errcode = 'P0001';
    end if;

    new.name       := v_product.name;
    new.unit_price := v_product.price;
    new.station_id := coalesce(new.station_id, v_product.station_id);
  end if;

  -- Modificadores: al insertar, o si cambian mientras el ítem sigue pendiente
  if new.product_id is not null
     and (tg_op = 'INSERT' or new.modifiers is distinct from old.modifiers) then
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'price_delta', m.price_delta)
                              order by g.name, m.sort_order, m.name), '[]'::jsonb),
           coalesce(sum(m.price_delta), 0)
      into v_mods, v_total
      from jsonb_array_elements(new.modifiers) e
      join public.modifiers m
        on m.id = (e ->> 'id')::uuid
       and m.restaurant_id = new.restaurant_id
       and m.active
      join public.modifier_groups g on g.id = m.group_id
      join public.product_modifier_groups pmg
        on pmg.group_id = m.group_id
       and pmg.product_id = new.product_id;

    if jsonb_array_length(v_mods) <> jsonb_array_length(new.modifiers) then
      raise exception 'Hay modificadores que no corresponden a este producto' using errcode = 'P0001';
    end if;

    new.modifiers       := v_mods;
    new.modifiers_total := v_total;
  end if;

  return new;
end;
$$;

create trigger order_items_enrich before insert or update of modifiers on public.order_items
  for each row execute function public.order_items_enrich();

revoke execute on function public.order_items_enrich() from public, anon, authenticated;

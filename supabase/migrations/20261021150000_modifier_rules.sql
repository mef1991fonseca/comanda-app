-- =============================================================
-- Mínimos y máximos de los modificadores también en el servidor
--   Al cargar un ítem (o cambiar sus modificadores) se valida cada grupo del producto:
--   no menos que min_select ni más que max_select opciones, y sin repetir una opción.
--   Si un grupo obligatorio tiene menos opciones activas que su mínimo, el mínimo baja a las que hay
--   (para que desactivar una opción no deje el producto imposible de pedir).
-- =============================================================

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
  v_bad     record;
begin
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

  if new.product_id is not null
     and (tg_op = 'INSERT' or new.modifiers is distinct from old.modifiers) then
    new.modifiers := coalesce(new.modifiers, '[]'::jsonb);
    if jsonb_typeof(new.modifiers) <> 'array' then
      raise exception 'Modificadores inválidos' using errcode = 'P0001';
    end if;

    if (select count(*) from jsonb_array_elements(new.modifiers))
       <> (select count(distinct e ->> 'id') from jsonb_array_elements(new.modifiers) e) then
      raise exception 'Hay una opción repetida' using errcode = 'P0001';
    end if;

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

    -- Primer grupo del producto que no cumple su mínimo o su máximo
    select g.name, g.min_select, g.max_select, x.chosen, x.available
      into v_bad
      from public.product_modifier_groups pmg
      join public.modifier_groups g on g.id = pmg.group_id
      cross join lateral (
        select count(*) filter (where m.id in (select (e ->> 'id')::uuid from jsonb_array_elements(v_mods) e)) as chosen,
               count(*) as available
          from public.modifiers m
         where m.group_id = g.id and m.active
      ) x
     where pmg.product_id = new.product_id
       and (x.chosen < least(g.min_select, x.available) or x.chosen > g.max_select)
     order by pmg.sort_order, g.name
     limit 1;

    if found then
      if v_bad.chosen > v_bad.max_select then
        raise exception 'En % se pueden elegir hasta %', v_bad.name, v_bad.max_select using errcode = 'P0001';
      elsif least(v_bad.min_select, v_bad.available) = 1 then
        raise exception 'Elegí una opción de %', v_bad.name using errcode = 'P0001';
      else
        raise exception 'Elegí al menos % en %', least(v_bad.min_select, v_bad.available), v_bad.name using errcode = 'P0001';
      end if;
    end if;

    new.modifiers       := v_mods;
    new.modifiers_total := v_total;
  end if;

  return new;
end;
$$;

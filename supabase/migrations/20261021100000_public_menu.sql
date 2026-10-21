-- =============================================================
-- Carta QR: la carta del local, pública y de solo lectura, en /m/<slug>
-- La única puerta para alguien sin sesión es public_menu(slug): devuelve solo lo que el cliente
-- tiene que ver (nada de costos, stock ni datos internos) y solo si el local la publicó.
-- =============================================================

alter table public.restaurants
  add column menu_slug   text unique check (menu_slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'),
  add column menu_public boolean not null default false,
  add column menu_note   text check (char_length(menu_note) <= 200);

create or replace function public.public_menu(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'restaurant', jsonb_build_object('name', r.name, 'address', r.address, 'phone', r.phone, 'note', r.menu_note),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort_order, c.name)
        from public.categories c
       where c.restaurant_id = r.id and c.active
         and exists (select 1 from public.products p where p.category_id = c.id and p.active)
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'description', p.description, 'price', p.price,
               'category_id', p.category_id, 'favorite', p.is_favorite, 'image_url', p.image_url,
               'options', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'group', g.name,
                          'choices', (select coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'price_delta', m.price_delta)
                                                       order by m.sort_order, m.name), '[]'::jsonb)
                                        from public.modifiers m where m.group_id = g.id and m.active))
                        order by pmg.sort_order)
                   from public.product_modifier_groups pmg
                   join public.modifier_groups g on g.id = pmg.group_id
                  where pmg.product_id = p.id
               ), '[]'::jsonb))
             order by p.sort_order, p.name)
        from public.products p
       where p.restaurant_id = r.id and p.active
    ), '[]'::jsonb)
  )
  from public.restaurants r
  where r.menu_slug = lower(p_slug) and r.menu_public
$$;

revoke all on function public.public_menu(text) from public;
grant execute on function public.public_menu(text) to anon, authenticated;

-- Publicar la carta (dueño o encargado). Valida la dirección y avisa si ya está tomada.
create or replace function public.set_public_menu(p_restaurant uuid, p_slug text, p_public boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
begin
  if not private.has_role(p_restaurant, '{owner,manager}') then
    raise exception 'Solo el dueño o el encargado publican la carta' using errcode = '42501';
  end if;
  if v_slug !~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$' then
    raise exception 'La dirección va en minúsculas, sin espacios ni tildes (letras, números y guiones; de 3 a 40)' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.restaurants where menu_slug = v_slug and id <> p_restaurant) then
    raise exception 'Esa dirección ya la usa otro local. Probá con otra.' using errcode = 'P0001';
  end if;
  update public.restaurants
     set menu_slug = v_slug, menu_public = coalesce(p_public, false), menu_note = nullif(trim(coalesce(p_note, '')), '')
   where id = p_restaurant;
  return v_slug;
end;
$$;

revoke all on function public.set_public_menu(uuid, text, boolean, text) from public, anon;
grant execute on function public.set_public_menu(uuid, text, boolean, text) to authenticated;

-- Carta QR (2): la carta pública suma ids, mínimos y máximos de las opciones, y si el local toma pedidos.

create or replace function public.public_menu(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'restaurant', jsonb_build_object('name', r.name, 'address', r.address, 'phone', r.phone, 'note', r.menu_note),
    'ordering', r.menu_ordering,
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
                          'id', g.id, 'group', g.name, 'min', g.min_select, 'max', g.max_select,
                          'choices', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'price_delta', m.price_delta)
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


-- Local de demostración (3): alta del local con carta, recetas, stock, clientes, proveedores y gastos.

-- ---------- Alta del local con todo lo fijo ----------
create or replace function public.create_demo_restaurant()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r uuid;
  v_cocina uuid;
  v_barra uuid;
  v_cat jsonb := '{}'::jsonb;
  v_ing jsonb := '{}'::jsonb;
  v_prod jsonb := '{}'::jsonb;
  v_id uuid;
  v_g_punto uuid;
  v_g_guarn uuid;
  v_g_extra uuid;
  v_transfer uuid;
  v_month date := date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires'))::date;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_sup jsonb := '{}'::jsonb;
  x record;
  w int;
  v_o int := 0;
begin
  if (select count(*) from public.restaurants rr
        join public.restaurant_members m on m.restaurant_id = rr.id and m.user_id = (select auth.uid()) and m.active
       where rr.is_demo) >= 1 then
    raise exception 'Ya tenés un local de demostración. Borralo para crear otro.' using errcode = 'P0001';
  end if;

  r := public.create_restaurant('Bodegón La Esquina (demo)', 12);
  update public.restaurants
     set is_demo = true,
         address = 'Av. Corrientes 1234, CABA',
         phone = '11 4555-0101',
         menu_slug = 'demo-' || left(replace(r::text, '-', ''), 8),
         menu_public = true,
         menu_note = 'Local de demostración · Abierto de 12 a 16 y de 20 a 24'
   where id = r;
  select id into v_cocina from public.stations where restaurant_id = r and name = 'Cocina';
  select id into v_barra from public.stations where restaurant_id = r and name = 'Barra';
  select id into v_transfer from public.payment_methods where restaurant_id = r and kind = 'transfer';

  -- Categorías
  for x in select * from (values (0, 'Entradas'), (1, 'Principales'), (2, 'Pastas'), (3, 'Pizzas'), (4, 'Postres'), (5, 'Bebidas')) t(o, n) loop
    insert into public.categories (restaurant_id, name, sort_order) values (r, x.n, x.o) returning id into v_id;
    v_cat := v_cat || jsonb_build_object(x.n, v_id);
  end loop;

  -- Insumos: costo, mínimo y stock inicial
  for x in select * from (values
      ('Carne vacuna', 'kg', 9500, 10, 400), ('Pollo', 'kg', 5800, 6, 150), ('Muzzarella', 'kg', 7200, 8, 200),
      ('Queso provolone', 'kg', 11000, 2, 40), ('Jamón cocido', 'kg', 8500, 2, 60), ('Harina 000', 'kg', 950, 10, 200),
      ('Papa', 'kg', 850, 20, 500), ('Tomate', 'kg', 1600, 5, 120), ('Huevo', 'unit', 230, 60, 800),
      ('Pan de hamburguesa', 'unit', 320, 24, 400), ('Pasta fresca', 'kg', 3200, 5, 120), ('Flan casero', 'unit', 750, 10, 300),
      ('Gaseosa 500 ml', 'unit', 950, 24, 900), ('Agua mineral 500 ml', 'unit', 620, 24, 600),
      ('Cerveza 1 L', 'unit', 2300, 24, 700), ('Vino Malbec', 'unit', 4800, 6, 150)
    ) t(n, u, c, mn, st) loop
    insert into public.ingredients (restaurant_id, name, unit, cost_per_unit, min_stock)
    values (r, x.n, x.u::public.stock_unit, x.c, x.mn) returning id into v_id;
    insert into public.stock_movements (restaurant_id, ingredient_id, qty_delta, reason, note, created_at)
    values (r, v_id, x.st, 'adjustment', 'Stock inicial', (v_month::timestamp at time zone 'America/Argentina/Buenos_Aires'));
    v_ing := v_ing || jsonb_build_object(x.n, v_id);
  end loop;

  -- Productos
  for x in select * from (values
      ('Entradas', 'Empanada de carne', 'Cortada a cuchillo, al horno', 1800, false, 'Cocina'),
      ('Entradas', 'Provoleta', 'A la parrilla con orégano y aceite de oliva', 7500, false, 'Cocina'),
      ('Entradas', 'Papas fritas', 'Porción grande', 6000, false, 'Cocina'),
      ('Principales', 'Milanesa napolitana', 'De ternera, con jamón, salsa y muzzarella', 14500, true, 'Cocina'),
      ('Principales', 'Bife de chorizo', '400 g de corte, a la parrilla', 18900, true, 'Cocina'),
      ('Principales', 'Pollo grillado', 'Suprema a la plancha', 12800, false, 'Cocina'),
      ('Principales', 'Hamburguesa completa', 'Medallón casero, lechuga, tomate y papas', 11500, true, 'Cocina'),
      ('Pastas', 'Ñoquis con tuco', 'Caseros, salsa de tomate', 10900, false, 'Cocina'),
      ('Pastas', 'Sorrentinos de jamón y queso', 'Con salsa a elección', 12500, false, 'Cocina'),
      ('Pastas', 'Lasaña de carne', 'Gratinada', 13200, false, 'Cocina'),
      ('Pizzas', 'Pizza muzzarella', 'Grande, 8 porciones', 11000, true, 'Cocina'),
      ('Pizzas', 'Pizza napolitana', 'Con rodajas de tomate y ajo', 12500, false, 'Cocina'),
      ('Pizzas', 'Fugazzeta', 'Rellena con muzzarella y cebolla', 12000, false, 'Cocina'),
      ('Postres', 'Flan casero', 'Con dulce de leche o crema', 5200, false, 'Cocina'),
      ('Postres', 'Tiramisú', 'De la casa', 6000, false, 'Cocina'),
      ('Bebidas', 'Gaseosa 500 ml', null, 3200, false, 'Barra'),
      ('Bebidas', 'Agua mineral', 'Con o sin gas', 2800, false, 'Barra'),
      ('Bebidas', 'Cerveza 1 L', 'Rubia o negra', 6500, true, 'Barra'),
      ('Bebidas', 'Vino Malbec', 'Botella 750 ml', 14000, false, 'Barra'),
      ('Bebidas', 'Café', 'Espresso o cortado', 2200, false, 'Barra')
    ) t(cat, n, d, p, fav, st) loop
    v_o := v_o + 1;
    insert into public.products (restaurant_id, category_id, station_id, name, description, price, is_favorite, sort_order)
    values (r, (v_cat ->> x.cat)::uuid, case when x.st = 'Barra' then v_barra else v_cocina end, x.n, x.d, x.p, x.fav, v_o)
    returning id into v_id;
    v_prod := v_prod || jsonb_build_object(x.n, v_id);
  end loop;

  -- Recetas (Tiramisú y Café quedan sin receta: así se ve el aviso en los reportes)
  for x in select * from (values
      ('Empanada de carne', 'Carne vacuna', 0.06), ('Empanada de carne', 'Harina 000', 0.05),
      ('Provoleta', 'Queso provolone', 0.2), ('Papas fritas', 'Papa', 0.4),
      ('Milanesa napolitana', 'Carne vacuna', 0.25), ('Milanesa napolitana', 'Muzzarella', 0.08),
      ('Milanesa napolitana', 'Jamón cocido', 0.04), ('Milanesa napolitana', 'Tomate', 0.05), ('Milanesa napolitana', 'Huevo', 1),
      ('Bife de chorizo', 'Carne vacuna', 0.4), ('Pollo grillado', 'Pollo', 0.35),
      ('Hamburguesa completa', 'Carne vacuna', 0.18), ('Hamburguesa completa', 'Pan de hamburguesa', 1),
      ('Hamburguesa completa', 'Papa', 0.2), ('Hamburguesa completa', 'Tomate', 0.03),
      ('Ñoquis con tuco', 'Pasta fresca', 0.3), ('Ñoquis con tuco', 'Tomate', 0.1),
      ('Sorrentinos de jamón y queso', 'Pasta fresca', 0.3), ('Sorrentinos de jamón y queso', 'Tomate', 0.08),
      ('Lasaña de carne', 'Pasta fresca', 0.25), ('Lasaña de carne', 'Carne vacuna', 0.1), ('Lasaña de carne', 'Muzzarella', 0.08),
      ('Pizza muzzarella', 'Harina 000', 0.25), ('Pizza muzzarella', 'Muzzarella', 0.25), ('Pizza muzzarella', 'Tomate', 0.08),
      ('Pizza napolitana', 'Harina 000', 0.25), ('Pizza napolitana', 'Muzzarella', 0.22), ('Pizza napolitana', 'Tomate', 0.15),
      ('Fugazzeta', 'Harina 000', 0.3), ('Fugazzeta', 'Muzzarella', 0.3),
      ('Flan casero', 'Flan casero', 1), ('Gaseosa 500 ml', 'Gaseosa 500 ml', 1), ('Agua mineral', 'Agua mineral 500 ml', 1),
      ('Cerveza 1 L', 'Cerveza 1 L', 1), ('Vino Malbec', 'Vino Malbec', 1)
    ) t(p, i, q) loop
    insert into public.recipe_items (restaurant_id, product_id, ingredient_id, quantity)
    values (r, (v_prod ->> x.p)::uuid, (v_ing ->> x.i)::uuid, x.q);
  end loop;

  -- Modificadores
  insert into public.modifier_groups (restaurant_id, name, min_select, max_select) values (r, 'Punto de la carne', 1, 1) returning id into v_g_punto;
  insert into public.modifier_groups (restaurant_id, name, min_select, max_select) values (r, 'Guarnición', 1, 1) returning id into v_g_guarn;
  insert into public.modifier_groups (restaurant_id, name, min_select, max_select) values (r, 'Extras', 0, 3) returning id into v_g_extra;
  insert into public.modifiers (restaurant_id, group_id, name, price_delta, sort_order) values
    (r, v_g_punto, 'Jugoso', 0, 0), (r, v_g_punto, 'A punto', 0, 1), (r, v_g_punto, 'Cocido', 0, 2),
    (r, v_g_guarn, 'Papas fritas', 0, 0), (r, v_g_guarn, 'Puré', 0, 1), (r, v_g_guarn, 'Ensalada mixta', 1500, 2),
    (r, v_g_extra, 'Huevo frito', 800, 0), (r, v_g_extra, 'Panceta', 1200, 1), (r, v_g_extra, 'Cheddar', 1000, 2);
  insert into public.product_modifier_groups (restaurant_id, product_id, group_id, sort_order) values
    (r, (v_prod ->> 'Bife de chorizo')::uuid, v_g_punto, 0),
    (r, (v_prod ->> 'Bife de chorizo')::uuid, v_g_guarn, 1),
    (r, (v_prod ->> 'Milanesa napolitana')::uuid, v_g_guarn, 0),
    (r, (v_prod ->> 'Pollo grillado')::uuid, v_g_guarn, 0),
    (r, (v_prod ->> 'Hamburguesa completa')::uuid, v_g_extra, 0);

  -- Clientes con cuenta corriente
  insert into public.customers (restaurant_id, name, doc_type, doc_number, iva_condition, phone, credit_limit, notes) values
    (r, 'Estudio Contable Ruiz', 80, '30712345674', 1, '11 4321-9876', 600000, 'Almuerzos del equipo, pagan a fin de mes'),
    (r, 'Martín Gómez', 96, '30123456', 5, '11 6000-1122', 60000, 'Cliente de todos los viernes'),
    (r, 'Club Social Barrio Norte', 80, '30598765432', 4, null, 300000, null);

  -- Proveedores
  for x in select * from (values ('Frigorífico del Sur', '30711112223'), ('Lácteos La Pampa', null), ('Verdulería Don José', null),
                                 ('Distribuidora Norte (bebidas)', '30722223334'), ('Inmobiliaria Centro', null),
                                 ('Servicios (luz, gas, internet)', null), ('Personal', null), ('Impuestos', null)) t(n, c) loop
    insert into public.suppliers (restaurant_id, name, cuit) values (r, x.n, x.c) returning id into v_id;
    v_sup := v_sup || jsonb_build_object(x.n, v_id);
  end loop;

  -- Compras semanales de mercadería y bebidas (algunas quedan debiéndose)
  for w in 0 .. 3 loop
    exit when v_month + w * 7 + 2 > v_today;
    perform public.register_purchase(jsonb_build_object(
      'supplier_id', v_sup ->> 'Frigorífico del Sur', 'issued_on', v_month + w * 7 + 2, 'category', 'mercaderia',
      'doc_kind', 'factura_a', 'doc_number', '0003-000' || (4512 + w),
      'items', jsonb_build_array(
        jsonb_build_object('ingredient_id', v_ing ->> 'Carne vacuna', 'quantity', 90, 'line_total', 90 * 9500),
        jsonb_build_object('ingredient_id', v_ing ->> 'Pollo', 'quantity', 30, 'line_total', 30 * 5800)),
      'paid', case when w < 3 then jsonb_build_object('method_id', v_transfer, 'amount', 90 * 9500 + 30 * 5800) end));
    perform public.register_purchase(jsonb_build_object(
      'supplier_id', v_sup ->> 'Lácteos La Pampa', 'issued_on', v_month + w * 7 + 3, 'category', 'mercaderia',
      'items', jsonb_build_array(
        jsonb_build_object('ingredient_id', v_ing ->> 'Muzzarella', 'quantity', 45, 'line_total', 45 * 7200),
        jsonb_build_object('ingredient_id', v_ing ->> 'Queso provolone', 'quantity', 6, 'line_total', 6 * 11000),
        jsonb_build_object('ingredient_id', v_ing ->> 'Jamón cocido', 'quantity', 8, 'line_total', 8 * 8500)),
      'paid', jsonb_build_object('method_id', v_transfer, 'amount', 45 * 7200 + 6 * 11000 + 8 * 8500)));
    perform public.register_purchase(jsonb_build_object(
      'supplier_id', v_sup ->> 'Verdulería Don José', 'issued_on', v_month + w * 7 + 2, 'category', 'mercaderia', 'doc_kind', 'remito',
      'items', jsonb_build_array(
        jsonb_build_object('ingredient_id', v_ing ->> 'Papa', 'quantity', 120, 'line_total', 120 * 850),
        jsonb_build_object('ingredient_id', v_ing ->> 'Tomate', 'quantity', 25, 'line_total', 25 * 1600)),
      'paid', case when w <> 2 then jsonb_build_object('method_id', v_transfer, 'amount', 120 * 850 + 25 * 1600) end));
    perform public.register_purchase(jsonb_build_object(
      'supplier_id', v_sup ->> 'Distribuidora Norte (bebidas)', 'issued_on', v_month + w * 7 + 4, 'category', 'bebidas',
      'doc_kind', 'factura_a', 'doc_number', '0001-0000' || (8810 + w),
      'items', jsonb_build_array(
        jsonb_build_object('ingredient_id', v_ing ->> 'Gaseosa 500 ml', 'quantity', 144, 'line_total', 144 * 950),
        jsonb_build_object('ingredient_id', v_ing ->> 'Agua mineral 500 ml', 'quantity', 96, 'line_total', 96 * 620),
        jsonb_build_object('ingredient_id', v_ing ->> 'Cerveza 1 L', 'quantity', 120, 'line_total', 120 * 2300),
        jsonb_build_object('ingredient_id', v_ing ->> 'Vino Malbec', 'quantity', 24, 'line_total', 24 * 4800)),
      'paid', case when w < 3 then jsonb_build_object('method_id', v_transfer, 'amount', 144 * 950 + 96 * 620 + 120 * 2300 + 24 * 4800) end));
  end loop;

  -- Gastos fijos del mes
  perform public.register_purchase(jsonb_build_object('supplier_id', v_sup ->> 'Inmobiliaria Centro', 'issued_on', v_month, 'category', 'alquiler',
    'doc_kind', 'otro', 'items', jsonb_build_array(jsonb_build_object('description', 'Alquiler del local', 'quantity', 1, 'line_total', 1600000)),
    'paid', jsonb_build_object('method_id', v_transfer, 'amount', 1600000)));
  perform public.register_purchase(jsonb_build_object('supplier_id', v_sup ->> 'Personal', 'issued_on', least(v_month + 4, v_today), 'category', 'sueldos',
    'doc_kind', 'otro', 'items', jsonb_build_array(jsonb_build_object('description', 'Sueldos (8 personas)', 'quantity', 1, 'line_total', 8500000)),
    'paid', jsonb_build_object('method_id', v_transfer, 'amount', 8500000)));
  perform public.register_purchase(jsonb_build_object('supplier_id', v_sup ->> 'Servicios (luz, gas, internet)', 'issued_on', least(v_month + 11, v_today),
    'category', 'servicios', 'items', jsonb_build_array(
      jsonb_build_object('description', 'Luz', 'quantity', 1, 'line_total', 320000),
      jsonb_build_object('description', 'Gas', 'quantity', 1, 'line_total', 140000),
      jsonb_build_object('description', 'Internet', 'quantity', 1, 'line_total', 35000))));
  perform public.register_purchase(jsonb_build_object('supplier_id', v_sup ->> 'Impuestos', 'issued_on', least(v_month + 19, v_today), 'category', 'impuestos',
    'items', jsonb_build_array(jsonb_build_object('description', 'Cargas sociales, ingresos brutos y tasas', 'quantity', 1, 'line_total', 1900000)),
    'paid', jsonb_build_object('method_id', v_transfer, 'amount', 1900000)));

  return r;
end;
$$;

revoke all on function public.create_demo_restaurant() from public, anon;
grant execute on function public.create_demo_restaurant() to authenticated;

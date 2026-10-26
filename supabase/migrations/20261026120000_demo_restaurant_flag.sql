-- =============================================================
-- Local de demostración
--   create_demo_restaurant()        crea "Bodegón La Esquina (demo)" con carta, recetas, stock, clientes,
--                                   proveedores y gastos del mes. Devuelve el id.
--   demo_fill_day(local, días)      ventas cerradas de ese día (con su caja abierta y cerrada). La app lo llama
--                                   de a un día (24 → 1) para no pasar el límite de tiempo de cada llamada.
--   demo_finish(local)              "ahora": caja abierta, ventas de hoy, mesas ocupadas en distintos estados
--                                   de cocina, una venta para llevar y conteo de stock con algunos faltantes.
--   delete_demo_restaurant(local)   borra el local (solo si es de demostración y sos el dueño).
-- Todo pasa por las mismas reglas que la app (precios por trigger, pagos, stock, costo al cerrar);
-- solo se ajustan las fechas para que el historial quede en el pasado.
-- =============================================================

alter table public.restaurants add column if not exists is_demo boolean not null default false;

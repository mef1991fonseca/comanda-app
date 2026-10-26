-- Local de demostración (6): borrado.

create or replace function public.delete_demo_restaurant(p_restaurant uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t text;
begin
  perform private.demo_guard(p_restaurant);
  -- En orden, para no chocar con las relaciones que no se borran en cascada (pagos, cajas, compras).
  -- Los ítems caen con su comanda: como la comanda ya no existe, la regla de "comanda cerrada" no aplica.
  update public.invoices set credit_note_id = null where restaurant_id = p_restaurant and credit_note_id is not null;
  execute 'delete from public.invoices where restaurant_id = $1 and associated_id is not null' using p_restaurant;
  foreach t in array array['customer_movements', 'supplier_movements', 'invoices', 'mp_charges', 'payments', 'orders',
                           'cash_movements', 'cash_sessions', 'purchases', 'stock_movements', 'recipe_items'] loop
    execute format('delete from public.%I where restaurant_id = $1', t) using p_restaurant;
  end loop;
  execute 'delete from public.restaurants where id = $1' using p_restaurant;
end;
$$;

revoke all on function public.delete_demo_restaurant(uuid) from public, anon;
grant execute on function public.delete_demo_restaurant(uuid) to authenticated;

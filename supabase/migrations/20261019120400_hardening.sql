-- =============================================================
-- Comandá · 005 · Endurecimiento: helpers fuera de la API y FKs indexadas
-- =============================================================

-- Los helpers de RLS no necesitan estar expuestos como /rpc. Las políticas
-- los referencian por OID, así que moverlos de schema no las rompe.
create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.is_member(uuid) set schema private;
alter function public.has_role(uuid, public.member_role[]) set schema private;

-- Índices que cubren las FKs compuestas (restaurant_id, x)
drop index if exists public.cash_movements_session_idx;
drop index if exists public.modifiers_group_idx;
-- (order_items_order_idx y payments_order_idx se conservan: los triggers filtran solo por order_id)
drop index if exists public.orders_cash_session_idx;
drop index if exists public.payments_cash_session_idx;
drop index if exists public.payments_method_idx;
drop index if exists public.products_category_idx;
drop index if exists public.recipe_items_ingredient_idx;
drop index if exists public.product_modifier_groups_group_idx;

create index cash_movements_session_fk_idx      on public.cash_movements (restaurant_id, cash_session_id);
create index cash_sessions_register_fk_idx      on public.cash_sessions (restaurant_id, register_id);
create index categories_parent_fk_idx           on public.categories (restaurant_id, parent_id);
create index modifiers_group_fk_idx             on public.modifiers (restaurant_id, group_id);
create index order_items_order_fk_idx           on public.order_items (restaurant_id, order_id);
create index order_items_product_fk_idx         on public.order_items (restaurant_id, product_id);
create index orders_cash_session_fk_idx         on public.orders (restaurant_id, cash_session_id);
create index orders_table_fk_idx                on public.orders (restaurant_id, table_id);
create index payments_cash_session_fk_idx       on public.payments (restaurant_id, cash_session_id);
create index payments_order_fk_idx              on public.payments (restaurant_id, order_id);
create index payments_method_fk_idx             on public.payments (restaurant_id, payment_method_id);
create index product_modifier_groups_group_fk_idx   on public.product_modifier_groups (restaurant_id, group_id);
create index product_modifier_groups_product_fk_idx on public.product_modifier_groups (restaurant_id, product_id);
create index products_category_fk_idx           on public.products (restaurant_id, category_id);
create index products_station_fk_idx            on public.products (restaurant_id, station_id);
create index recipe_items_ingredient_fk_idx     on public.recipe_items (restaurant_id, ingredient_id);
create index recipe_items_product_fk_idx        on public.recipe_items (restaurant_id, product_id);
create index stock_movements_ingredient_fk_idx  on public.stock_movements (restaurant_id, ingredient_id);
create index tables_area_fk_idx                 on public.tables (restaurant_id, area_id);

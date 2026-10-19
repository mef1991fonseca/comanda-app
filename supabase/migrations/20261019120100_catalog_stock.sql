-- =============================================================
-- Comandá · 002 · Carta (productos, modificadores) y stock (insumos, recetas)
-- =============================================================
-- Convención: las tablas hijas referencian a la madre con FK compuesta
-- (restaurant_id, id) para que sea imposible mezclar datos entre locales.
--
-- Modelo de stock: el stock vive SOLO en ingredients. Un producto que se
-- vende "tal cual" (una gaseosa) es un producto con receta de 1 unidad del
-- insumo correspondiente. Toda variación pasa por stock_movements.

create type public.stock_unit as enum ('unit', 'g', 'kg', 'ml', 'l');
create type public.stock_reason as enum ('sale', 'sale_reversal', 'purchase', 'adjustment', 'waste', 'count');

-- -------------------------------------------------------------
-- Estaciones de preparación (Cocina, Barra...) → ruteo de comandas y KDS
-- -------------------------------------------------------------
create table public.stations (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, name)
);

-- -------------------------------------------------------------
-- Categorías (con subcategorías vía parent_id)
-- -------------------------------------------------------------
create table public.categories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  parent_id     uuid,
  name          text not null check (char_length(name) between 1 and 80),
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, parent_id)
    references public.categories (restaurant_id, id) on delete set null (parent_id)
);

-- -------------------------------------------------------------
-- Productos
-- -------------------------------------------------------------
create table public.products (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  category_id   uuid,
  station_id    uuid,
  name          text not null check (char_length(name) between 1 and 120),
  description   text,
  price         numeric(12, 2) not null default 0 check (price >= 0),
  sku           text,
  image_url     text,
  is_favorite   boolean not null default false,
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, category_id)
    references public.categories (restaurant_id, id) on delete set null (category_id),
  foreign key (restaurant_id, station_id)
    references public.stations (restaurant_id, id) on delete set null (station_id)
);

create index products_category_idx on public.products (category_id);

-- -------------------------------------------------------------
-- Modificadores y adicionales (ej. "Punto de la carne", "Extra queso")
-- -------------------------------------------------------------
create table public.modifier_groups (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  min_select    int not null default 0 check (min_select >= 0),
  max_select    int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  check (max_select >= min_select and max_select >= 1)
);

create table public.modifiers (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  group_id      uuid not null,
  name          text not null check (char_length(name) between 1 and 80),
  price_delta   numeric(12, 2) not null default 0,
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (restaurant_id, group_id)
    references public.modifier_groups (restaurant_id, id) on delete cascade
);

create index modifiers_group_idx on public.modifiers (group_id);

create table public.product_modifier_groups (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  product_id    uuid not null,
  group_id      uuid not null,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (product_id, group_id),
  foreign key (restaurant_id, product_id)
    references public.products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, group_id)
    references public.modifier_groups (restaurant_id, id) on delete cascade
);

create index product_modifier_groups_group_idx on public.product_modifier_groups (group_id);

-- -------------------------------------------------------------
-- Insumos (stock)
-- -------------------------------------------------------------
create table public.ingredients (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 120),
  unit           public.stock_unit not null default 'unit',
  cost_per_unit  numeric(14, 4) not null default 0 check (cost_per_unit >= 0),
  stock_qty      numeric(14, 3) not null default 0,
  min_stock      numeric(14, 3) not null default 0 check (min_stock >= 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, name)
);

-- -------------------------------------------------------------
-- Recetas: cuánto insumo consume una unidad de producto
-- -------------------------------------------------------------
create table public.recipe_items (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  product_id    uuid not null,
  ingredient_id uuid not null,
  quantity      numeric(14, 3) not null check (quantity > 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (product_id, ingredient_id),
  foreign key (restaurant_id, product_id)
    references public.products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, ingredient_id)
    references public.ingredients (restaurant_id, id) on delete restrict
);

create index recipe_items_ingredient_idx on public.recipe_items (ingredient_id);

-- -------------------------------------------------------------
-- Movimientos de stock (inmutables; son la única forma de mover stock)
-- -------------------------------------------------------------
create table public.stock_movements (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  ingredient_id uuid not null,
  qty_delta     numeric(14, 3) not null check (qty_delta <> 0),
  reason        public.stock_reason not null,
  unit_cost     numeric(14, 4) check (unit_cost is null or unit_cost >= 0),
  order_id      uuid,
  note          text,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  foreign key (restaurant_id, ingredient_id)
    references public.ingredients (restaurant_id, id) on delete cascade
);

create index stock_movements_ingredient_idx on public.stock_movements (ingredient_id, created_at desc);
create index stock_movements_restaurant_idx on public.stock_movements (restaurant_id, created_at desc);
create index stock_movements_order_idx on public.stock_movements (order_id) where order_id is not null;

-- Aplica cada movimiento al stock del insumo (y actualiza costo en compras)
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ingredients i
     set stock_qty     = i.stock_qty + new.qty_delta,
         cost_per_unit = case
                           when new.reason = 'purchase' and new.unit_cost is not null then new.unit_cost
                           else i.cost_per_unit
                         end
   where i.id = new.ingredient_id;
  return new;
end;
$$;

create trigger stock_movements_apply after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

revoke execute on function public.apply_stock_movement() from public, anon, authenticated;

-- updated_at
create trigger stations_updated_at before update on public.stations for each row execute function public.set_updated_at();
create trigger categories_updated_at before update on public.categories for each row execute function public.set_updated_at();
create trigger products_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger modifier_groups_updated_at before update on public.modifier_groups for each row execute function public.set_updated_at();
create trigger modifiers_updated_at before update on public.modifiers for each row execute function public.set_updated_at();
create trigger product_modifier_groups_updated_at before update on public.product_modifier_groups for each row execute function public.set_updated_at();
create trigger ingredients_updated_at before update on public.ingredients for each row execute function public.set_updated_at();
create trigger recipe_items_updated_at before update on public.recipe_items for each row execute function public.set_updated_at();

-- Índices por local (todas las consultas filtran por restaurant_id)
create index stations_restaurant_idx on public.stations (restaurant_id);
create index categories_restaurant_idx on public.categories (restaurant_id);
create index products_restaurant_idx on public.products (restaurant_id);
create index modifier_groups_restaurant_idx on public.modifier_groups (restaurant_id);
create index modifiers_restaurant_idx on public.modifiers (restaurant_id);
create index ingredients_restaurant_idx on public.ingredients (restaurant_id);
create index recipe_items_restaurant_idx on public.recipe_items (restaurant_id);

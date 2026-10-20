-- =============================================================
-- Proveedores, compras y gastos, y cuenta corriente con proveedores
-- Una compra se registra entera con register_purchase: suma stock (y actualiza el costo) de los insumos,
-- y queda como deuda con el proveedor; si se paga en el momento, se registra el pago también.
-- Saldo con el proveedor = suma de supplier_movements (+ le debemos, − le pagamos).
-- =============================================================

create table public.suppliers (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (char_length(trim(name)) between 1 and 120),
  cuit          text check (cuit ~ '^\d{11}$'),
  phone         text,
  email         text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id)
);
create index suppliers_restaurant_idx on public.suppliers (restaurant_id, name);
create trigger suppliers_updated_at before update on public.suppliers for each row execute function public.set_updated_at();

alter table public.suppliers enable row level security;
create policy suppliers_select on public.suppliers for select to authenticated
  using (private.has_role(restaurant_id, '{owner,manager,cashier}'));
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (private.has_role(restaurant_id, '{owner,manager}'));
create policy suppliers_update on public.suppliers for update to authenticated
  using (private.has_role(restaurant_id, '{owner,manager}'))
  with check (private.has_role(restaurant_id, '{owner,manager}'));

create type public.expense_category as enum
  ('mercaderia', 'bebidas', 'descartables', 'servicios', 'alquiler', 'sueldos', 'impuestos', 'mantenimiento', 'otros');

create table public.purchases (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  supplier_id   uuid not null,
  issued_on     date not null,
  due_on        date,
  doc_kind      text not null default 'factura' check (doc_kind in ('factura_a', 'factura_b', 'factura_c', 'factura', 'remito', 'ticket', 'otro')),
  doc_number    text,
  category      public.expense_category not null default 'mercaderia',
  total         numeric(12, 2) not null check (total > 0),
  notes         text,
  cancelled_at  timestamptz,
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, supplier_id) references public.suppliers (restaurant_id, id) on delete restrict
);
create index purchases_restaurant_idx on public.purchases (restaurant_id, issued_on desc);
create index purchases_supplier_idx on public.purchases (restaurant_id, supplier_id);
create index purchases_created_by_idx on public.purchases (created_by);

create table public.purchase_items (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  purchase_id   uuid not null,
  ingredient_id uuid,
  description   text not null,
  quantity      numeric(12, 3) not null check (quantity > 0),
  line_total    numeric(12, 2) not null check (line_total >= 0),
  foreign key (restaurant_id, purchase_id) references public.purchases (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, ingredient_id) references public.ingredients (restaurant_id, id) on delete set null (ingredient_id)
);
create index purchase_items_purchase_idx on public.purchase_items (restaurant_id, purchase_id);
create index purchase_items_ingredient_idx on public.purchase_items (restaurant_id, ingredient_id);

create table public.supplier_movements (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants (id) on delete cascade,
  supplier_id       uuid not null,
  kind              text not null check (kind in ('purchase', 'payment', 'reversal')),
  amount            numeric(12, 2) not null check (amount <> 0),
  purchase_id       uuid,
  payment_method_id uuid,
  cash_movement_id  uuid references public.cash_movements (id) on delete set null,
  note              text,
  created_by        uuid references auth.users (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  foreign key (restaurant_id, supplier_id) references public.suppliers (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, purchase_id) references public.purchases (restaurant_id, id) on delete set null (purchase_id),
  foreign key (restaurant_id, payment_method_id) references public.payment_methods (restaurant_id, id) on delete set null (payment_method_id)
);
create index supplier_movements_supplier_idx on public.supplier_movements (restaurant_id, supplier_id, created_at desc);
create index supplier_movements_purchase_idx on public.supplier_movements (restaurant_id, purchase_id);
create index supplier_movements_method_idx on public.supplier_movements (restaurant_id, payment_method_id);
create index supplier_movements_cash_idx on public.supplier_movements (cash_movement_id);
create index supplier_movements_created_by_idx on public.supplier_movements (created_by);

alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.supplier_movements enable row level security;
create policy purchases_select on public.purchases for select to authenticated
  using (private.has_role(restaurant_id, '{owner,manager,cashier}'));
create policy purchase_items_select on public.purchase_items for select to authenticated
  using (private.has_role(restaurant_id, '{owner,manager,cashier}'));
create policy supplier_movements_select on public.supplier_movements for select to authenticated
  using (private.has_role(restaurant_id, '{owner,manager,cashier}'));

create view public.supplier_balances with (security_invoker = on) as
  select s.id, s.restaurant_id, coalesce(sum(m.amount), 0)::numeric(12, 2) as balance
    from public.suppliers s
    left join public.supplier_movements m on m.supplier_id = s.id and m.restaurant_id = s.restaurant_id
   group by s.id, s.restaurant_id;

-- -------------------------------------------------------------
-- Pagos a proveedores (también usado por register_purchase)
-- -------------------------------------------------------------
create or replace function private.pay_supplier(p_supplier public.suppliers, p_amount numeric, p_method uuid, p_note text, p_purchase uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pm public.payment_methods;
  v_session uuid;
  v_cash uuid;
begin
  select * into pm from public.payment_methods where id = p_method and restaurant_id = p_supplier.restaurant_id;
  if pm.id is null or pm.kind = 'account' then
    raise exception 'Elegí con qué se paga' using errcode = 'P0001';
  end if;
  if pm.kind = 'cash' then
    select s.id into v_session from public.cash_sessions s
     where s.restaurant_id = p_supplier.restaurant_id and s.closed_at is null order by s.opened_at limit 1;
    if v_session is null then
      raise exception 'Abrí la caja para pagar en efectivo' using errcode = 'P0001';
    end if;
    insert into public.cash_movements (restaurant_id, cash_session_id, kind, amount, reason)
    values (p_supplier.restaurant_id, v_session, 'out', p_amount, 'Pago a proveedor · ' || p_supplier.name)
    returning id into v_cash;
  end if;
  insert into public.supplier_movements (restaurant_id, supplier_id, kind, amount, purchase_id, payment_method_id, cash_movement_id, note)
  values (p_supplier.restaurant_id, p_supplier.id, 'payment', -p_amount, p_purchase, pm.id, v_cash, nullif(trim(coalesce(p_note, '')), ''));
end;
$$;
revoke all on function private.pay_supplier(public.suppliers, numeric, uuid, text, uuid) from public, anon, authenticated;

create or replace function public.supplier_payment(p_supplier uuid, p_amount numeric, p_method uuid, p_note text default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.suppliers;
  v_balance numeric;
begin
  select * into s from public.suppliers where id = p_supplier;
  if s.id is null or not private.has_role(s.restaurant_id, '{owner,manager,cashier}') then
    raise exception 'No se encontró el proveedor' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Ingresá el monto a pagar' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into v_balance from public.supplier_movements where supplier_id = s.id;
  if p_amount > v_balance + 0.009 then
    raise exception 'El pago supera lo que se le debe (%)', v_balance using errcode = 'P0001';
  end if;
  perform private.pay_supplier(s, p_amount, p_method, p_note, null);
  return v_balance - p_amount;
end;
$$;
revoke all on function public.supplier_payment(uuid, numeric, uuid, text) from public, anon;
grant execute on function public.supplier_payment(uuid, numeric, uuid, text) to authenticated;

-- -------------------------------------------------------------
-- Registrar una compra o gasto
-- p_purchase: { supplier_id, issued_on, due_on?, doc_kind?, doc_number?, category?, notes?, total?,
--               items: [{ ingredient_id?, description?, quantity, line_total }],
--               paid?: { method_id, amount } }
-- Si no se manda total, es la suma de las líneas (puede ser mayor: impuestos, flete).
-- -------------------------------------------------------------
create or replace function public.register_purchase(p_purchase jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.suppliers;
  v_id uuid;
  v_item jsonb;
  v_lines numeric := 0;
  v_total numeric;
  v_ing public.ingredients;
  v_qty numeric;
  v_line numeric;
  v_paid numeric;
  v_label text;
begin
  select * into s from public.suppliers where id = (p_purchase ->> 'supplier_id')::uuid;
  if s.id is null or not private.has_role(s.restaurant_id, '{owner,manager}') then
    raise exception 'Elegí el proveedor' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_purchase -> 'items') <> 'array' or jsonb_array_length(p_purchase -> 'items') = 0 then
    raise exception 'Cargá al menos un renglón' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p_purchase -> 'items') loop
    v_line := coalesce((v_item ->> 'line_total')::numeric, 0);
    if v_line < 0 or coalesce((v_item ->> 'quantity')::numeric, 0) <= 0 then
      raise exception 'Revisá cantidades e importes de los renglones' using errcode = 'P0001';
    end if;
    v_lines := v_lines + v_line;
  end loop;
  v_total := coalesce(nullif(p_purchase ->> 'total', '')::numeric, v_lines);
  if v_total <= 0 then
    raise exception 'El total de la compra tiene que ser mayor a cero' using errcode = 'P0001';
  end if;
  if v_total + 0.009 < v_lines then
    raise exception 'El total no puede ser menor que la suma de los renglones' using errcode = 'P0001';
  end if;

  v_label := 'Compra · ' || s.name || coalesce(' · ' || nullif(p_purchase ->> 'doc_number', ''), '');

  insert into public.purchases (restaurant_id, supplier_id, issued_on, due_on, doc_kind, doc_number, category, total, notes)
  values (
    s.restaurant_id, s.id,
    coalesce((p_purchase ->> 'issued_on')::date, (now() at time zone 'America/Argentina/Buenos_Aires')::date),
    nullif(p_purchase ->> 'due_on', '')::date,
    coalesce(nullif(p_purchase ->> 'doc_kind', ''), 'factura'),
    nullif(trim(coalesce(p_purchase ->> 'doc_number', '')), ''),
    coalesce(nullif(p_purchase ->> 'category', ''), 'mercaderia')::public.expense_category,
    v_total,
    nullif(trim(coalesce(p_purchase ->> 'notes', '')), '')
  )
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_purchase -> 'items') loop
    v_qty := (v_item ->> 'quantity')::numeric;
    v_line := coalesce((v_item ->> 'line_total')::numeric, 0);
    v_ing := null;
    if nullif(v_item ->> 'ingredient_id', '') is not null then
      select * into v_ing from public.ingredients
       where id = (v_item ->> 'ingredient_id')::uuid and restaurant_id = s.restaurant_id;
      if v_ing.id is null then
        raise exception 'Uno de los insumos no existe' using errcode = 'P0001';
      end if;
    end if;
    insert into public.purchase_items (restaurant_id, purchase_id, ingredient_id, description, quantity, line_total)
    values (s.restaurant_id, v_id, v_ing.id, coalesce(nullif(trim(v_item ->> 'description'), ''), v_ing.name, 'Sin descripción'), v_qty, v_line);
    -- El insumo suma stock y toma el costo nuevo (apply_stock_movement)
    if v_ing.id is not null then
      insert into public.stock_movements (restaurant_id, ingredient_id, qty_delta, reason, unit_cost, note)
      values (s.restaurant_id, v_ing.id, v_qty, 'purchase', case when v_line > 0 then round(v_line / v_qty, 4) end, v_label);
    end if;
  end loop;

  insert into public.supplier_movements (restaurant_id, supplier_id, kind, amount, purchase_id, note)
  values (s.restaurant_id, s.id, 'purchase', v_total, v_id, nullif(p_purchase ->> 'doc_number', ''));

  v_paid := nullif(p_purchase #>> '{paid,amount}', '')::numeric;
  if v_paid is not null and v_paid > 0 then
    if v_paid > v_total + 0.009 then
      raise exception 'Lo pagado supera el total de la compra' using errcode = 'P0001';
    end if;
    perform private.pay_supplier(s, v_paid, (p_purchase #>> '{paid,method_id}')::uuid, 'Pago al registrar la compra', v_id);
  end if;

  return v_id;
end;
$$;
revoke all on function public.register_purchase(jsonb) from public, anon;
grant execute on function public.register_purchase(jsonb) to authenticated;

-- -------------------------------------------------------------
-- Anular una compra cargada por error: devuelve el stock y la deuda.
-- Los pagos ya hechos quedan (se ven como saldo a favor con el proveedor).
-- -------------------------------------------------------------
create or replace function public.cancel_purchase(p_purchase uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.purchases;
  it public.purchase_items;
begin
  select * into p from public.purchases where id = p_purchase for update;
  if p.id is null or not private.has_role(p.restaurant_id, '{owner,manager}') then
    raise exception 'No se encontró la compra' using errcode = 'P0001';
  end if;
  if p.cancelled_at is not null then
    raise exception 'La compra ya estaba anulada' using errcode = 'P0001';
  end if;
  for it in select * from public.purchase_items where purchase_id = p.id and ingredient_id is not null loop
    insert into public.stock_movements (restaurant_id, ingredient_id, qty_delta, reason, note)
    values (p.restaurant_id, it.ingredient_id, -it.quantity, 'adjustment', 'Compra anulada' || coalesce(' · ' || p_reason, ''));
  end loop;
  insert into public.supplier_movements (restaurant_id, supplier_id, kind, amount, purchase_id, note)
  values (p.restaurant_id, p.supplier_id, 'reversal', -p.total, p.id, coalesce(nullif(trim(p_reason), ''), 'Compra anulada'));
  update public.purchases set cancelled_at = now() where id = p.id;
end;
$$;
revoke all on function public.cancel_purchase(uuid, text) from public, anon;
grant execute on function public.cancel_purchase(uuid, text) to authenticated;

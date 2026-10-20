-- =============================================================
-- Notas de crédito: anulan una factura autorizada (por el total)
-- Van en la misma tabla `invoices` con tipo 3 (NC A), 8 (NC B) o 13 (NC C) y apuntan a la factura.
-- =============================================================

alter table public.invoices
  add column associated_id  uuid references public.invoices (id) on delete restrict,
  add column credit_note_id uuid references public.invoices (id) on delete set null,
  add column reason         text;

create index invoices_associated_idx on public.invoices (associated_id);
create index invoices_credit_note_idx on public.invoices (credit_note_id);

-- Una factura vigente por comanda: si se anuló con nota de crédito, se puede volver a facturar
drop index public.invoices_one_per_order;
create unique index invoices_one_per_order on public.invoices (order_id)
  where status = 'authorized' and cbte_type in (1, 6, 11) and credit_note_id is null;

-- Una sola nota de crédito por factura
create unique index invoices_one_credit_note on public.invoices (associated_id)
  where status = 'authorized' and associated_id is not null;

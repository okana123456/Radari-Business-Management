-- Radari 0004: security hardening, staff roles and business management modules.
--
-- Run once in the Supabase SQL Editor AFTER 0001, 0002 and 0003.
-- The whole file runs in one transaction: either everything applies or nothing does.
-- Safe to re-run: objects use IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.

begin;

-- ---------------------------------------------------------------------------
-- 1. Role helpers
-- ---------------------------------------------------------------------------

create or replace function public.has_paid_role(target_business_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_paid_access(target_business_id)
    and exists (
      select 1 from public.business_memberships membership
      where membership.business_id = target_business_id
        and membership.user_id = auth.uid()
        and membership.status = 'active'
        and membership.role = any(allowed_roles)
    );
$$;

create or replace function public.business_role(target_business_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select membership.role from public.business_memberships membership
  where membership.business_id = target_business_id
    and membership.user_id = auth.uid()
    and membership.status = 'active'
  limit 1;
$$;

revoke all on function public.has_paid_role(uuid, text[]) from public;
revoke all on function public.business_role(uuid) from public;
grant execute on function public.has_paid_role(uuid, text[]) to authenticated;
grant execute on function public.business_role(uuid) to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Business settings and receipt customisation
-- ---------------------------------------------------------------------------

alter table public.businesses
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists address text,
  add column if not exists kra_pin text,
  add column if not exists receipt_footer text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_settings_length') then
    alter table public.businesses add constraint businesses_settings_length check (
      coalesce(length(phone), 0) <= 30 and coalesce(length(email), 0) <= 120
      and coalesce(length(address), 0) <= 200 and coalesce(length(kra_pin), 0) <= 20
      and coalesce(length(receipt_footer), 0) <= 300
    );
  end if;
end;
$$;

-- Owners previously could update every column, including status. Limit to settings.
drop policy if exists businesses_owner_update on public.businesses;
drop policy if exists businesses_admin_update on public.businesses;
create policy businesses_admin_update on public.businesses for update to authenticated
  using (public.business_role(id) in ('owner', 'admin'))
  with check (public.business_role(id) in ('owner', 'admin'));
revoke insert, update, delete on public.businesses from authenticated;
grant update (name, phone, email, address, kra_pin, receipt_footer, updated_at) on public.businesses to authenticated;

drop trigger if exists businesses_touch on public.businesses;
create trigger businesses_touch before update on public.businesses
  for each row execute function public.touch_updated_at();

-- Memberships change only through the staff functions below.
drop policy if exists memberships_owner_insert on public.business_memberships;
drop policy if exists memberships_owner_update on public.business_memberships;
drop policy if exists memberships_owner_delete on public.business_memberships;
revoke insert, update, delete on public.business_memberships from authenticated;

-- Payment requests are created only by the initiate-subscription-payment function.
drop policy if exists payment_requests_owner_insert on public.payment_requests;
revoke insert on public.payment_requests from authenticated;

-- Callbacks are stored until Safaricom confirms them through the STK Query API.
alter table public.payment_requests
  add column if not exists callback_payload jsonb,
  add column if not exists verification_attempts integer not null default 0;
create index if not exists payment_requests_awaiting_verification_idx
  on public.payment_requests (updated_at) where status = 'submitted';

-- Browsers may read payment status, but not phone numbers, Daraja IDs or raw callbacks.
revoke select on public.payment_requests from authenticated;
grant select (id, business_id, requested_by, amount_kes, status, failure_reason, created_at, updated_at)
  on public.payment_requests to authenticated;
revoke select on public.payments from authenticated;
grant select (id, business_id, payment_request_id, provider, provider_receipt, amount_kes, paid_at, created_at)
  on public.payments to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Products: roles, column privileges, low-stock flag
-- ---------------------------------------------------------------------------

alter table public.products
  add column if not exists is_low_stock boolean generated always as (stock <= reorder_level) stored;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_stock_not_negative') then
    alter table public.products add constraint products_stock_not_negative check (stock >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_text_lengths') then
    alter table public.products add constraint products_text_lengths check (
      length(trim(name)) between 1 and 120 and length(category) <= 60
      and coalesce(length(sku), 0) <= 60 and coalesce(length(barcode), 0) <= 60
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_vat_rate_range') then
    alter table public.products add constraint products_vat_rate_range check (vat_rate between 0 and 100) not valid;
  end if;
end;
$$;

create index if not exists products_business_barcode_idx on public.products (business_id, barcode) where barcode is not null;
create index if not exists products_business_low_idx on public.products (business_id) where is_low_stock and active;
create index if not exists products_business_name_idx on public.products (business_id, name);

drop policy if exists products_paid_select on public.products;
drop policy if exists products_paid_insert on public.products;
drop policy if exists products_paid_update on public.products;
drop policy if exists products_paid_delete on public.products;
drop policy if exists products_stock_insert on public.products;
drop policy if exists products_stock_update on public.products;
drop policy if exists products_admin_delete on public.products;

create policy products_paid_select on public.products for select to authenticated
  using (public.has_paid_access(business_id));
create policy products_stock_insert on public.products for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager']));
create policy products_stock_update on public.products for update to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager']))
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager']));
create policy products_admin_delete on public.products for delete to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin']));

-- Stock can only change through audited functions (sale, void, adjustment, purchase).
revoke insert, update on public.products from authenticated;
grant insert (business_id, name, sku, barcode, category, cost, price, stock, reorder_level, vat_rate, active)
  on public.products to authenticated;
grant update (name, sku, barcode, category, cost, price, reorder_level, vat_rate, active, updated_at)
  on public.products to authenticated;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Stock movement audit trail
-- ---------------------------------------------------------------------------

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  movement_type text not null check (movement_type in ('opening', 'sale', 'void', 'adjustment', 'purchase')),
  reason text,
  quantity numeric(14,3) not null check (quantity <> 0),
  stock_after numeric(14,3) not null,
  unit_cost numeric(14,2),
  reference_id uuid,
  note text check (coalesce(length(note), 0) <= 300),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_business_created_idx on public.stock_movements (business_id, created_at desc);
create index if not exists stock_movements_product_created_idx on public.stock_movements (business_id, product_id, created_at desc);

alter table public.stock_movements enable row level security;
drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager', 'accountant']));
revoke all on public.stock_movements from authenticated;
grant select on public.stock_movements to authenticated;

create or replace function public.record_opening_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stock <> 0 then
    insert into public.stock_movements (business_id, product_id, movement_type, quantity, stock_after, unit_cost, created_by)
    values (new.business_id, new.id, 'opening', new.stock, new.stock, new.cost, auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function public.record_opening_stock() from public;

drop trigger if exists products_opening_stock on public.products;
create trigger products_opening_stock after insert on public.products
  for each row execute function public.record_opening_stock();

-- Backfill opening balances for products created before this migration.
insert into public.stock_movements (business_id, product_id, movement_type, quantity, stock_after, unit_cost, note, created_at)
select product.business_id, product.id, 'opening', product.stock, product.stock, product.cost,
       'Balance when stock tracking started', product.created_at
from public.products product
where product.stock <> 0
  and not exists (select 1 from public.stock_movements movement where movement.product_id = product.id);

-- ---------------------------------------------------------------------------
-- 5. Customers and credit ledger
-- ---------------------------------------------------------------------------

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  phone text check (coalesce(length(phone), 0) <= 30),
  email text check (coalesce(length(email), 0) <= 120),
  notes text check (coalesce(length(notes), 0) <= 500),
  credit_limit numeric(14,2) not null default 0 check (credit_limit >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists customers_business_phone_key on public.customers (business_id, phone) where phone is not null;
create index if not exists customers_business_name_idx on public.customers (business_id, name);

create table if not exists public.customer_ledger (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  entry_type text not null check (entry_type in ('credit_sale', 'payment', 'void')),
  amount numeric(14,2) not null check (amount <> 0), -- positive increases what the customer owes
  sale_id uuid references public.sales(id),
  payment_method text check (payment_method in ('cash', 'mpesa', 'bank', 'other')),
  note text check (coalesce(length(note), 0) <= 300),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists customer_ledger_customer_idx on public.customer_ledger (business_id, customer_id, created_at desc);

alter table public.customers enable row level security;
alter table public.customer_ledger enable row level security;

drop policy if exists customers_select on public.customers;
drop policy if exists customers_insert on public.customers;
drop policy if exists customers_update on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'cashier', 'accountant']));
create policy customers_insert on public.customers for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'cashier', 'accountant']));
create policy customers_update on public.customers for update to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'cashier', 'accountant']))
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'cashier', 'accountant']));
revoke all on public.customers from authenticated;
grant select on public.customers to authenticated;
grant insert (business_id, name, phone, email, notes, credit_limit, active) on public.customers to authenticated;
grant update (name, phone, email, notes, credit_limit, active, updated_at) on public.customers to authenticated;

drop trigger if exists customers_touch on public.customers;
create trigger customers_touch before update on public.customers
  for each row execute function public.touch_updated_at();

drop policy if exists customer_ledger_select on public.customer_ledger;
create policy customer_ledger_select on public.customer_ledger for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'cashier', 'accountant']));
revoke all on public.customer_ledger from authenticated;
grant select on public.customer_ledger to authenticated;

create or replace view public.customer_balances
with (security_invoker = true) as
select customer.id, customer.business_id, customer.name, customer.phone, customer.email, customer.notes,
       customer.credit_limit, customer.active, customer.created_at,
       coalesce(sum(entry.amount), 0)::numeric(14,2) as balance,
       max(entry.created_at) as last_activity_at
from public.customers customer
left join public.customer_ledger entry on entry.customer_id = customer.id
group by customer.id;
revoke all on public.customer_balances from anon;
grant select on public.customer_balances to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Sales: status, customer link, idempotency, receipt counter
-- ---------------------------------------------------------------------------

alter table public.sales
  add column if not exists status text not null default 'completed',
  add column if not exists client_reference uuid,
  add column if not exists customer_id uuid references public.customers(id),
  add column if not exists payment_reference text,
  add column if not exists total_cost numeric(14,2) not null default 0,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id),
  add column if not exists void_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_status_check') then
    alter table public.sales add constraint sales_status_check check (status in ('completed', 'voided'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_payment_reference_length') then
    alter table public.sales add constraint sales_payment_reference_length check (coalesce(length(payment_reference), 0) <= 40);
  end if;
end;
$$;

create unique index if not exists sales_business_client_reference_key on public.sales (business_id, client_reference) where client_reference is not null;
create index if not exists sales_business_status_sold_idx on public.sales (business_id, status, sold_at desc);
create index if not exists sales_business_cashier_sold_idx on public.sales (business_id, cashier_id, sold_at desc);
create index if not exists sales_business_customer_idx on public.sales (business_id, customer_id) where customer_id is not null;
create index if not exists sale_items_business_product_idx on public.sale_items (business_id, product_id);

update public.sales sale
set total_cost = coalesce((
  select sum(round(item.quantity * item.unit_cost, 2)) from public.sale_items item where item.sale_id = sale.id
), 0)
where sale.total_cost = 0;

create table if not exists public.business_counters (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  last_receipt bigint not null default 0
);
alter table public.business_counters enable row level security;
revoke all on public.business_counters from authenticated, anon;

-- Sales and sale items are only written by complete_pos_sale / void_sale.
drop policy if exists sales_paid_insert on public.sales;
drop policy if exists sale_items_paid_insert on public.sale_items;
drop policy if exists sales_paid_select on public.sales;
drop policy if exists sale_items_paid_select on public.sale_items;
revoke insert, update, delete on public.sales from authenticated;
revoke insert, update, delete on public.sale_items from authenticated;

-- Owners, admins and accountants see all sales; cashiers see the sales they made.
create policy sales_paid_select on public.sales for select to authenticated
  using (
    public.has_paid_role(business_id, array['owner', 'admin', 'accountant'])
    or (cashier_id = auth.uid() and public.has_paid_role(business_id, array['cashier']))
  );
create policy sale_items_paid_select on public.sale_items for select to authenticated
  using (
    public.has_paid_access(business_id)
    and exists (select 1 from public.sales sale where sale.id = sale_items.sale_id)
  );

drop function if exists public.complete_pos_sale(uuid, text, jsonb);

create or replace function public.complete_pos_sale(
  target_business_id uuid,
  chosen_payment_method text,
  cart_items jsonb,
  client_reference uuid default null,
  target_customer_id uuid default null,
  payment_reference text default null
)
returns table (sale_id uuid, receipt_number text, total numeric, already_recorded boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_reference uuid := client_reference;
  v_sale_id uuid := gen_random_uuid();
  v_receipt text;
  v_counter bigint;
  v_total numeric := 0;
  v_vat numeric := 0;
  v_cost numeric := 0;
  v_line_total numeric;
  v_balance numeric;
  v_customer public.customers%rowtype;
  v_product public.products%rowtype;
  v_existing record;
  line record;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'cashier']) then
    raise exception 'You do not have permission to record sales, or the subscription is inactive';
  end if;

  -- Idempotency: a retried request returns the sale that was already recorded.
  if v_reference is not null then
    select existing.id, existing.receipt_number, existing.total into v_existing
    from public.sales existing
    where existing.business_id = target_business_id and existing.client_reference = v_reference;
    if found then
      return query select v_existing.id, v_existing.receipt_number, v_existing.total, true;
      return;
    end if;
  end if;

  if chosen_payment_method is null or chosen_payment_method not in ('cash', 'mpesa', 'credit') then
    raise exception 'Invalid payment method';
  end if;
  if cart_items is null or jsonb_typeof(cart_items) <> 'array'
     or jsonb_array_length(cart_items) = 0 then
    raise exception 'The cart is empty';
  end if;
  if jsonb_array_length(cart_items) > 300 then raise exception 'The cart has too many lines'; end if;
  if exists (
    select 1 from jsonb_array_elements(cart_items) element
    where case
      when jsonb_typeof(element) <> 'object' then true
      when coalesce(element->>'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then true
      when jsonb_typeof(element->'quantity') <> 'number' then true
      when (element->>'quantity')::numeric <= 0 or (element->>'quantity')::numeric > 100000 then true
      when (element->>'quantity')::numeric <> round((element->>'quantity')::numeric, 3) then true
      else false
    end
  ) then
    raise exception 'The cart contains an invalid item';
  end if;
  if payment_reference is not null and length(payment_reference) > 40 then
    raise exception 'Payment reference is too long';
  end if;

  if target_customer_id is not null then
    select * into v_customer from public.customers
    where id = target_customer_id and business_id = target_business_id and active
    for update;
    if not found then raise exception 'The selected customer was not found'; end if;
  elsif chosen_payment_method = 'credit' then
    raise exception 'Select a customer for a credit sale';
  end if;

  -- Validate stock against stored values. Duplicate lines are combined and rows are
  -- locked in a fixed order so concurrent checkouts cannot deadlock or oversell.
  for line in
    select (element->>'product_id')::uuid as product_id, sum((element->>'quantity')::numeric) as quantity
    from jsonb_array_elements(cart_items) element
    group by 1 order by 1
  loop
    select * into v_product from public.products
    where id = line.product_id and business_id = target_business_id and active
    for update;
    if not found then raise exception 'A product in the cart is no longer available'; end if;
    if v_product.stock < line.quantity then
      raise exception 'Insufficient stock for %. Available: %', v_product.name, trim(trailing '.' from trim(trailing '0' from v_product.stock::text));
    end if;
    v_line_total := round(v_product.price * line.quantity, 2);
    v_total := v_total + v_line_total;
    v_vat := v_vat + v_line_total * v_product.vat_rate / (100 + v_product.vat_rate);
    v_cost := v_cost + round(v_product.cost * line.quantity, 2);
  end loop;

  if chosen_payment_method = 'credit' and v_customer.credit_limit > 0 then
    select coalesce(sum(entry.amount), 0) into v_balance
    from public.customer_ledger entry where entry.customer_id = v_customer.id;
    if v_balance + v_total > v_customer.credit_limit then
      raise exception 'Credit limit exceeded for %. Owed: KSh %, limit: KSh %', v_customer.name, v_balance, v_customer.credit_limit;
    end if;
  end if;

  insert into public.business_counters as counter (business_id, last_receipt)
  values (target_business_id, 1)
  on conflict (business_id) do update set last_receipt = counter.last_receipt + 1
  returning counter.last_receipt into v_counter;
  v_receipt := 'R' || lpad(v_counter::text, 6, '0');

  begin
    insert into public.sales (
      id, business_id, receipt_number, cashier_id, subtotal, vat_amount, total, total_cost,
      payment_method, customer_id, customer_name, customer_phone, payment_reference, client_reference, status
    ) values (
      v_sale_id, target_business_id, v_receipt, auth.uid(), v_total, round(v_vat, 2), v_total, v_cost,
      chosen_payment_method, v_customer.id, v_customer.name, v_customer.phone,
      nullif(trim(payment_reference), ''), v_reference, 'completed'
    );
  exception when unique_violation then
    -- A concurrent retry with the same client reference finished first.
    select existing.id, existing.receipt_number, existing.total into v_existing
    from public.sales existing
    where existing.business_id = target_business_id and existing.client_reference = v_reference;
    if found then
      return query select v_existing.id, v_existing.receipt_number, v_existing.total, true;
      return;
    end if;
    raise;
  end;

  for line in
    select (element->>'product_id')::uuid as product_id, sum((element->>'quantity')::numeric) as quantity
    from jsonb_array_elements(cart_items) element
    group by 1 order by 1
  loop
    update public.products
    set stock = stock - line.quantity
    where id = line.product_id
    returning * into v_product;

    insert into public.sale_items (business_id, sale_id, product_id, product_name, quantity, unit_price, unit_cost, vat_rate, line_total)
    values (target_business_id, v_sale_id, v_product.id, v_product.name, line.quantity,
            v_product.price, v_product.cost, v_product.vat_rate, round(v_product.price * line.quantity, 2));

    insert into public.stock_movements (business_id, product_id, movement_type, quantity, stock_after, unit_cost, reference_id, created_by)
    values (target_business_id, v_product.id, 'sale', -line.quantity, v_product.stock, v_product.cost, v_sale_id, auth.uid());
  end loop;

  if chosen_payment_method = 'credit' then
    insert into public.customer_ledger (business_id, customer_id, entry_type, amount, sale_id, note, created_by)
    values (target_business_id, v_customer.id, 'credit_sale', v_total, v_sale_id, 'Sale ' || v_receipt, auth.uid());
  end if;

  return query select v_sale_id, v_receipt, v_total, false;
end;
$$;

revoke all on function public.complete_pos_sale(uuid, text, jsonb, uuid, uuid, text) from public;
grant execute on function public.complete_pos_sale(uuid, text, jsonb, uuid, uuid, text) to authenticated;

create or replace function public.void_sale(target_business_id uuid, target_sale_id uuid, void_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_sale public.sales%rowtype;
  v_stock numeric;
  item record;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin']) then
    raise exception 'Only the owner or an admin can void a sale';
  end if;
  if void_reason is null or length(trim(void_reason)) < 3 then
    raise exception 'Give a reason for voiding this sale';
  end if;

  select * into v_sale from public.sales
  where id = target_sale_id and business_id = target_business_id
  for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status <> 'completed' then raise exception 'This sale has already been voided'; end if;

  for item in
    select sale_item.product_id, sum(sale_item.quantity) as quantity, max(sale_item.unit_cost) as unit_cost
    from public.sale_items sale_item
    where sale_item.sale_id = v_sale.id and sale_item.product_id is not null
    group by sale_item.product_id order by sale_item.product_id
  loop
    update public.products set stock = stock + item.quantity
    where id = item.product_id and business_id = target_business_id
    returning stock into v_stock;
    if found then
      insert into public.stock_movements (business_id, product_id, movement_type, quantity, stock_after, unit_cost, reference_id, note, created_by)
      values (target_business_id, item.product_id, 'void', item.quantity, v_stock, item.unit_cost, v_sale.id,
              'Void of ' || v_sale.receipt_number, auth.uid());
    end if;
  end loop;

  update public.sales
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = left(trim(void_reason), 300)
  where id = v_sale.id;

  if v_sale.payment_method = 'credit' and v_sale.customer_id is not null then
    insert into public.customer_ledger (business_id, customer_id, entry_type, amount, sale_id, note, created_by)
    values (target_business_id, v_sale.customer_id, 'void', -v_sale.total, v_sale.id, 'Void of ' || v_sale.receipt_number, auth.uid());
  end if;
end;
$$;
revoke all on function public.void_sale(uuid, uuid, text) from public;
grant execute on function public.void_sale(uuid, uuid, text) to authenticated;

create or replace function public.record_customer_payment(
  target_business_id uuid, target_customer_id uuid, payment_amount numeric, method text, payment_note text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_balance numeric;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'cashier', 'accountant']) then
    raise exception 'You do not have permission to record customer payments';
  end if;
  if payment_amount is null or payment_amount <= 0 or payment_amount <> round(payment_amount, 2) then
    raise exception 'Enter a valid payment amount';
  end if;
  if method is null or method not in ('cash', 'mpesa', 'bank', 'other') then raise exception 'Invalid payment method'; end if;

  perform 1 from public.customers where id = target_customer_id and business_id = target_business_id for update;
  if not found then raise exception 'Customer not found'; end if;

  select coalesce(sum(entry.amount), 0) into v_balance from public.customer_ledger entry where entry.customer_id = target_customer_id;
  if payment_amount > v_balance then
    raise exception 'Payment is more than the KSh % the customer owes', v_balance;
  end if;

  insert into public.customer_ledger (business_id, customer_id, entry_type, amount, payment_method, note, created_by)
  values (target_business_id, target_customer_id, 'payment', -payment_amount, method, left(nullif(trim(payment_note), ''), 300), auth.uid());

  return v_balance - payment_amount;
end;
$$;
revoke all on function public.record_customer_payment(uuid, uuid, numeric, text, text) from public;
grant execute on function public.record_customer_payment(uuid, uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Stock adjustments
-- ---------------------------------------------------------------------------

create or replace function public.adjust_stock(
  target_business_id uuid, target_product_id uuid, quantity_change numeric, adjustment_reason text, adjustment_note text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_product public.products%rowtype;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'stock_manager']) then
    raise exception 'You do not have permission to adjust stock';
  end if;
  if quantity_change is null or quantity_change = 0 or abs(quantity_change) > 1000000
     or quantity_change <> round(quantity_change, 3) then
    raise exception 'Enter a valid quantity change';
  end if;
  if adjustment_reason is null or adjustment_reason not in ('count_correction', 'damaged', 'expired', 'lost', 'returned', 'other') then
    raise exception 'Choose an adjustment reason';
  end if;

  select * into v_product from public.products
  where id = target_product_id and business_id = target_business_id
  for update;
  if not found then raise exception 'Product not found'; end if;
  if v_product.stock + quantity_change < 0 then
    raise exception 'Stock cannot go below zero. Current stock: %', v_product.stock;
  end if;

  update public.products set stock = stock + quantity_change where id = v_product.id returning * into v_product;

  insert into public.stock_movements (business_id, product_id, movement_type, reason, quantity, stock_after, unit_cost, note, created_by)
  values (target_business_id, v_product.id, 'adjustment', adjustment_reason, quantity_change, v_product.stock, v_product.cost,
          left(nullif(trim(adjustment_note), ''), 300), auth.uid());

  return v_product.stock;
end;
$$;
revoke all on function public.adjust_stock(uuid, uuid, numeric, text, text) from public;
grant execute on function public.adjust_stock(uuid, uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Suppliers, purchases and restocking
-- ---------------------------------------------------------------------------

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  contact_person text check (coalesce(length(contact_person), 0) <= 120),
  phone text check (coalesce(length(phone), 0) <= 30),
  email text check (coalesce(length(email), 0) <= 120),
  notes text check (coalesce(length(notes), 0) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists suppliers_business_name_idx on public.suppliers (business_id, name);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  supplier_id uuid references public.suppliers(id),
  reference text check (coalesce(length(reference), 0) <= 60),
  total numeric(14,2) not null check (total >= 0),
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0),
  purchased_on date not null default current_date,
  notes text check (coalesce(length(notes), 0) <= 500),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (amount_paid <= total)
);
create index if not exists purchases_business_date_idx on public.purchases (business_id, purchased_on desc, created_at desc);
create index if not exists purchases_business_supplier_idx on public.purchases (business_id, supplier_id);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  product_id uuid references public.products(id),
  product_name text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  line_total numeric(14,2) not null check (line_total >= 0)
);
create index if not exists purchase_items_purchase_idx on public.purchase_items (business_id, purchase_id);

alter table public.suppliers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;

drop policy if exists suppliers_select on public.suppliers;
drop policy if exists suppliers_insert on public.suppliers;
drop policy if exists suppliers_update on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager', 'accountant']));
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager', 'accountant']));
create policy suppliers_update on public.suppliers for update to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager', 'accountant']))
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager', 'accountant']));
revoke all on public.suppliers from authenticated;
grant select on public.suppliers to authenticated;
grant insert (business_id, name, contact_person, phone, email, notes, active) on public.suppliers to authenticated;
grant update (name, contact_person, phone, email, notes, active, updated_at) on public.suppliers to authenticated;

drop trigger if exists suppliers_touch on public.suppliers;
create trigger suppliers_touch before update on public.suppliers
  for each row execute function public.touch_updated_at();

drop policy if exists purchases_select on public.purchases;
drop policy if exists purchase_items_select on public.purchase_items;
create policy purchases_select on public.purchases for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager', 'accountant']));
create policy purchase_items_select on public.purchase_items for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager', 'accountant']));
revoke all on public.purchases from authenticated;
revoke all on public.purchase_items from authenticated;
grant select on public.purchases to authenticated;
grant select on public.purchase_items to authenticated;

create or replace function public.record_purchase(
  target_business_id uuid,
  target_supplier_id uuid,
  items jsonb,
  purchase_reference text default null,
  paid_amount numeric default 0,
  purchase_date date default current_date,
  purchase_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_purchase_id uuid := gen_random_uuid();
  v_total numeric := 0;
  v_product public.products%rowtype;
  v_new_cost numeric;
  line record;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'stock_manager']) then
    raise exception 'You do not have permission to record purchases';
  end if;
  if target_supplier_id is not null and not exists (
    select 1 from public.suppliers where id = target_supplier_id and business_id = target_business_id
  ) then
    raise exception 'Supplier not found';
  end if;
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'Add at least one item';
  end if;
  if jsonb_array_length(items) > 300 then raise exception 'Too many items'; end if;
  if exists (
    select 1 from jsonb_array_elements(items) element
    where case
      when jsonb_typeof(element) <> 'object' then true
      when coalesce(element->>'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then true
      when jsonb_typeof(element->'quantity') <> 'number' or jsonb_typeof(element->'unit_cost') <> 'number' then true
      when (element->>'quantity')::numeric <= 0 or (element->>'quantity')::numeric > 1000000 then true
      when (element->>'quantity')::numeric <> round((element->>'quantity')::numeric, 3) then true
      when (element->>'unit_cost')::numeric < 0 or (element->>'unit_cost')::numeric > 100000000 then true
      when (element->>'unit_cost')::numeric <> round((element->>'unit_cost')::numeric, 2) then true
      else false
    end
  ) then
    raise exception 'A purchase item is invalid';
  end if;
  if purchase_date is null or purchase_date > current_date + 1 then raise exception 'Invalid purchase date'; end if;

  select coalesce(sum(round((element->>'quantity')::numeric * (element->>'unit_cost')::numeric, 2)), 0) into v_total
  from jsonb_array_elements(items) element;

  if paid_amount is null or paid_amount < 0 or paid_amount > v_total or paid_amount <> round(paid_amount, 2) then
    raise exception 'Amount paid must be between 0 and the purchase total';
  end if;

  insert into public.purchases (id, business_id, supplier_id, reference, total, amount_paid, purchased_on, notes, created_by)
  values (v_purchase_id, target_business_id, target_supplier_id, left(nullif(trim(purchase_reference), ''), 60),
          v_total, paid_amount, purchase_date, left(nullif(trim(purchase_notes), ''), 500), auth.uid());

  for line in
    select (entry.value->>'product_id')::uuid as product_id,
           (entry.value->>'quantity')::numeric as quantity,
           (entry.value->>'unit_cost')::numeric as unit_cost,
           entry.position
    from jsonb_array_elements(items) with ordinality as entry(value, position)
    order by 1, entry.position
  loop
    select * into v_product from public.products
    where id = line.product_id and business_id = target_business_id
    for update;
    if not found then raise exception 'A product in this purchase was not found'; end if;

    -- Weighted average cost keeps profit reports accurate when buying prices change.
    v_new_cost := case
      when v_product.stock > 0 then round((v_product.stock * v_product.cost + line.quantity * line.unit_cost) / (v_product.stock + line.quantity), 2)
      else line.unit_cost
    end;

    update public.products
    set stock = stock + line.quantity, cost = v_new_cost
    where id = v_product.id
    returning * into v_product;

    insert into public.purchase_items (business_id, purchase_id, product_id, product_name, quantity, unit_cost, line_total)
    values (target_business_id, v_purchase_id, v_product.id, v_product.name, line.quantity, line.unit_cost,
            round(line.quantity * line.unit_cost, 2));

    insert into public.stock_movements (business_id, product_id, movement_type, quantity, stock_after, unit_cost, reference_id, created_by)
    values (target_business_id, v_product.id, 'purchase', line.quantity, v_product.stock, line.unit_cost, v_purchase_id, auth.uid());
  end loop;

  return v_purchase_id;
end;
$$;
revoke all on function public.record_purchase(uuid, uuid, jsonb, text, numeric, date, text) from public;
grant execute on function public.record_purchase(uuid, uuid, jsonb, text, numeric, date, text) to authenticated;

create or replace function public.record_purchase_payment(target_business_id uuid, target_purchase_id uuid, payment_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_purchase public.purchases%rowtype;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'accountant']) then
    raise exception 'You do not have permission to record supplier payments';
  end if;
  select * into v_purchase from public.purchases
  where id = target_purchase_id and business_id = target_business_id for update;
  if not found then raise exception 'Purchase not found'; end if;
  if payment_amount is null or payment_amount <= 0 or payment_amount <> round(payment_amount, 2)
     or v_purchase.amount_paid + payment_amount > v_purchase.total then
    raise exception 'Payment must be more than zero and no more than the balance of KSh %', v_purchase.total - v_purchase.amount_paid;
  end if;
  update public.purchases set amount_paid = amount_paid + payment_amount where id = v_purchase.id
  returning * into v_purchase;
  return v_purchase.total - v_purchase.amount_paid;
end;
$$;
revoke all on function public.record_purchase_payment(uuid, uuid, numeric) from public;
grant execute on function public.record_purchase_payment(uuid, uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Expenses
-- ---------------------------------------------------------------------------

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  category text not null check (length(trim(category)) between 1 and 60),
  description text check (coalesce(length(description), 0) <= 300),
  amount numeric(14,2) not null check (amount > 0),
  payment_method text not null default 'cash' check (payment_method in ('cash', 'mpesa', 'bank', 'other')),
  expense_date date not null default current_date,
  reference text check (coalesce(length(reference), 0) <= 60),
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expenses_business_date_idx on public.expenses (business_id, expense_date desc);

alter table public.expenses enable row level security;
drop policy if exists expenses_select on public.expenses;
drop policy if exists expenses_insert on public.expenses;
drop policy if exists expenses_update on public.expenses;
drop policy if exists expenses_delete on public.expenses;
create policy expenses_select on public.expenses for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']) and created_by = auth.uid());
create policy expenses_update on public.expenses for update to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']))
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy expenses_delete on public.expenses for delete to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin']));
revoke all on public.expenses from authenticated;
grant select, delete on public.expenses to authenticated;
grant insert (business_id, category, description, amount, payment_method, expense_date, reference, created_by) on public.expenses to authenticated;
grant update (category, description, amount, payment_method, expense_date, reference, updated_at) on public.expenses to authenticated;

drop trigger if exists expenses_touch on public.expenses;
create trigger expenses_touch before update on public.expenses
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 10. Staff invitations and roles
-- ---------------------------------------------------------------------------

create table if not exists public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('admin', 'stock_manager', 'cashier', 'accountant')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz not null default now() + interval '14 days'
);
create unique index if not exists staff_invitations_pending_key on public.staff_invitations (business_id, email) where status = 'pending';
create index if not exists staff_invitations_email_idx on public.staff_invitations (email) where status = 'pending';

alter table public.staff_invitations enable row level security;
drop policy if exists staff_invitations_select on public.staff_invitations;
create policy staff_invitations_select on public.staff_invitations for select to authenticated
  using (public.business_role(business_id) in ('owner', 'admin'));
revoke all on public.staff_invitations from authenticated;
grant select on public.staff_invitations to authenticated;

create or replace function public.invite_staff(target_business_id uuid, staff_email text, staff_role text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_inviter_role text := public.business_role(target_business_id);
  v_email text := lower(trim(staff_email));
  v_id uuid;
begin
  if v_inviter_role is null or v_inviter_role not in ('owner', 'admin') or not public.has_paid_access(target_business_id) then
    raise exception 'Only the owner or an admin can invite staff';
  end if;
  if staff_role is null or staff_role not in ('admin', 'stock_manager', 'cashier', 'accountant') then
    raise exception 'Choose a valid role';
  end if;
  if v_inviter_role = 'admin' and staff_role = 'admin' then
    raise exception 'Only the owner can invite another admin';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if exists (
    select 1 from public.business_memberships membership join auth.users account on account.id = membership.user_id
    where membership.business_id = target_business_id and lower(account.email) = v_email
  ) then
    raise exception 'This person is already a member of the business';
  end if;

  update public.staff_invitations set status = 'revoked'
  where business_id = target_business_id and email = v_email and status = 'pending';

  insert into public.staff_invitations (business_id, email, role, invited_by)
  values (target_business_id, v_email, staff_role, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.invite_staff(uuid, text, text) from public;
grant execute on function public.invite_staff(uuid, text, text) to authenticated;

create or replace function public.revoke_staff_invitation(target_business_id uuid, invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.business_role(target_business_id) not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can manage invitations';
  end if;
  update public.staff_invitations set status = 'revoked'
  where id = invitation_id and business_id = target_business_id and status = 'pending';
end;
$$;
revoke all on function public.revoke_staff_invitation(uuid, uuid) from public;
grant execute on function public.revoke_staff_invitation(uuid, uuid) to authenticated;

-- Called after sign-in. Joins every business that invited this confirmed email address.
create or replace function public.accept_pending_invitations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_name text;
  v_count integer := 0;
  invitation record;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select lower(account.email), coalesce(nullif(trim(account.raw_user_meta_data->>'full_name'), ''), split_part(account.email, '@', 1))
  into v_email, v_name
  from auth.users account
  where account.id = auth.uid() and account.email_confirmed_at is not null;
  if v_email is null then return 0; end if;

  for invitation in
    select * from public.staff_invitations
    where email = v_email and status = 'pending' and expires_at > now()
    for update
  loop
    insert into public.business_memberships (business_id, user_id, role, status)
    values (invitation.business_id, auth.uid(), invitation.role, 'active')
    on conflict (business_id, user_id) do nothing;
    update public.staff_invitations set status = 'accepted', accepted_at = now() where id = invitation.id;
    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    insert into public.profiles (user_id, full_name) values (auth.uid(), v_name)
    on conflict (user_id) do nothing;
  end if;
  return v_count;
end;
$$;
revoke all on function public.accept_pending_invitations() from public;
grant execute on function public.accept_pending_invitations() to authenticated;

create or replace function public.update_staff_member(target_business_id uuid, target_user_id uuid, new_role text, new_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_actor_role text := public.business_role(target_business_id);
  v_target public.business_memberships%rowtype;
begin
  if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can manage staff';
  end if;
  if target_user_id = auth.uid() then raise exception 'You cannot change your own access'; end if;
  if new_role is null or new_role not in ('admin', 'stock_manager', 'cashier', 'accountant') then raise exception 'Choose a valid role'; end if;
  if new_status is null or new_status not in ('active', 'disabled') then raise exception 'Choose a valid status'; end if;

  select * into v_target from public.business_memberships
  where business_id = target_business_id and user_id = target_user_id for update;
  if not found then raise exception 'Staff member not found'; end if;
  if v_target.role = 'owner' then raise exception 'The owner cannot be changed'; end if;
  if v_actor_role = 'admin' and (v_target.role = 'admin' or new_role = 'admin') then
    raise exception 'Only the owner can change admins';
  end if;

  update public.business_memberships set role = new_role, status = new_status
  where id = v_target.id;
end;
$$;
revoke all on function public.update_staff_member(uuid, uuid, text, text) from public;
grant execute on function public.update_staff_member(uuid, uuid, text, text) to authenticated;

-- Names are visible to colleagues (for cashier names on sales); emails only to owner/admin.
create or replace function public.list_business_staff(target_business_id uuid)
returns table (user_id uuid, full_name text, email text, role text, status text, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_role text := public.business_role(target_business_id);
begin
  if v_role is null then raise exception 'Not a member of this business'; end if;
  return query
  select membership.user_id,
         coalesce(profile.full_name, split_part(account.email, '@', 1))::text,
         (case when v_role in ('owner', 'admin') then account.email else null end)::text,
         membership.role, membership.status, membership.created_at
  from public.business_memberships membership
  join auth.users account on account.id = membership.user_id
  left join public.profiles profile on profile.user_id = membership.user_id
  where membership.business_id = target_business_id
  order by case membership.role when 'owner' then 0 when 'admin' then 1 else 2 end, membership.created_at;
end;
$$;
revoke all on function public.list_business_staff(uuid) from public;
grant execute on function public.list_business_staff(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Reports (computed in the database so the browser downloads summaries only)
-- ---------------------------------------------------------------------------

create or replace function public.business_report(target_business_id uuid, period_start timestamptz, period_end timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_tz text;
  v_result jsonb;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'accountant']) then
    raise exception 'You do not have permission to view reports';
  end if;
  if period_start is null or period_end is null or period_end <= period_start then
    raise exception 'Invalid report period';
  end if;
  if period_end - period_start > interval '400 days' then raise exception 'Choose a period of 400 days or less'; end if;

  select coalesce(timezone, 'Africa/Nairobi') into v_tz from public.businesses where id = target_business_id;

  with period_sales as (
    select * from public.sales
    where business_id = target_business_id and sold_at >= period_start and sold_at < period_end
  ),
  completed as (select * from period_sales where status = 'completed'),
  period_expenses as (
    select * from public.expenses
    where business_id = target_business_id
      and expense_date >= (period_start at time zone v_tz)::date
      and expense_date < ((period_end at time zone v_tz) - interval '1 microsecond')::date + 1
  ),
  totals as (
    select coalesce(sum(total), 0) as revenue,
           coalesce(sum(vat_amount), 0) as vat,
           coalesce(sum(total_cost), 0) as cost_of_sales,
           count(*) as transactions
    from completed
  ),
  expense_total as (select coalesce(sum(amount), 0) as amount from period_expenses)
  select jsonb_build_object(
    'revenue', totals.revenue,
    'vat', totals.vat,
    'net_sales', totals.revenue - totals.vat,
    'cost_of_sales', totals.cost_of_sales,
    'gross_profit', totals.revenue - totals.vat - totals.cost_of_sales,
    'expenses', expense_total.amount,
    'net_profit', totals.revenue - totals.vat - totals.cost_of_sales - expense_total.amount,
    'transactions', totals.transactions,
    'average_sale', case when totals.transactions > 0 then round(totals.revenue / totals.transactions, 2) else 0 end,
    'voided_count', (select count(*) from period_sales where status = 'voided'),
    'voided_total', (select coalesce(sum(total), 0) from period_sales where status = 'voided'),
    'credit_sales', (select coalesce(sum(total), 0) from completed where payment_method = 'credit'),
    'payment_methods', coalesce((
      select jsonb_agg(jsonb_build_object('method', payment_method, 'count', count, 'total', amount) order by amount desc)
      from (select payment_method, count(*) as count, sum(total) as amount from completed group by payment_method) methods
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'revenue', revenue, 'transactions', transactions, 'gross_profit', gross_profit) order by day)
      from (
        select (sold_at at time zone v_tz)::date as day, sum(total) as revenue, count(*) as transactions,
               sum(total - vat_amount - total_cost) as gross_profit
        from completed group by 1
      ) days
    ), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name, 'quantity', quantity, 'revenue', revenue, 'gross_profit', gross_profit) order by revenue desc)
      from (
        select item.product_id, max(item.product_name) as name, sum(item.quantity) as quantity, sum(item.line_total) as revenue,
               sum(item.line_total - item.line_total * item.vat_rate / (100 + item.vat_rate) - round(item.quantity * item.unit_cost, 2)) as gross_profit
        from public.sale_items item join completed sale on sale.id = item.sale_id
        where item.business_id = target_business_id
        group by item.product_id
        order by revenue desc
        limit 10
      ) top
    ), '[]'::jsonb),
    'expense_categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'total', amount, 'count', count) order by amount desc)
      from (select category, sum(amount) as amount, count(*) as count from period_expenses group by category) categories
    ), '[]'::jsonb),
    'purchases', (
      select coalesce(sum(total), 0) from public.purchases
      where business_id = target_business_id
        and purchased_on >= (period_start at time zone v_tz)::date
        and purchased_on < ((period_end at time zone v_tz) - interval '1 microsecond')::date + 1
    ),
    'stock_value', (select coalesce(sum(stock * cost), 0) from public.products where business_id = target_business_id and active),
    'stock_retail_value', (select coalesce(sum(stock * price), 0) from public.products where business_id = target_business_id and active),
    'low_stock_count', (select count(*) from public.products where business_id = target_business_id and active and is_low_stock),
    'outstanding_credit', (select coalesce(sum(amount), 0) from public.customer_ledger where business_id = target_business_id),
    'supplier_balance', (select coalesce(sum(total - amount_paid), 0) from public.purchases where business_id = target_business_id)
  ) into v_result
  from totals, expense_total;

  return v_result;
end;
$$;
revoke all on function public.business_report(uuid, timestamptz, timestamptz) from public;
grant execute on function public.business_report(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Realtime: stock changes made by other tills
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products'
    ) then
    alter publication supabase_realtime add table public.products;
  end if;
end;
$$;

commit;

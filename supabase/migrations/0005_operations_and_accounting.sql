-- Radari 0005: split and card payments, discounts with a price floor, loyalty points,
-- credit due dates, creditors, product categories, units and servings, batches and
-- expiry, tax categories, purchases with batches, chart of accounts and journal,
-- business settings for M-Pesa details and branding, and extended reports.
--
-- Run once in the Supabase SQL Editor AFTER 0004. Runs in one transaction; safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Business settings
-- ---------------------------------------------------------------------------

alter table public.businesses
  add column if not exists business_type text not null default 'retail',
  add column if not exists mpesa_paybill text,
  add column if not exists mpesa_account text,
  add column if not exists mpesa_till text,
  add column if not exists mpesa_pochi text,
  add column if not exists mpesa_send_money text,
  add column if not exists logo_data text,
  add column if not exists theme_color text,
  add column if not exists default_vat_rate numeric(5,2) not null default 16,
  add column if not exists min_price_percent numeric(5,2) not null default 0,
  add column if not exists day_start_hour integer not null default 0,
  add column if not exists loyalty_enabled boolean not null default false,
  add column if not exists loyalty_spend_per_point numeric(14,2) not null default 100,
  add column if not exists loyalty_point_value numeric(14,2) not null default 1,
  add column if not exists glovo_store_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_operations_settings') then
    alter table public.businesses add constraint businesses_operations_settings check (
      business_type in ('retail', 'pharmacy', 'hardware', 'agrovet', 'electronics', 'restaurant', 'bar', 'salon', 'wholesale', 'general')
      and coalesce(length(mpesa_paybill), 0) <= 20 and coalesce(length(mpesa_account), 0) <= 40
      and coalesce(length(mpesa_till), 0) <= 20 and coalesce(length(mpesa_pochi), 0) <= 20
      and coalesce(length(mpesa_send_money), 0) <= 20 and coalesce(length(glovo_store_id), 0) <= 60
      and (logo_data is null or (logo_data like 'data:image/%' and length(logo_data) <= 200000))
      and (theme_color is null or theme_color ~ '^#[0-9a-fA-F]{6}$')
      and default_vat_rate between 0 and 100
      and min_price_percent between 0 and 100
      and day_start_hour between 0 and 9
      and loyalty_spend_per_point > 0 and loyalty_point_value >= 0
    );
  end if;
end;
$$;

grant update (business_type, mpesa_paybill, mpesa_account, mpesa_till, mpesa_pochi, mpesa_send_money, logo_data,
  theme_color, default_vat_rate, min_price_percent, day_start_hour, loyalty_enabled, loyalty_spend_per_point,
  loyalty_point_value, glovo_store_id) on public.businesses to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Products: units, servings, batches, expiry, tax category, price floor
-- ---------------------------------------------------------------------------

alter table public.products
  add column if not exists unit text not null default 'Piece',
  add column if not exists tax_category text not null default 'standard',
  add column if not exists min_price_percent numeric(5,2),
  add column if not exists batch_number text,
  add column if not exists expiry_date date,
  add column if not exists container_ml numeric(10,2),
  add column if not exists serving_ml numeric(10,2),
  add column if not exists serving_price numeric(14,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_operations_fields') then
    -- Products created before 0005 get a tax category from their VAT rate.
    update public.products set tax_category = case when vat_rate = 0 then 'exempt' when vat_rate = 8 then 'reduced' else 'standard' end
    where tax_category = 'standard' and vat_rate <> 16;
    alter table public.products add constraint products_operations_fields check (
      tax_category in ('standard', 'reduced', 'zero_rated', 'exempt')
      and length(unit) between 1 and 40
      and (min_price_percent is null or min_price_percent between 0 and 100)
      and coalesce(length(batch_number), 0) <= 60
      and (container_ml is null or container_ml > 0)
      and (serving_ml is null or serving_ml > 0)
      and (serving_price is null or serving_price >= 0)
    ) not valid;
  end if;
end;
$$;

create index if not exists products_business_expiry_idx on public.products (business_id, expiry_date) where expiry_date is not null and active;

grant insert (unit, tax_category, min_price_percent, batch_number, expiry_date, container_ml, serving_ml, serving_price)
  on public.products to authenticated;
grant update (unit, tax_category, min_price_percent, batch_number, expiry_date, container_ml, serving_ml, serving_price)
  on public.products to authenticated;

create or replace function public.bulk_set_tax_category(target_business_id uuid, new_category text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate numeric;
  v_count integer;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin']) then
    raise exception 'Only the owner or an admin can change VAT for all products';
  end if;
  v_rate := case new_category when 'standard' then 16 when 'reduced' then 8 when 'zero_rated' then 0 when 'exempt' then 0 end;
  if v_rate is null then raise exception 'Choose a valid tax category'; end if;
  update public.products set tax_category = new_category, vat_rate = v_rate where business_id = target_business_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.bulk_set_tax_category(uuid, text) from public;
grant execute on function public.bulk_set_tax_category(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Product categories
-- ---------------------------------------------------------------------------

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);
create unique index if not exists product_categories_business_name_key on public.product_categories (business_id, lower(name));

insert into public.product_categories (business_id, name)
select distinct on (product.business_id, lower(product.category)) product.business_id, product.category
from public.products product
where not exists (
  select 1 from public.product_categories existing
  where existing.business_id = product.business_id and lower(existing.name) = lower(product.category)
);

alter table public.product_categories enable row level security;
drop policy if exists product_categories_select on public.product_categories;
drop policy if exists product_categories_insert on public.product_categories;
create policy product_categories_select on public.product_categories for select to authenticated
  using (public.has_paid_access(business_id));
create policy product_categories_insert on public.product_categories for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'stock_manager']));
revoke all on public.product_categories from authenticated;
grant select on public.product_categories to authenticated;
grant insert (business_id, name) on public.product_categories to authenticated;

create or replace function public.rename_category(target_business_id uuid, old_name text, new_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new text := trim(new_name);
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'stock_manager']) then
    raise exception 'You do not have permission to manage categories';
  end if;
  if v_new is null or length(v_new) not between 1 and 60 then raise exception 'Category names must be 1 to 60 characters'; end if;
  if lower(v_new) <> lower(old_name) and exists (
    select 1 from public.product_categories where business_id = target_business_id and lower(name) = lower(v_new)
  ) then
    delete from public.product_categories where business_id = target_business_id and lower(name) = lower(old_name);
  else
    update public.product_categories set name = v_new where business_id = target_business_id and lower(name) = lower(old_name);
    if not found then insert into public.product_categories (business_id, name) values (target_business_id, v_new); end if;
  end if;
  update public.products set category = v_new where business_id = target_business_id and lower(category) = lower(old_name);
end;
$$;
revoke all on function public.rename_category(uuid, text, text) from public;
grant execute on function public.rename_category(uuid, text, text) to authenticated;

create or replace function public.delete_category(target_business_id uuid, category_name text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_moved integer;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'stock_manager']) then
    raise exception 'You do not have permission to manage categories';
  end if;
  if lower(category_name) = 'general' then raise exception 'The General category cannot be deleted'; end if;
  update public.products set category = 'General' where business_id = target_business_id and lower(category) = lower(category_name);
  get diagnostics v_moved = row_count;
  delete from public.product_categories where business_id = target_business_id and lower(name) = lower(category_name);
  if v_moved > 0 then
    insert into public.product_categories (business_id, name) values (target_business_id, 'General')
    on conflict do nothing;
  end if;
  return v_moved;
end;
$$;
revoke all on function public.delete_category(uuid, text) from public;
grant execute on function public.delete_category(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Sales: card and split payments, discounts, loyalty, credit due dates
-- ---------------------------------------------------------------------------

alter table public.sales
  add column if not exists discount_total numeric(14,2) not null default 0,
  add column if not exists loyalty_points_redeemed integer not null default 0,
  add column if not exists loyalty_discount numeric(14,2) not null default 0,
  add column if not exists credit_due_date date;

alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
  check (payment_method in ('cash', 'mpesa', 'card', 'credit', 'split'));

alter table public.sale_items
  add column if not exists list_price numeric(14,2),
  add column if not exists sold_as text not null default 'unit',
  add column if not exists stock_quantity numeric(14,3),
  add column if not exists tax_category text;

create table if not exists public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  method text not null check (method in ('cash', 'mpesa', 'card', 'credit')),
  amount numeric(14,2) not null check (amount > 0),
  reference text check (coalesce(length(reference), 0) <= 40),
  created_at timestamptz not null default now()
);
create index if not exists sale_payments_business_sale_idx on public.sale_payments (business_id, sale_id);

-- One payment row for every sale recorded before 0005.
insert into public.sale_payments (business_id, sale_id, method, amount, reference, created_at)
select sale.business_id, sale.id, sale.payment_method, sale.total, sale.payment_reference, sale.sold_at
from public.sales sale
where sale.payment_method in ('cash', 'mpesa', 'card', 'credit') and sale.total > 0
  and not exists (select 1 from public.sale_payments existing where existing.sale_id = sale.id);

alter table public.sale_payments enable row level security;
drop policy if exists sale_payments_select on public.sale_payments;
create policy sale_payments_select on public.sale_payments for select to authenticated
  using (public.has_paid_access(business_id) and exists (select 1 from public.sales sale where sale.id = sale_payments.sale_id));
revoke all on public.sale_payments from authenticated;
grant select on public.sale_payments to authenticated;

-- Loyalty points ledger (positive = earned, negative = redeemed or reversed).
create table if not exists public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  points integer not null check (points <> 0),
  entry_type text not null check (entry_type in ('earned', 'redeemed', 'reversed', 'adjusted')),
  sale_id uuid references public.sales(id),
  note text check (coalesce(length(note), 0) <= 300),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists loyalty_ledger_customer_idx on public.loyalty_ledger (business_id, customer_id, created_at desc);

alter table public.loyalty_ledger enable row level security;
drop policy if exists loyalty_ledger_select on public.loyalty_ledger;
create policy loyalty_ledger_select on public.loyalty_ledger for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'cashier', 'accountant']));
revoke all on public.loyalty_ledger from authenticated;
grant select on public.loyalty_ledger to authenticated;

create or replace view public.customer_balances
with (security_invoker = true) as
select customer.id, customer.business_id, customer.name, customer.phone, customer.email, customer.notes,
       customer.credit_limit, customer.active, customer.created_at,
       coalesce((select sum(entry.amount) from public.customer_ledger entry where entry.customer_id = customer.id), 0)::numeric(14,2) as balance,
       (select max(entry.created_at) from public.customer_ledger entry where entry.customer_id = customer.id) as last_activity_at,
       coalesce((select sum(points.points) from public.loyalty_ledger points where points.customer_id = customer.id), 0)::integer as loyalty_points
from public.customers customer;
grant select on public.customer_balances to authenticated;

create or replace function public.adjust_loyalty_points(target_business_id uuid, target_customer_id uuid, points_change integer, adjustment_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin']) then
    raise exception 'Only the owner or an admin can adjust loyalty points';
  end if;
  if points_change is null or points_change = 0 or abs(points_change) > 1000000 then raise exception 'Enter a valid number of points'; end if;
  perform 1 from public.customers where id = target_customer_id and business_id = target_business_id for update;
  if not found then raise exception 'Customer not found'; end if;
  select coalesce(sum(points), 0) into v_balance from public.loyalty_ledger where customer_id = target_customer_id;
  if v_balance + points_change < 0 then raise exception 'The customer only has % points', v_balance; end if;
  insert into public.loyalty_ledger (business_id, customer_id, points, entry_type, note, created_by)
  values (target_business_id, target_customer_id, points_change, 'adjusted', left(nullif(trim(adjustment_note), ''), 300), auth.uid());
  return v_balance + points_change;
end;
$$;
revoke all on function public.adjust_loyalty_points(uuid, uuid, integer, text) from public;
grant execute on function public.adjust_loyalty_points(uuid, uuid, integer, text) to authenticated;

drop function if exists public.complete_pos_sale(uuid, text, jsonb, uuid, uuid, text);

create or replace function public.complete_pos_sale(
  target_business_id uuid,
  chosen_payment_method text,
  cart_items jsonb,
  client_reference uuid default null,
  target_customer_id uuid default null,
  payment_reference text default null,
  payment_lines jsonb default null,
  credit_due_date date default null,
  redeem_points integer default 0
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
  v_business public.businesses%rowtype;
  v_customer public.customers%rowtype;
  v_product public.products%rowtype;
  v_existing record;
  v_receipt text;
  v_counter bigint;
  v_lines jsonb := '[]'::jsonb;
  v_payments jsonb;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_vat numeric := 0;
  v_cost numeric := 0;
  v_total numeric;
  v_loyalty_discount numeric := 0;
  v_points_balance integer;
  v_points_earned integer;
  v_credit numeric := 0;
  v_paid numeric := 0;
  v_balance numeric;
  v_method text;
  v_methods integer;
  v_base numeric;
  v_unit_price numeric;
  v_floor numeric;
  v_stock_qty numeric;
  v_line_total numeric;
  line record;
  entry jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'cashier']) then
    raise exception 'You do not have permission to record sales, or the subscription is inactive';
  end if;

  if v_reference is not null then
    select existing.id, existing.receipt_number, existing.total into v_existing
    from public.sales existing
    where existing.business_id = target_business_id and existing.client_reference = v_reference;
    if found then
      return query select v_existing.id, v_existing.receipt_number, v_existing.total, true;
      return;
    end if;
  end if;

  select * into v_business from public.businesses where id = target_business_id;

  if cart_items is null or jsonb_typeof(cart_items) <> 'array' or jsonb_array_length(cart_items) = 0 then
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
      when coalesce(element->>'mode', 'unit') not in ('unit', 'serving') then true
      when element ? 'unit_price' and jsonb_typeof(element->'unit_price') not in ('number', 'null') then true
      when jsonb_typeof(element->'unit_price') = 'number' and ((element->>'unit_price')::numeric < 0
        or (element->>'unit_price')::numeric <> round((element->>'unit_price')::numeric, 2)) then true
      else false
    end
  ) then
    raise exception 'The cart contains an invalid item';
  end if;
  if payment_reference is not null and length(payment_reference) > 40 then raise exception 'Payment reference is too long'; end if;
  if redeem_points is null or redeem_points < 0 then raise exception 'Invalid loyalty points'; end if;

  if target_customer_id is not null then
    select * into v_customer from public.customers
    where id = target_customer_id and business_id = target_business_id and active
    for update;
    if not found then raise exception 'The selected customer was not found'; end if;
  end if;

  -- Lock every product once, in a fixed order, and check total stock across all lines.
  for line in
    select (element->>'product_id')::uuid as product_id from jsonb_array_elements(cart_items) element group by 1 order by 1
  loop
    select * into v_product from public.products
    where id = line.product_id and business_id = target_business_id and active
    for update;
    if not found then raise exception 'A product in the cart is no longer available'; end if;
  end loop;

  for line in
    select (element->>'product_id')::uuid as product_id,
           coalesce(element->>'mode', 'unit') as mode,
           (element->>'quantity')::numeric as quantity,
           case when jsonb_typeof(element->'unit_price') = 'number' then (element->>'unit_price')::numeric end as unit_price
    from jsonb_array_elements(cart_items) element
  loop
    select * into v_product from public.products where id = line.product_id;
    if line.mode = 'serving' then
      if coalesce(v_product.serving_ml, 0) <= 0 or coalesce(v_product.container_ml, 0) <= 0 or v_product.serving_price is null then
        raise exception '% is not set up to sell by serving', v_product.name;
      end if;
      v_base := v_product.serving_price;
      v_stock_qty := round(line.quantity * v_product.serving_ml / v_product.container_ml, 3);
    else
      v_base := v_product.price;
      v_stock_qty := line.quantity;
    end if;
    v_unit_price := coalesce(line.unit_price, v_base);
    if v_unit_price > v_base then raise exception 'The price of % cannot be raised at the till', v_product.name; end if;
    v_floor := round(v_base * coalesce(v_product.min_price_percent, v_business.min_price_percent, 0) / 100, 2);
    if v_unit_price < v_floor then
      raise exception '% cannot be sold below KSh %', v_product.name, v_floor;
    end if;
    v_line_total := round(v_unit_price * line.quantity, 2);
    v_subtotal := v_subtotal + v_line_total;
    v_discount := v_discount + round((v_base - v_unit_price) * line.quantity, 2);
    v_vat := v_vat + v_line_total * v_product.vat_rate / (100 + v_product.vat_rate);
    v_cost := v_cost + round(v_product.cost * v_stock_qty, 2);
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'mode', line.mode, 'quantity', line.quantity,
      'unit_price', v_unit_price, 'list_price', v_base, 'stock_quantity', v_stock_qty, 'line_total', v_line_total,
      'unit_cost', case when line.mode = 'serving' then round(v_product.cost * v_product.serving_ml / v_product.container_ml, 2) else v_product.cost end,
      'vat_rate', v_product.vat_rate, 'tax_category', v_product.tax_category);
  end loop;

  for line in
    select (value->>'product_id')::uuid as product_id, sum((value->>'stock_quantity')::numeric) as needed
    from jsonb_array_elements(v_lines) group by 1
  loop
    select * into v_product from public.products where id = line.product_id;
    if v_product.stock < line.needed then
      raise exception 'Insufficient stock for %. Available: %', v_product.name, trim(trailing '.' from trim(trailing '0' from v_product.stock::text));
    end if;
  end loop;

  -- Loyalty redemption.
  if redeem_points > 0 then
    if v_customer.id is null then raise exception 'Select a customer to redeem points'; end if;
    if not v_business.loyalty_enabled then raise exception 'The loyalty programme is switched off'; end if;
    select coalesce(sum(points), 0) into v_points_balance from public.loyalty_ledger where customer_id = v_customer.id;
    if redeem_points > v_points_balance then raise exception '% only has % points', v_customer.name, v_points_balance; end if;
    v_loyalty_discount := round(redeem_points * v_business.loyalty_point_value, 2);
    if v_loyalty_discount > v_subtotal then raise exception 'The points are worth more than this sale'; end if;
  end if;
  v_total := v_subtotal - v_loyalty_discount;
  if v_subtotal > 0 then v_vat := v_vat * v_total / v_subtotal; end if;

  -- Payments must add up exactly to the amount due.
  if payment_lines is null or jsonb_typeof(payment_lines) <> 'array' or jsonb_array_length(payment_lines) = 0 then
    if chosen_payment_method is null or chosen_payment_method not in ('cash', 'mpesa', 'card', 'credit') then
      raise exception 'Invalid payment method';
    end if;
    v_payments := case when v_total > 0
      then jsonb_build_array(jsonb_build_object('method', chosen_payment_method, 'amount', v_total, 'reference', payment_reference))
      else '[]'::jsonb end;
  else
    v_payments := payment_lines;
  end if;
  if jsonb_array_length(v_payments) > 4 then raise exception 'Too many payment parts'; end if;
  for entry in select * from jsonb_array_elements(v_payments)
  loop
    if jsonb_typeof(entry) <> 'object' or coalesce(entry->>'method', '') not in ('cash', 'mpesa', 'card', 'credit')
       or jsonb_typeof(entry->'amount') <> 'number' or (entry->>'amount')::numeric <= 0
       or (entry->>'amount')::numeric <> round((entry->>'amount')::numeric, 2)
       or coalesce(length(entry->>'reference'), 0) > 40 then
      raise exception 'A payment amount is invalid';
    end if;
    v_paid := v_paid + (entry->>'amount')::numeric;
    if entry->>'method' = 'credit' then v_credit := v_credit + (entry->>'amount')::numeric; end if;
  end loop;
  if v_paid <> v_total then
    raise exception 'Payments (KSh %) must equal the amount due (KSh %)', v_paid, v_total;
  end if;
  select count(distinct value->>'method'), min(value->>'method') into v_methods, v_method from jsonb_array_elements(v_payments);
  v_method := case when v_methods = 0 then coalesce(chosen_payment_method, 'cash') when v_methods = 1 then v_method else 'split' end;
  if v_method not in ('cash', 'mpesa', 'card', 'credit', 'split') then v_method := 'cash'; end if;

  if v_credit > 0 then
    if v_customer.id is null then raise exception 'Select a customer for the credit part of this sale'; end if;
    if v_customer.credit_limit > 0 then
      select coalesce(sum(amount), 0) into v_balance from public.customer_ledger where customer_id = v_customer.id;
      if v_balance + v_credit > v_customer.credit_limit then
        raise exception 'Credit limit exceeded for %. Owed: KSh %, limit: KSh %', v_customer.name, v_balance, v_customer.credit_limit;
      end if;
    end if;
    if credit_due_date is not null and credit_due_date < current_date then raise exception 'The credit due date is in the past'; end if;
  end if;

  insert into public.business_counters as counter (business_id, last_receipt)
  values (target_business_id, 1)
  on conflict (business_id) do update set last_receipt = counter.last_receipt + 1
  returning counter.last_receipt into v_counter;
  v_receipt := 'R' || lpad(v_counter::text, 6, '0');

  begin
    insert into public.sales (
      id, business_id, receipt_number, cashier_id, subtotal, vat_amount, total, total_cost, payment_method,
      customer_id, customer_name, customer_phone, payment_reference, client_reference, status,
      discount_total, loyalty_points_redeemed, loyalty_discount, credit_due_date
    ) values (
      v_sale_id, target_business_id, v_receipt, auth.uid(), v_subtotal, round(v_vat, 2), v_total, v_cost, v_method,
      v_customer.id, v_customer.name, v_customer.phone, nullif(trim(payment_reference), ''), v_reference, 'completed',
      v_discount, redeem_points, v_loyalty_discount, case when v_credit > 0 then credit_due_date end
    );
  exception when unique_violation then
    select existing.id, existing.receipt_number, existing.total into v_existing
    from public.sales existing
    where existing.business_id = target_business_id and existing.client_reference = v_reference;
    if found then
      return query select v_existing.id, v_existing.receipt_number, v_existing.total, true;
      return;
    end if;
    raise;
  end;

  for entry in select * from jsonb_array_elements(v_lines)
  loop
    update public.products set stock = stock - (entry->>'stock_quantity')::numeric
    where id = (entry->>'product_id')::uuid
    returning * into v_product;

    insert into public.sale_items (business_id, sale_id, product_id, product_name, quantity, unit_price, unit_cost, vat_rate,
      line_total, list_price, sold_as, stock_quantity, tax_category)
    values (target_business_id, v_sale_id, v_product.id,
      case when entry->>'mode' = 'serving' then v_product.name || ' (serving)' else v_product.name end,
      (entry->>'quantity')::numeric, (entry->>'unit_price')::numeric, (entry->>'unit_cost')::numeric,
      (entry->>'vat_rate')::numeric, (entry->>'line_total')::numeric, (entry->>'list_price')::numeric,
      entry->>'mode', (entry->>'stock_quantity')::numeric, entry->>'tax_category');

    insert into public.stock_movements (business_id, product_id, movement_type, quantity, stock_after, unit_cost, reference_id, created_by)
    values (target_business_id, v_product.id, 'sale', -(entry->>'stock_quantity')::numeric, v_product.stock, v_product.cost, v_sale_id, auth.uid());
  end loop;

  for entry in select * from jsonb_array_elements(v_payments)
  loop
    insert into public.sale_payments (business_id, sale_id, method, amount, reference)
    values (target_business_id, v_sale_id, entry->>'method', (entry->>'amount')::numeric, nullif(trim(entry->>'reference'), ''));
  end loop;

  if v_credit > 0 then
    insert into public.customer_ledger (business_id, customer_id, entry_type, amount, sale_id, note, created_by)
    values (target_business_id, v_customer.id, 'credit_sale', v_credit, v_sale_id, 'Sale ' || v_receipt, auth.uid());
  end if;

  if redeem_points > 0 then
    insert into public.loyalty_ledger (business_id, customer_id, points, entry_type, sale_id, created_by)
    values (target_business_id, v_customer.id, -redeem_points, 'redeemed', v_sale_id, auth.uid());
  end if;
  if v_customer.id is not null and v_business.loyalty_enabled then
    v_points_earned := floor(v_total / v_business.loyalty_spend_per_point);
    if v_points_earned > 0 then
      insert into public.loyalty_ledger (business_id, customer_id, points, entry_type, sale_id, created_by)
      values (target_business_id, v_customer.id, v_points_earned, 'earned', v_sale_id, auth.uid());
    end if;
  end if;

  return query select v_sale_id, v_receipt, v_total, false;
end;
$$;
revoke all on function public.complete_pos_sale(uuid, text, jsonb, uuid, uuid, text, jsonb, date, integer) from public;
grant execute on function public.complete_pos_sale(uuid, text, jsonb, uuid, uuid, text, jsonb, date, integer) to authenticated;

-- Owners and admins can void any sale. A cashier can cancel their own most recent
-- sale within 15 minutes (for mistakes at the till).
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
  v_credit numeric;
  v_points integer;
  item record;
begin
  if void_reason is null or length(trim(void_reason)) < 3 then
    raise exception 'Give a reason for voiding this sale';
  end if;

  select * into v_sale from public.sales
  where id = target_sale_id and business_id = target_business_id
  for update;
  if not found then raise exception 'Sale not found'; end if;

  if not public.has_paid_role(target_business_id, array['owner', 'admin']) then
    if not public.has_paid_role(target_business_id, array['cashier'])
       or v_sale.cashier_id <> auth.uid()
       or v_sale.sold_at < now() - interval '15 minutes'
       or exists (select 1 from public.sales later where later.business_id = target_business_id
                  and later.cashier_id = auth.uid() and later.sold_at > v_sale.sold_at) then
      raise exception 'Only the owner or an admin can void this sale. Cashiers can cancel their own last sale within 15 minutes.';
    end if;
  end if;
  if v_sale.status <> 'completed' then raise exception 'This sale has already been voided'; end if;

  for item in
    select sale_item.product_id, sum(coalesce(sale_item.stock_quantity, sale_item.quantity)) as quantity, max(sale_item.unit_cost) as unit_cost
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

  select coalesce(sum(amount), 0) into v_credit from public.customer_ledger where sale_id = v_sale.id;
  if v_credit > 0 and v_sale.customer_id is not null then
    insert into public.customer_ledger (business_id, customer_id, entry_type, amount, sale_id, note, created_by)
    values (target_business_id, v_sale.customer_id, 'void', -v_credit, v_sale.id, 'Void of ' || v_sale.receipt_number, auth.uid());
  end if;

  select coalesce(sum(points), 0) into v_points from public.loyalty_ledger where sale_id = v_sale.id;
  if v_points <> 0 and v_sale.customer_id is not null then
    insert into public.loyalty_ledger (business_id, customer_id, points, entry_type, sale_id, note, created_by)
    values (target_business_id, v_sale.customer_id, -v_points, 'reversed', v_sale.id, 'Void of ' || v_sale.receipt_number, auth.uid());
  end if;
end;
$$;
revoke all on function public.void_sale(uuid, uuid, text) from public;
grant execute on function public.void_sale(uuid, uuid, text) to authenticated;

-- Credit sales with what has been paid against each one (oldest debts are paid first).
create or replace function public.credit_sales_status(target_business_id uuid)
returns table (
  sale_id uuid, receipt_number text, sold_at timestamptz, customer_id uuid, customer_name text, customer_phone text,
  items text, credit_amount numeric, paid numeric, balance numeric, due_date date, status text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'cashier', 'accountant']) then
    raise exception 'You do not have permission to view credit sales';
  end if;
  return query
  with credits as (
    select entry.sale_id, entry.customer_id, entry.amount, entry.created_at
    from public.customer_ledger entry
    join public.sales sale on sale.id = entry.sale_id
    where entry.business_id = target_business_id and entry.entry_type = 'credit_sale' and sale.status = 'completed'
  ),
  payments as (
    select entry.customer_id, -sum(entry.amount) as paid_total
    from public.customer_ledger entry
    where entry.business_id = target_business_id and entry.entry_type = 'payment'
    group by entry.customer_id
  ),
  allocated as (
    select credits.*,
           coalesce(sum(credits.amount) over (partition by credits.customer_id order by credits.created_at, credits.sale_id
             rows between unbounded preceding and 1 preceding), 0) as before_amount,
           coalesce(payments.paid_total, 0) as paid_total
    from credits left join payments on payments.customer_id = credits.customer_id
  )
  select sale.id, sale.receipt_number, sale.sold_at, customer.id, customer.name, customer.phone,
         (select string_agg(item.product_name || ' x' || trim(trailing '.' from trim(trailing '0' from item.quantity::text)), ', ')
          from public.sale_items item where item.sale_id = sale.id)::text,
         allocated.amount,
         least(allocated.amount, greatest(0, allocated.paid_total - allocated.before_amount))::numeric(14,2),
         (allocated.amount - least(allocated.amount, greatest(0, allocated.paid_total - allocated.before_amount)))::numeric(14,2),
         sale.credit_due_date,
         case
           when allocated.amount - least(allocated.amount, greatest(0, allocated.paid_total - allocated.before_amount)) <= 0 then 'paid'
           when sale.credit_due_date is not null and sale.credit_due_date < current_date then 'overdue'
           else 'pending'
         end
  from allocated
  join public.sales sale on sale.id = allocated.sale_id
  join public.customers customer on customer.id = allocated.customer_id
  order by sale.sold_at desc;
end;
$$;
revoke all on function public.credit_sales_status(uuid) from public;
grant execute on function public.credit_sales_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Creditors (money the business owes, other than supplier invoices)
-- ---------------------------------------------------------------------------

create table if not exists public.creditors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  phone text check (coalesce(length(phone), 0) <= 30),
  description text check (coalesce(length(description), 0) <= 300),
  amount numeric(14,2) not null check (amount > 0),
  due_date date,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists creditors_business_idx on public.creditors (business_id, created_at desc);

create table if not exists public.creditor_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  creditor_id uuid not null references public.creditors(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('cash', 'mpesa', 'bank', 'other')),
  note text check (coalesce(length(note), 0) <= 300),
  paid_on date not null default current_date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists creditor_payments_creditor_idx on public.creditor_payments (business_id, creditor_id);

alter table public.creditors enable row level security;
alter table public.creditor_payments enable row level security;
drop policy if exists creditors_select on public.creditors;
drop policy if exists creditors_insert on public.creditors;
drop policy if exists creditors_update on public.creditors;
drop policy if exists creditor_payments_select on public.creditor_payments;
create policy creditors_select on public.creditors for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy creditors_insert on public.creditors for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy creditors_update on public.creditors for update to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']))
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy creditor_payments_select on public.creditor_payments for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
revoke all on public.creditors from authenticated;
revoke all on public.creditor_payments from authenticated;
grant select on public.creditors to authenticated;
grant insert (business_id, name, phone, description, amount, due_date) on public.creditors to authenticated;
grant update (name, phone, description, due_date) on public.creditors to authenticated;
grant select on public.creditor_payments to authenticated;

create or replace view public.creditor_balances
with (security_invoker = true) as
select creditor.id, creditor.business_id, creditor.name, creditor.phone, creditor.description, creditor.amount,
       creditor.due_date, creditor.created_at,
       coalesce((select sum(payment.amount) from public.creditor_payments payment where payment.creditor_id = creditor.id), 0)::numeric(14,2) as paid,
       (creditor.amount - coalesce((select sum(payment.amount) from public.creditor_payments payment where payment.creditor_id = creditor.id), 0))::numeric(14,2) as balance
from public.creditors creditor;
grant select on public.creditor_balances to authenticated;

create or replace function public.record_creditor_payment(
  target_business_id uuid, target_creditor_id uuid, payment_amount numeric, method text, payment_note text default null
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
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'accountant']) then
    raise exception 'You do not have permission to record creditor payments';
  end if;
  if payment_amount is null or payment_amount <= 0 or payment_amount <> round(payment_amount, 2) then raise exception 'Enter a valid amount'; end if;
  if method is null or method not in ('cash', 'mpesa', 'bank', 'other') then raise exception 'Invalid payment method'; end if;
  perform 1 from public.creditors where id = target_creditor_id and business_id = target_business_id for update;
  if not found then raise exception 'Creditor not found'; end if;
  select creditor.amount - coalesce((select sum(payment.amount) from public.creditor_payments payment where payment.creditor_id = creditor.id), 0)
  into v_balance
  from public.creditors creditor where creditor.id = target_creditor_id;
  if payment_amount > v_balance then raise exception 'Payment is more than the KSh % balance', v_balance; end if;
  insert into public.creditor_payments (business_id, creditor_id, amount, method, note, created_by)
  values (target_business_id, target_creditor_id, payment_amount, method, left(nullif(trim(payment_note), ''), 300), auth.uid());
  return v_balance - payment_amount;
end;
$$;
revoke all on function public.record_creditor_payment(uuid, uuid, numeric, text, text) from public;
grant execute on function public.record_creditor_payment(uuid, uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Purchases: batches, expiry, invoice total and selling price updates
-- ---------------------------------------------------------------------------

alter table public.purchases add column if not exists items_total numeric(14,2);
alter table public.purchase_items
  add column if not exists batch_number text,
  add column if not exists expiry_date date,
  add column if not exists vat_rate numeric(5,2) not null default 0;

drop function if exists public.record_purchase(uuid, uuid, jsonb, text, numeric, date, text);

create or replace function public.record_purchase(
  target_business_id uuid,
  target_supplier_id uuid,
  items jsonb,
  purchase_reference text default null,
  paid_amount numeric default null,
  purchase_date date default current_date,
  purchase_notes text default null,
  invoice_total numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_purchase_id uuid := gen_random_uuid();
  v_items_total numeric := 0;
  v_total numeric;
  v_paid numeric;
  v_product public.products%rowtype;
  v_old_stock numeric;
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
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then raise exception 'Add at least one item'; end if;
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
      when jsonb_typeof(element->'selling_price') = 'number' and ((element->>'selling_price')::numeric < 0
        or (element->>'selling_price')::numeric <> round((element->>'selling_price')::numeric, 2)) then true
      when coalesce(length(element->>'batch_number'), 0) > 60 then true
      when coalesce(element->>'expiry_date', '') <> '' and (element->>'expiry_date') !~ '^\d{4}-\d{2}-\d{2}$' then true
      else false
    end
  ) then
    raise exception 'A purchase item is invalid';
  end if;
  if purchase_date is null or purchase_date > current_date + 1 then raise exception 'Invalid purchase date'; end if;

  select coalesce(sum(round((element->>'quantity')::numeric * (element->>'unit_cost')::numeric, 2)), 0) into v_items_total
  from jsonb_array_elements(items) element;
  if invoice_total is not null and (invoice_total < 0 or invoice_total <> round(invoice_total, 2)) then raise exception 'Invalid invoice total'; end if;
  v_total := coalesce(invoice_total, v_items_total);
  v_paid := coalesce(paid_amount, v_total);
  if v_paid < 0 or v_paid > v_total or v_paid <> round(v_paid, 2) then
    raise exception 'Amount paid must be between 0 and the purchase total';
  end if;

  insert into public.purchases (id, business_id, supplier_id, reference, total, items_total, amount_paid, purchased_on, notes, created_by)
  values (v_purchase_id, target_business_id, target_supplier_id, left(nullif(trim(purchase_reference), ''), 60),
          v_total, v_items_total, v_paid, purchase_date, left(nullif(trim(purchase_notes), ''), 500), auth.uid());

  for line in
    select (entry.value->>'product_id')::uuid as product_id,
           (entry.value->>'quantity')::numeric as quantity,
           (entry.value->>'unit_cost')::numeric as unit_cost,
           case when jsonb_typeof(entry.value->'selling_price') = 'number' then (entry.value->>'selling_price')::numeric end as selling_price,
           nullif(trim(entry.value->>'batch_number'), '') as batch_number,
           nullif(entry.value->>'expiry_date', '')::date as expiry_date,
           entry.position
    from jsonb_array_elements(items) with ordinality as entry(value, position)
    order by 1, entry.position
  loop
    select * into v_product from public.products
    where id = line.product_id and business_id = target_business_id
    for update;
    if not found then raise exception 'A product in this purchase was not found'; end if;
    v_old_stock := v_product.stock;

    v_new_cost := case
      when v_product.stock > 0 then round((v_product.stock * v_product.cost + line.quantity * line.unit_cost) / (v_product.stock + line.quantity), 2)
      else line.unit_cost
    end;

    update public.products
    set stock = stock + line.quantity,
        cost = v_new_cost,
        price = coalesce(line.selling_price, price),
        batch_number = coalesce(line.batch_number, batch_number),
        expiry_date = case
          when line.expiry_date is null then expiry_date
          when v_old_stock <= 0 or expiry_date is null then line.expiry_date
          else least(expiry_date, line.expiry_date)
        end
    where id = v_product.id
    returning * into v_product;

    insert into public.purchase_items (business_id, purchase_id, product_id, product_name, quantity, unit_cost, line_total, batch_number, expiry_date, vat_rate)
    values (target_business_id, v_purchase_id, v_product.id, v_product.name, line.quantity, line.unit_cost,
            round(line.quantity * line.unit_cost, 2), line.batch_number, line.expiry_date, v_product.vat_rate);

    insert into public.stock_movements (business_id, product_id, movement_type, quantity, stock_after, unit_cost, reference_id, note, created_by)
    values (target_business_id, v_product.id, 'purchase', line.quantity, v_product.stock, line.unit_cost, v_purchase_id,
            case when line.batch_number is not null then 'Batch ' || line.batch_number end, auth.uid());
  end loop;

  return v_purchase_id;
end;
$$;
revoke all on function public.record_purchase(uuid, uuid, jsonb, text, numeric, date, text, numeric) from public;
grant execute on function public.record_purchase(uuid, uuid, jsonb, text, numeric, date, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Chart of accounts and journal entries
-- ---------------------------------------------------------------------------

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  code text not null check (length(trim(code)) between 1 and 20),
  name text not null check (length(trim(name)) between 1 and 120),
  account_type text not null check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  opening_balance numeric(14,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id, code),
  unique (id, business_id)
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  entry_date date not null default current_date,
  reference text not null check (length(trim(reference)) between 1 and 40),
  description text not null check (length(trim(description)) between 1 and 300),
  debit_account_id uuid not null,
  credit_account_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (debit_account_id <> credit_account_id),
  foreign key (debit_account_id, business_id) references public.accounts (id, business_id),
  foreign key (credit_account_id, business_id) references public.accounts (id, business_id)
);
create index if not exists journal_entries_business_date_idx on public.journal_entries (business_id, entry_date desc, created_at desc);
create index if not exists journal_entries_debit_idx on public.journal_entries (debit_account_id);
create index if not exists journal_entries_credit_idx on public.journal_entries (credit_account_id);

alter table public.accounts enable row level security;
alter table public.journal_entries enable row level security;
drop policy if exists accounts_select on public.accounts;
drop policy if exists accounts_insert on public.accounts;
drop policy if exists accounts_update on public.accounts;
drop policy if exists journal_entries_select on public.journal_entries;
drop policy if exists journal_entries_insert on public.journal_entries;
drop policy if exists journal_entries_delete on public.journal_entries;
create policy accounts_select on public.accounts for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy accounts_insert on public.accounts for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy accounts_update on public.accounts for update to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']))
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy journal_entries_select on public.journal_entries for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']));
create policy journal_entries_insert on public.journal_entries for insert to authenticated
  with check (public.has_paid_role(business_id, array['owner', 'admin', 'accountant']) and created_by = auth.uid());
create policy journal_entries_delete on public.journal_entries for delete to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin']));
revoke all on public.accounts from authenticated;
revoke all on public.journal_entries from authenticated;
grant select on public.accounts to authenticated;
grant insert (business_id, code, name, account_type, opening_balance) on public.accounts to authenticated;
grant update (name, opening_balance, active) on public.accounts to authenticated;
grant select, delete on public.journal_entries to authenticated;
grant insert (business_id, entry_date, reference, description, debit_account_id, credit_account_id, amount, created_by)
  on public.journal_entries to authenticated;

create or replace view public.account_balances
with (security_invoker = true) as
select account.id, account.business_id, account.code, account.name, account.account_type, account.opening_balance, account.active,
       coalesce((select sum(entry.amount) from public.journal_entries entry where entry.debit_account_id = account.id), 0)::numeric(14,2) as debits,
       coalesce((select sum(entry.amount) from public.journal_entries entry where entry.credit_account_id = account.id), 0)::numeric(14,2) as credits,
       (account.opening_balance + case when account.account_type in ('asset', 'expense')
         then coalesce((select sum(entry.amount) from public.journal_entries entry where entry.debit_account_id = account.id), 0)
            - coalesce((select sum(entry.amount) from public.journal_entries entry where entry.credit_account_id = account.id), 0)
         else coalesce((select sum(entry.amount) from public.journal_entries entry where entry.credit_account_id = account.id), 0)
            - coalesce((select sum(entry.amount) from public.journal_entries entry where entry.debit_account_id = account.id), 0)
       end)::numeric(14,2) as balance
from public.accounts account;
grant select on public.account_balances to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Reports: payment splits, discounts, hours, categories, staff, VAT bands
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
  v_shift interval;
  v_first_day date;
  v_last_day date;
  v_result jsonb;
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'accountant']) then
    raise exception 'You do not have permission to view reports';
  end if;
  if period_start is null or period_end is null or period_end <= period_start then raise exception 'Invalid report period'; end if;
  if period_end - period_start > interval '400 days' then raise exception 'Choose a period of 400 days or less'; end if;

  select coalesce(timezone, 'Africa/Nairobi'), make_interval(hours => coalesce(day_start_hour, 0))
  into v_tz, v_shift from public.businesses where id = target_business_id;
  v_first_day := ((period_start at time zone v_tz) - v_shift)::date;
  v_last_day := ((period_end at time zone v_tz) - v_shift - interval '1 microsecond')::date;

  with period_sales as (
    select * from public.sales
    where business_id = target_business_id and sold_at >= period_start and sold_at < period_end
  ),
  completed as (select * from period_sales where status = 'completed'),
  items as (
    select item.*, sale.cashier_id, sale.sold_at,
           case when sale.subtotal > 0 then sale.total / sale.subtotal else 1 end as share
    from public.sale_items item join completed sale on sale.id = item.sale_id
    where item.business_id = target_business_id
  ),
  period_expenses as (
    select * from public.expenses
    where business_id = target_business_id and expense_date between v_first_day and v_last_day
  ),
  period_purchase_items as (
    select item.* from public.purchase_items item
    join public.purchases purchase on purchase.id = item.purchase_id
    where purchase.business_id = target_business_id and purchase.purchased_on between v_first_day and v_last_day
  ),
  totals as (
    select coalesce(sum(total), 0) as revenue, coalesce(sum(vat_amount), 0) as vat,
           coalesce(sum(total_cost), 0) as cost_of_sales, count(*) as transactions,
           coalesce(sum(discount_total), 0) as discounts, coalesce(sum(loyalty_discount), 0) as loyalty_discount
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
    'discounts', totals.discounts,
    'loyalty_discount', totals.loyalty_discount,
    'voided_count', (select count(*) from period_sales where status = 'voided'),
    'voided_total', (select coalesce(sum(total), 0) from period_sales where status = 'voided'),
    'credit_sales', (select coalesce(sum(payment.amount), 0) from public.sale_payments payment join completed sale on sale.id = payment.sale_id where payment.method = 'credit'),
    'payment_methods', coalesce((
      select jsonb_agg(jsonb_build_object('method', method, 'count', count, 'total', amount) order by amount desc)
      from (select payment.method, count(distinct payment.sale_id) as count, sum(payment.amount) as amount
            from public.sale_payments payment join completed sale on sale.id = payment.sale_id group by payment.method) methods
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'revenue', revenue, 'transactions', transactions, 'gross_profit', gross_profit) order by day)
      from (
        select ((sold_at at time zone v_tz) - v_shift)::date as day, sum(total) as revenue, count(*) as transactions,
               sum(total - vat_amount - total_cost) as gross_profit
        from completed group by 1
      ) days
    ), '[]'::jsonb),
    'daily_expenses', coalesce((
      select jsonb_agg(jsonb_build_object('day', expense_date, 'amount', amount) order by expense_date)
      from (select expense_date, sum(amount) as amount from period_expenses group by expense_date) expense_days
    ), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object('hour', hour, 'revenue', revenue, 'transactions', transactions) order by hour)
      from (select extract(hour from sold_at at time zone v_tz)::int as hour, sum(total) as revenue, count(*) as transactions
            from completed group by 1) hours
    ), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', product_id, 'name', name, 'quantity', quantity, 'revenue', revenue, 'gross_profit', gross_profit) order by revenue desc)
      from (
        select product_id, max(product_name) as name, sum(quantity) as quantity, sum(line_total * share) as revenue,
               sum(line_total * share - line_total * share * vat_rate / (100 + vat_rate) - round(coalesce(stock_quantity, quantity) * unit_cost, 2)) as gross_profit
        from items group by product_id order by revenue desc limit 10
      ) top
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'revenue', revenue, 'quantity', quantity) order by revenue desc)
      from (
        select coalesce(product.category, 'Uncategorised') as category, sum(items.line_total * items.share) as revenue, sum(items.quantity) as quantity
        from items left join public.products product on product.id = items.product_id
        group by 1
      ) categories
    ), '[]'::jsonb),
    'cashiers', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', cashier_id, 'transactions', transactions, 'revenue', revenue, 'gross_profit', gross_profit, 'voided', voided) order by revenue desc)
      from (
        select sale.cashier_id,
               count(*) filter (where sale.status = 'completed') as transactions,
               coalesce(sum(sale.total) filter (where sale.status = 'completed'), 0) as revenue,
               coalesce(sum(sale.total - sale.vat_amount - sale.total_cost) filter (where sale.status = 'completed'), 0) as gross_profit,
               count(*) filter (where sale.status = 'voided') as voided
        from period_sales sale group by sale.cashier_id
      ) staff
    ), '[]'::jsonb),
    'vat_bands', coalesce((
      select jsonb_agg(jsonb_build_object('band', band, 'gross', gross, 'vat', vat, 'net', gross - vat) order by band)
      from (
        select coalesce(tax_category, case when vat_rate >= 16 then 'standard' when vat_rate > 0 then 'reduced' else 'exempt' end) as band,
               sum(line_total * share) as gross,
               sum(line_total * share * vat_rate / (100 + vat_rate)) as vat
        from items group by 1
      ) bands
    ), '[]'::jsonb),
    'input_vat', (select coalesce(sum(line_total * vat_rate / (100 + vat_rate)), 0) from period_purchase_items),
    'expense_categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'total', amount, 'count', count) order by amount desc)
      from (select category, sum(amount) as amount, count(*) as count from period_expenses group by category) categories
    ), '[]'::jsonb),
    'purchases', (select coalesce(sum(total), 0) from public.purchases where business_id = target_business_id and purchased_on between v_first_day and v_last_day),
    'stock_value', (select coalesce(sum(stock * cost), 0) from public.products where business_id = target_business_id and active),
    'stock_retail_value', (select coalesce(sum(stock * price), 0) from public.products where business_id = target_business_id and active),
    'low_stock_count', (select count(*) from public.products where business_id = target_business_id and active and is_low_stock),
    'expiring_count', (select count(*) from public.products where business_id = target_business_id and active and expiry_date is not null and expiry_date <= current_date + 30 and stock > 0),
    'outstanding_credit', (select coalesce(sum(amount), 0) from public.customer_ledger where business_id = target_business_id),
    'supplier_balance', (select coalesce(sum(total - amount_paid), 0) from public.purchases where business_id = target_business_id),
    'creditor_balance', (select coalesce(sum(balance), 0) from public.creditor_balances where business_id = target_business_id)
  ) into v_result
  from totals, expense_total;

  return v_result;
end;
$$;
revoke all on function public.business_report(uuid, timestamptz, timestamptz) from public;
grant execute on function public.business_report(uuid, timestamptz, timestamptz) to authenticated;

commit;

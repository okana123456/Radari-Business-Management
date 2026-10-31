-- Radari 0006: automatic M-Pesa till and paybill payment notifications.
--
-- Safaricom sends every payment made to the business's till or paybill to the
-- till-payment-notify Edge Function, which records it here. The till shows it live and
-- the cashier attaches it to a sale; each payment can be used only once.
--
-- Run once in the Supabase SQL Editor AFTER 0005. Runs in one transaction; safe to re-run.

begin;

-- Daraja credentials per business. Only the service role (Edge Functions) can read this table.
create table if not exists public.till_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  environment text not null default 'production' check (environment in ('sandbox', 'production')),
  shortcode_type text not null check (shortcode_type in ('till', 'paybill')),
  shortcode text not null check (shortcode ~ '^[0-9]{5,10}$'),
  till_number text check (till_number is null or till_number ~ '^[0-9]{5,10}$'),
  consumer_key text not null,
  consumer_secret text not null,
  callback_token text not null unique check (callback_token ~ '^[0-9a-f]{48}$'),
  registered_at timestamptz,
  last_error text,
  last_payment_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.till_settings enable row level security;
revoke all on public.till_settings from anon, authenticated;

create table if not exists public.till_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  trans_id text not null unique check (length(trans_id) between 6 and 30),
  trans_time timestamptz not null,
  amount numeric(14,2) not null check (amount > 0),
  shortcode text,
  bill_ref text check (coalesce(length(bill_ref), 0) <= 60),
  msisdn text check (coalesce(length(msisdn), 0) <= 80),
  payer_name text check (coalesce(length(payer_name), 0) <= 120),
  status text not null default 'unclaimed' check (status in ('unclaimed', 'claimed', 'dismissed')),
  sale_id uuid references public.sales(id),
  claimed_by uuid references auth.users(id),
  claimed_at timestamptz,
  note text check (coalesce(length(note), 0) <= 300),
  received_at timestamptz not null default now()
);
create index if not exists till_payments_business_time_idx on public.till_payments (business_id, trans_time desc);
create index if not exists till_payments_business_open_idx on public.till_payments (business_id, trans_time desc) where status = 'unclaimed';

alter table public.till_payments enable row level security;
drop policy if exists till_payments_select on public.till_payments;
create policy till_payments_select on public.till_payments for select to authenticated
  using (public.has_paid_role(business_id, array['owner', 'admin', 'cashier', 'accountant']));
revoke all on public.till_payments from anon, authenticated;
grant select on public.till_payments to authenticated;

alter table public.sale_payments add column if not exists till_payment_id uuid references public.till_payments(id);
create index if not exists sale_payments_till_payment_idx on public.sale_payments (till_payment_id) where till_payment_id is not null;

-- Called by the till-payment-notify Edge Function only. Idempotent on the M-Pesa receipt.
create or replace function public.record_till_payment(
  callback_token text, trans_id text, trans_time timestamptz, amount numeric,
  shortcode text default null, bill_ref text default null, msisdn text default null, payer_name text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_settings public.till_settings%rowtype;
begin
  select * into v_settings from public.till_settings settings where settings.callback_token = callback_token;
  if not found then return 'unknown_token'; end if;
  if trans_id is null or trans_id !~ '^[A-Z0-9]{6,30}$' then return 'invalid_receipt'; end if;
  if amount is null or amount <= 0 then return 'invalid_amount'; end if;
  if shortcode is not null and shortcode <> v_settings.shortcode and shortcode is distinct from v_settings.till_number then
    return 'shortcode_mismatch';
  end if;

  insert into public.till_payments (business_id, trans_id, trans_time, amount, shortcode, bill_ref, msisdn, payer_name)
  values (v_settings.business_id, trans_id, coalesce(trans_time, now()), round(amount, 2), shortcode,
          left(nullif(trim(bill_ref), ''), 60), left(nullif(trim(msisdn), ''), 80), left(nullif(trim(payer_name), ''), 120))
  on conflict on constraint till_payments_trans_id_key do nothing;

  update public.till_settings set last_payment_at = now() where business_id = v_settings.business_id;
  return 'recorded';
end;
$$;
revoke all on function public.record_till_payment(text, text, timestamptz, numeric, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_till_payment(text, text, timestamptz, numeric, text, text, text, text) to service_role;

-- Connection status without any secrets, for the till and settings screens.
create or replace function public.till_connection_status(target_business_id uuid)
returns table (connected boolean, environment text, shortcode_type text, shortcode text, till_number text,
               registered_at timestamptz, last_error text, last_payment_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'cashier', 'accountant']) then
    raise exception 'Not allowed';
  end if;
  return query
  select settings.registered_at is not null, settings.environment, settings.shortcode_type, settings.shortcode, settings.till_number,
         settings.registered_at, settings.last_error, settings.last_payment_at
  from public.till_settings settings where settings.business_id = target_business_id;
end;
$$;
revoke all on function public.till_connection_status(uuid) from public;
grant execute on function public.till_connection_status(uuid) to authenticated;

-- Owners, admins and accountants can set aside payments that are not for a sale
-- (for example a debt repayment), or put them back.
create or replace function public.set_till_payment_status(target_business_id uuid, target_payment_id uuid, new_status text, status_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_paid_role(target_business_id, array['owner', 'admin', 'accountant']) then
    raise exception 'Only the owner, an admin or the accountant can change this payment';
  end if;
  if new_status not in ('unclaimed', 'dismissed') then raise exception 'Invalid status'; end if;
  update public.till_payments set status = new_status, note = left(nullif(trim(status_note), ''), 300)
  where id = target_payment_id and business_id = target_business_id and status <> 'claimed';
  if not found then raise exception 'Payment not found, or it is already attached to a sale'; end if;
end;
$$;
revoke all on function public.set_till_payment_status(uuid, uuid, text, text) from public;
grant execute on function public.set_till_payment_status(uuid, uuid, text, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'till_payments') then
    alter publication supabase_realtime add table public.till_payments;
  end if;
end;
$$;

-- Checkout: a payment line can now carry till_payment_id to claim a received payment.
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
  v_till_id uuid;
  v_till_trans text;
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
    if entry ? 'till_payment_id' and entry->>'till_payment_id' is not null then
      if entry->>'method' <> 'mpesa' or (entry->>'till_payment_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'A received M-Pesa payment can only be used for the M-Pesa part of a sale';
      end if;
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
    v_till_id := null; v_till_trans := null;
    if entry ? 'till_payment_id' and entry->>'till_payment_id' is not null then
      -- Claim a payment received on the till. The row lock and status check stop two tills using it.
      update public.till_payments
      set status = 'claimed', sale_id = v_sale_id, claimed_by = auth.uid(), claimed_at = now()
      where id = (entry->>'till_payment_id')::uuid and business_id = target_business_id
        and status = 'unclaimed' and amount >= (entry->>'amount')::numeric
      returning id, trans_id into v_till_id, v_till_trans;
      if v_till_id is null then
        raise exception 'That M-Pesa payment has already been used or is less than the amount charged';
      end if;
    end if;
    insert into public.sale_payments (business_id, sale_id, method, amount, reference, till_payment_id)
    values (target_business_id, v_sale_id, entry->>'method', (entry->>'amount')::numeric,
            coalesce(v_till_trans, nullif(trim(entry->>'reference'), '')), v_till_id);
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

-- Voiding a sale releases any M-Pesa payment it used.
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

  -- M-Pesa payments used for this sale become available again (refund them separately).
  update public.till_payments set status = 'unclaimed', sale_id = null, claimed_by = null, claimed_at = null
  where sale_id = v_sale.id;
end;
$$;
revoke all on function public.void_sale(uuid, uuid, text) from public;
grant execute on function public.void_sale(uuid, uuid, text) to authenticated;

commit;

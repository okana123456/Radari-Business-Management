alter table public.products
  add column if not exists category text not null default 'General';

create or replace function public.complete_pos_sale(
  target_business_id uuid,
  chosen_payment_method text,
  cart_items jsonb
)
returns table (sale_id uuid, receipt_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_sale_id uuid := gen_random_uuid();
  new_receipt text := 'RDR-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || upper(substr(new_sale_id::text, 1, 4));
  item jsonb;
  product_row public.products%rowtype;
  item_quantity numeric;
  sale_subtotal numeric := 0;
  sale_vat numeric := 0;
begin
  if not public.has_paid_access(target_business_id) then
    raise exception 'An active subscription is required';
  end if;
  if chosen_payment_method not in ('cash', 'mpesa', 'credit') then
    raise exception 'Invalid payment method';
  end if;
  if jsonb_typeof(cart_items) <> 'array' or jsonb_array_length(cart_items) = 0 then
    raise exception 'The cart is empty';
  end if;

  for item in select * from jsonb_array_elements(cart_items)
  loop
    item_quantity := (item->>'quantity')::numeric;
    select * into product_row from public.products
      where id = (item->>'product_id')::uuid
        and business_id = target_business_id and active = true
      for update;
    if product_row.id is null then raise exception 'A product is unavailable'; end if;
    if item_quantity <= 0 or product_row.stock < item_quantity then
      raise exception 'Insufficient stock for %', product_row.name;
    end if;
    sale_subtotal := sale_subtotal + product_row.price * item_quantity;
    sale_vat := sale_vat + (product_row.price * item_quantity) * product_row.vat_rate / (100 + product_row.vat_rate);
  end loop;

  insert into public.sales (id, business_id, receipt_number, cashier_id, subtotal, vat_amount, total, payment_method)
  values (new_sale_id, target_business_id, new_receipt, auth.uid(), sale_subtotal, round(sale_vat, 2), sale_subtotal, chosen_payment_method);

  for item in select * from jsonb_array_elements(cart_items)
  loop
    item_quantity := (item->>'quantity')::numeric;
    select * into product_row from public.products where id = (item->>'product_id')::uuid for update;
    insert into public.sale_items (business_id, sale_id, product_id, product_name, quantity, unit_price, unit_cost, vat_rate, line_total)
    values (target_business_id, new_sale_id, product_row.id, product_row.name, item_quantity,
      product_row.price, product_row.cost, product_row.vat_rate, product_row.price * item_quantity);
    update public.products set stock = stock - item_quantity, updated_at = now() where id = product_row.id;
  end loop;

  return query select new_sale_id, new_receipt;
end;
$$;

revoke all on function public.complete_pos_sale(uuid, text, jsonb) from public;
grant execute on function public.complete_pos_sale(uuid, text, jsonb) to authenticated;

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

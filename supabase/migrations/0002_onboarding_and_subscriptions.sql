create table public.subscription_notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  notification_type text not null check (notification_type in ('expires_5_days', 'expires_2_days', 'expires_1_day', 'expired')),
  scheduled_for date not null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (subscription_id, notification_type, scheduled_for)
);

create index subscriptions_status_period_end_idx
  on public.subscriptions (status, current_period_end);
create index subscription_notifications_pending_idx
  on public.subscription_notifications (scheduled_for, sent_at) where sent_at is null;

alter table public.subscription_notifications enable row level security;

create policy subscription_notifications_owner_select
  on public.subscription_notifications for select to authenticated
  using (public.is_business_owner(business_id));

grant select on public.subscription_notifications to authenticated;

create or replace function public.has_paid_access(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_business_member(target_business_id)
    and exists (
      select 1
      from public.subscriptions subscription
      where subscription.business_id = target_business_id
        and subscription.status in ('active', 'grace')
        and coalesce(subscription.grace_ends_at, subscription.current_period_end) > now()
    );
$$;

revoke all on function public.has_paid_access(uuid) from public;
grant execute on function public.has_paid_access(uuid) to authenticated;

drop policy products_member_select on public.products;
drop policy products_member_insert on public.products;
drop policy products_member_update on public.products;
drop policy products_owner_delete on public.products;
drop policy sales_member_select on public.sales;
drop policy sales_member_insert on public.sales;
drop policy sale_items_member_select on public.sale_items;
drop policy sale_items_member_insert on public.sale_items;

create policy products_paid_select on public.products for select to authenticated
  using (public.has_paid_access(business_id));
create policy products_paid_insert on public.products for insert to authenticated
  with check (public.has_paid_access(business_id));
create policy products_paid_update on public.products for update to authenticated
  using (public.has_paid_access(business_id)) with check (public.has_paid_access(business_id));
create policy products_paid_delete on public.products for delete to authenticated
  using (public.has_paid_access(business_id) and public.is_business_owner(business_id));

create policy sales_paid_select on public.sales for select to authenticated
  using (public.has_paid_access(business_id));
create policy sales_paid_insert on public.sales for insert to authenticated
  with check (public.has_paid_access(business_id) and cashier_id = auth.uid());
create policy sale_items_paid_select on public.sale_items for select to authenticated
  using (public.has_paid_access(business_id));
create policy sale_items_paid_insert on public.sale_items for insert to authenticated
  with check (
    public.has_paid_access(business_id)
    and exists (
      select 1 from public.sales sale
      where sale.id = sale_id and sale.business_id = business_id
    )
  );

create or replace function public.create_business_account(
  business_name text,
  business_slug text,
  owner_name text,
  owner_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_business_id uuid;
  normalized_slug text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(business_name)) < 2 then raise exception 'Business name is required'; end if;

  normalized_slug := lower(regexp_replace(trim(business_slug), '[^a-z0-9]+', '-', 'g'));
  normalized_slug := trim(both '-' from normalized_slug);
  if normalized_slug = '' then raise exception 'A valid business slug is required'; end if;

  insert into public.profiles (user_id, full_name, phone)
  values (auth.uid(), trim(owner_name), nullif(trim(owner_phone), ''))
  on conflict (user_id) do update
    set full_name = excluded.full_name,
        phone = coalesce(excluded.phone, public.profiles.phone),
        updated_at = now();

  insert into public.businesses (name, slug, owner_id)
  values (trim(business_name), normalized_slug, auth.uid())
  returning id into new_business_id;

  insert into public.business_memberships (business_id, user_id, role, status)
  values (new_business_id, auth.uid(), 'owner', 'active');

  insert into public.subscriptions (business_id, plan_id, status)
  values (new_business_id, 'standard-monthly', 'pending');

  return new_business_id;
end;
$$;

revoke all on function public.create_business_account(text, text, text, text) from public;
grant execute on function public.create_business_account(text, text, text, text) to authenticated;

create or replace function public.activate_subscription_from_payment(
  target_business_id uuid,
  payment_time timestamptz,
  duration_days integer default 30
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  start_time timestamptz;
  end_time timestamptz;
begin
  if duration_days < 1 or duration_days > 366 then raise exception 'Invalid subscription duration'; end if;

  select greatest(coalesce(current_period_end, payment_time), payment_time)
  into start_time
  from public.subscriptions
  where business_id = target_business_id
  for update;

  if start_time is null then raise exception 'Subscription not found'; end if;
  end_time := start_time + make_interval(days => duration_days);

  update public.subscriptions
  set status = 'active',
      current_period_start = start_time,
      current_period_end = end_time,
      grace_ends_at = end_time + interval '3 days',
      updated_at = now()
  where business_id = target_business_id;

  update public.businesses
  set status = 'active', updated_at = now()
  where id = target_business_id;
end;
$$;

revoke all on function public.activate_subscription_from_payment(uuid, timestamptz, integer) from public;
grant execute on function public.activate_subscription_from_payment(uuid, timestamptz, integer) to service_role;

create or replace function public.confirm_subscription_payment(
  target_payment_request_id uuid,
  mpesa_receipt text,
  paid_phone text,
  paid_amount integer,
  paid_time timestamptz,
  callback_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.payment_requests%rowtype;
  existing_request_id uuid;
begin
  select * into request_row
  from public.payment_requests
  where id = target_payment_request_id
  for update;

  if request_row.id is null then raise exception 'Payment request not found'; end if;
  if request_row.status = 'confirmed' then return false; end if;
  if paid_amount <> request_row.amount_kes then raise exception 'Payment amount does not match'; end if;
  if nullif(trim(mpesa_receipt), '') is null then raise exception 'M-Pesa receipt is required'; end if;

  select payment_request_id into existing_request_id
  from public.payments
  where provider_receipt = mpesa_receipt;

  if existing_request_id is not null and existing_request_id <> request_row.id then
    raise exception 'M-Pesa receipt is already assigned to another request';
  end if;

  insert into public.payments (
    business_id, payment_request_id, provider, provider_receipt,
    phone, amount_kes, paid_at, raw_callback
  ) values (
    request_row.business_id, request_row.id, 'mpesa', mpesa_receipt,
    paid_phone, paid_amount, paid_time, callback_payload
  ) on conflict (provider_receipt) do nothing;

  perform public.activate_subscription_from_payment(request_row.business_id, paid_time, 30);

  update public.payment_requests
  set status = 'confirmed', failure_reason = null, updated_at = now()
  where id = request_row.id;

  return true;
end;
$$;

revoke all on function public.confirm_subscription_payment(uuid, text, text, integer, timestamptz, jsonb) from public;
grant execute on function public.confirm_subscription_payment(uuid, text, text, integer, timestamptz, jsonb) to service_role;

create or replace function public.refresh_subscription_statuses()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_count integer;
begin
  update public.subscriptions
  set status = case
        when grace_ends_at is not null and now() > grace_ends_at then 'suspended'
        when current_period_end is not null and now() > current_period_end then 'grace'
        else status
      end,
      updated_at = now()
  where status in ('active', 'grace')
    and current_period_end is not null
    and now() > current_period_end;

  get diagnostics changed_count = row_count;

  update public.businesses business
  set status = case subscription.status when 'suspended' then 'suspended' else 'grace' end,
      updated_at = now()
  from public.subscriptions subscription
  where subscription.business_id = business.id
    and subscription.status in ('grace', 'suspended')
    and business.status is distinct from subscription.status;

  insert into public.subscription_notifications (
    business_id, subscription_id, notification_type, scheduled_for
  )
  select subscription.business_id,
         subscription.id,
         reminder.notification_type,
         reminder.scheduled_for
  from public.subscriptions subscription
  cross join lateral (
    values
      ('expires_5_days', (subscription.current_period_end - interval '5 days')::date),
      ('expires_2_days', (subscription.current_period_end - interval '2 days')::date),
      ('expires_1_day',  (subscription.current_period_end - interval '1 day')::date),
      ('expired',        subscription.current_period_end::date)
  ) as reminder(notification_type, scheduled_for)
  where subscription.current_period_end is not null
    and subscription.status in ('active', 'grace')
    and reminder.scheduled_for <= current_date
  on conflict (subscription_id, notification_type, scheduled_for) do nothing;

  return changed_count;
end;
$$;

revoke all on function public.refresh_subscription_statuses() from public;
grant execute on function public.refresh_subscription_statuses() to service_role;


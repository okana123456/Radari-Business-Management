create extension if not exists pgcrypto;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  owner_id uuid not null references auth.users(id),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'grace', 'suspended', 'closed')),
  currency text not null default 'KES',
  timezone text not null default 'Africa/Nairobi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.business_memberships (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'cashier'
    check (role in ('owner', 'admin', 'stock_manager', 'cashier', 'accountant')),
  status text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (business_id, user_id)
);

create table public.plans (
  id text primary key,
  name text not null,
  price_kes integer not null check (price_kes > 0),
  duration_days integer not null check (duration_days > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.plans (id, name, price_kes, duration_days)
values ('standard-monthly', 'Radari Standard', 1500, 30)
on conflict (id) do update set
  name = excluded.name,
  price_kes = excluded.price_kes,
  duration_days = excluded.duration_days;

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  plan_id text not null references public.plans(id),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'grace', 'past_due', 'suspended', 'cancelled')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  phone text not null,
  amount_kes integer not null check (amount_kes > 0),
  merchant_request_id text,
  checkout_request_id text unique,
  status text not null default 'created'
    check (status in ('created', 'submitted', 'confirmed', 'failed', 'cancelled', 'expired')),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  payment_request_id uuid references public.payment_requests(id),
  provider text not null default 'mpesa',
  provider_receipt text not null unique,
  phone text,
  amount_kes integer not null check (amount_kes > 0),
  paid_at timestamptz not null,
  raw_callback jsonb,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  sku text,
  barcode text,
  cost numeric(14,2) not null default 0 check (cost >= 0),
  price numeric(14,2) not null default 0 check (price >= 0),
  stock numeric(14,3) not null default 0,
  reorder_level numeric(14,3) not null default 0,
  vat_rate numeric(5,2) not null default 16,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, sku)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  receipt_number text not null,
  cashier_id uuid not null references auth.users(id),
  subtotal numeric(14,2) not null check (subtotal >= 0),
  vat_amount numeric(14,2) not null default 0 check (vat_amount >= 0),
  total numeric(14,2) not null check (total >= 0),
  payment_method text not null check (payment_method in ('cash', 'mpesa', 'credit', 'split')),
  customer_name text,
  customer_phone text,
  sold_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (business_id, receipt_number)
);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id),
  product_name text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  unit_cost numeric(14,2) not null default 0 check (unit_cost >= 0),
  vat_rate numeric(5,2) not null default 16,
  line_total numeric(14,2) not null check (line_total >= 0)
);

create index memberships_user_business_idx on public.business_memberships (user_id, business_id) where status = 'active';
create index products_business_updated_idx on public.products (business_id, updated_at desc);
create index sales_business_sold_idx on public.sales (business_id, sold_at desc);
create index sale_items_business_sale_idx on public.sale_items (business_id, sale_id);
create index payment_requests_business_created_idx on public.payment_requests (business_id, created_at desc);

create or replace function public.is_business_member(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.business_memberships membership
    where membership.business_id = target_business_id
      and membership.user_id = auth.uid()
      and membership.status = 'active'
  );
$$;

create or replace function public.is_business_owner(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.business_memberships membership
    where membership.business_id = target_business_id
      and membership.user_id = auth.uid()
      and membership.role = 'owner'
      and membership.status = 'active'
  );
$$;

revoke all on function public.is_business_member(uuid) from public;
revoke all on function public.is_business_owner(uuid) from public;
grant execute on function public.is_business_member(uuid) to authenticated;
grant execute on function public.is_business_owner(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payment_requests enable row level security;
alter table public.payments enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;

create policy profiles_self_select on public.profiles for select to authenticated using (user_id = auth.uid());
create policy profiles_self_update on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy businesses_member_select on public.businesses for select to authenticated using (public.is_business_member(id));
create policy businesses_owner_update on public.businesses for update to authenticated using (public.is_business_owner(id)) with check (public.is_business_owner(id));

create policy memberships_member_select on public.business_memberships for select to authenticated using (public.is_business_member(business_id));
create policy memberships_owner_insert on public.business_memberships for insert to authenticated with check (public.is_business_owner(business_id));
create policy memberships_owner_update on public.business_memberships for update to authenticated using (public.is_business_owner(business_id)) with check (public.is_business_owner(business_id));
create policy memberships_owner_delete on public.business_memberships for delete to authenticated using (public.is_business_owner(business_id) and user_id <> auth.uid());

create policy plans_authenticated_select on public.plans for select to authenticated using (active = true);
create policy subscriptions_member_select on public.subscriptions for select to authenticated using (public.is_business_member(business_id));
create policy payment_requests_member_select on public.payment_requests for select to authenticated using (public.is_business_member(business_id));
create policy payment_requests_owner_insert on public.payment_requests for insert to authenticated with check (public.is_business_owner(business_id) and requested_by = auth.uid());
create policy payments_member_select on public.payments for select to authenticated using (public.is_business_member(business_id));

create policy products_member_select on public.products for select to authenticated using (public.is_business_member(business_id));
create policy products_member_insert on public.products for insert to authenticated with check (public.is_business_member(business_id));
create policy products_member_update on public.products for update to authenticated using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));
create policy products_owner_delete on public.products for delete to authenticated using (public.is_business_owner(business_id));

create policy sales_member_select on public.sales for select to authenticated using (public.is_business_member(business_id));
create policy sales_member_insert on public.sales for insert to authenticated with check (public.is_business_member(business_id) and cashier_id = auth.uid());
create policy sale_items_member_select on public.sale_items for select to authenticated using (public.is_business_member(business_id));
create policy sale_items_member_insert on public.sale_items for insert to authenticated with check (
  public.is_business_member(business_id)
  and exists (select 1 from public.sales sale where sale.id = sale_id and sale.business_id = business_id)
);

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.businesses to authenticated;
grant select, insert, update, delete on public.business_memberships to authenticated;
grant select on public.plans to authenticated;
grant select on public.subscriptions to authenticated;
grant select, insert on public.payment_requests to authenticated;
grant select on public.payments to authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, insert on public.sales to authenticated;
grant select, insert on public.sale_items to authenticated;

-- Account provisioning and payment confirmation will be implemented as server-side
-- functions. The browser must never be allowed to activate subscriptions or insert
-- confirmed payments directly.


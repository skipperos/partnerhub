-- Partner Hub V2: ADDITIVE migration. Run after 001_schema.sql. Existing accounts/sales untouched.
create table if not exists public.payment_offers (
 id uuid primary key default gen_random_uuid(),
 product_id uuid not null references public.products(id),
 code text not null check(code ~ '^[a-z0-9-]{2,70}$'),
 title text not null,
 amount_cents bigint not null check(amount_cents > 0),
 eligible_cents bigint not null check(eligible_cents >= 0 and eligible_cents <= amount_cents),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 active boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(product_id,code),
 unique(id,product_id)
);
alter table public.products add column if not exists payment_enabled boolean not null default false;
alter table public.products add column if not exists payment_return_url text;
create table if not exists public.payment_orders (
 id uuid primary key default gen_random_uuid(),
 product_id uuid not null references public.products(id),
 offer_id uuid not null,
 customer_email text not null,
 amount_cents bigint not null check(amount_cents > 0),
 eligible_cents bigint not null check(eligible_cents >= 0 and eligible_cents <= amount_cents),
 currency text not null,
 provider text not null default 'paystack',
 provider_mode text not null check(provider_mode in ('test','live')),
 provider_reference text not null unique,
 status text not null default 'pending' check(status in ('pending','paid','review','cancelled')),
 status_token_hash text not null,
 referral_code text,
 click_id uuid,
 sale_id uuid references public.sales(id),
 test_partner_id uuid references public.partner_profiles(user_id),
 test_commission_cents bigint,
 test_rate_bps integer,
 checkout_url text,
 paid_at timestamptz,
 failure_reason text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(offer_id,product_id) references public.payment_offers(id,product_id)
);
create index if not exists payment_orders_prod_idx on public.payment_orders(product_id,created_at desc);
create index if not exists payment_orders_status_idx on public.payment_orders(status,created_at);
create table if not exists public.payment_webhook_events (
 id uuid primary key default gen_random_uuid(),
 event_hash text not null unique,
 event_type text not null,
 provider_reference text,
 status text not null default 'pending' check(status in ('pending','processed','ignored','review')),
 last_error text,
 attempts integer not null default 0,
 received_at timestamptz not null default now(),
 processed_at timestamptz
);
create index if not exists payment_webhook_pending_idx on public.payment_webhook_events(status,received_at);
create table if not exists public.payment_fulfillments (
 order_id uuid primary key references public.payment_orders(id),
 status text not null default 'pending' check(status in ('pending','fulfilled')),
 fulfillment_reference text,
 fulfilled_at timestamptz,
 updated_at timestamptz not null default now()
);
-- Backend-only financial tables. Supabase browser roles cannot read/write them.
alter table public.payment_offers enable row level security;
alter table public.payment_orders enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.payment_fulfillments enable row level security;
revoke all on public.payment_offers,public.payment_orders,public.payment_webhook_events,public.payment_fulfillments from anon,authenticated;

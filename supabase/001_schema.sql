-- Partner Hub v1. Run once in Supabase SQL Editor. Auth users are managed by Supabase Auth.
create extension if not exists pgcrypto;

create table if not exists public.partner_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  role text not null default 'partner' check (role in ('partner','admin')),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,70}$'),
  name text not null,
  description text not null default '',
  website_url text not null,
  display_price_cents bigint not null default 0 check (display_price_cents >= 0),
  currency text not null default 'ZAR' check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default false,
  commission_bps integer not null default 2500 check (commission_bps between 0 and 10000),
  commission_mode text not null default 'one_time' check (commission_mode in ('one_time','recurring')),
  recurring_months integer check (recurring_months is null or recurring_months between 1 and 120),
  referral_days integer not null default 30 check (referral_days between 1 and 365),
  hold_days integer not null default 14 check (hold_days between 0 and 180),
  integration_key_hash text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_rules_audit (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  changed_by uuid not null references public.partner_profiles(user_id),
  previous_rule jsonb,
  next_rule jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.affiliate_links (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner_profiles(user_id),
  product_id uuid not null references public.products(id),
  code text not null unique,
  created_at timestamptz not null default now(),
  unique(partner_id, product_id)
);

create table if not exists public.referral_clicks (
  id uuid primary key,
  partner_id uuid not null references public.partner_profiles(user_id),
  product_id uuid not null references public.products(id),
  affiliate_link_id uuid not null references public.affiliate_links(id),
  commission_bps integer not null,
  commission_mode text not null check (commission_mode in ('one_time','recurring')),
  recurring_months integer,
  hold_days integer not null,
  clicked_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists referral_clicks_partner_idx on public.referral_clicks(partner_id, clicked_at desc);

create table if not exists public.referred_subscriptions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  external_subscription_id text not null,
  partner_id uuid not null references public.partner_profiles(user_id),
  click_id uuid not null references public.referral_clicks(id),
  commission_bps integer not null,
  recurring_months integer,
  hold_days integer not null,
  started_at timestamptz not null default now(),
  unique(product_id, external_subscription_id)
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  provider text not null,
  external_transaction_id text not null,
  kind text not null default 'initial' check (kind in ('initial','renewal')),
  external_subscription_id text,
  gross_cents bigint not null check (gross_cents >= 0),
  eligible_cents bigint not null check (eligible_cents >= 0),
  currency text not null,
  partner_id uuid references public.partner_profiles(user_id),
  click_id uuid references public.referral_clicks(id),
  status text not null default 'paid' check (status in ('paid','refunded')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  refunded_at timestamptz,
  unique(product_id, provider, external_transaction_id)
);
create index if not exists sales_partner_idx on public.sales(partner_id, created_at desc);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partner_profiles(user_id),
  currency text not null,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'draft' check (status in ('draft','paid','cancelled')),
  payment_reference text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  created_by uuid not null references public.partner_profiles(user_id)
);

create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null unique references public.sales(id),
  partner_id uuid not null references public.partner_profiles(user_id),
  product_id uuid not null references public.products(id),
  amount_cents bigint not null check (amount_cents >= 0),
  rate_bps integer not null,
  currency text not null,
  status text not null default 'pending' check (status in ('pending','approved','paid','reversed')),
  hold_until timestamptz not null,
  payout_id uuid references public.payouts(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  reversed_at timestamptz
);
create index if not exists commissions_partner_idx on public.commissions(partner_id, status, created_at desc);

-- When a refund arrives AFTER payout, the previously paid commission is a debit
-- to be offset against a future payout. Adjustments retain an audit trail.
create table if not exists public.partner_debits (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null unique references public.commissions(id),
  partner_id uuid not null references public.partner_profiles(user_id),
  currency text not null,
  amount_cents bigint not null check (amount_cents > 0),
  applied_cents bigint not null default 0 check (applied_cents >= 0 and applied_cents <= amount_cents),
  created_at timestamptz not null default now()
);
create table if not exists public.payout_debit_allocations (
  payout_id uuid not null references public.payouts(id),
  debit_id uuid not null references public.partner_debits(id),
  amount_cents bigint not null check (amount_cents > 0),
  primary key (payout_id, debit_id)
);
create table if not exists public.finance_events (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Backend-only database access. No browser access to finance tables.
alter table public.partner_profiles enable row level security;
alter table public.products enable row level security;
alter table public.product_rules_audit enable row level security;
alter table public.affiliate_links enable row level security;
alter table public.referral_clicks enable row level security;
alter table public.referred_subscriptions enable row level security;
alter table public.sales enable row level security;
alter table public.payouts enable row level security;
alter table public.commissions enable row level security;
alter table public.partner_debits enable row level security;
alter table public.payout_debit_allocations enable row level security;
alter table public.finance_events enable row level security;
-- No grants/policies to anon/authenticated. Render accesses using PostgreSQL database credentials.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ============================================================
-- 001_init.sql - Initial schema for EzyFusion Rentals
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
create table organizations (
  id   uuid primary key default gen_random_uuid(),
  name text not null
);

-- ============================================================
-- MEMBERSHIPS (staff/manager belong to an org)
-- ============================================================
create table memberships (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id  uuid not null references organizations(id) on delete cascade,
  role    text not null check (role in ('manager', 'staff')),
  unique (user_id)
);
create index memberships_org_id_idx on memberships(org_id);

-- ============================================================
-- UNITS
-- ============================================================
create table units (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name   text not null,
  unique (org_id, name)
);
create index units_org_id_idx on units(org_id);

-- ============================================================
-- TENANTS
-- ============================================================
create table tenants (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references organizations(id) on delete cascade,
  user_id   uuid unique references auth.users(id) on delete set null,
  full_name text not null,
  email     text not null,
  phone     text not null default ''
);
create index tenants_org_id_idx on tenants(org_id);
create index tenants_user_id_idx on tenants(user_id);

-- ============================================================
-- LEASES
-- ============================================================
create table leases (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  unit_id           uuid not null references units(id) on delete restrict,
  tenant_id         uuid not null references tenants(id) on delete restrict,
  start_date        date not null,
  end_date          date not null,
  monthly_rent_sen  bigint not null check (monthly_rent_sen > 0),
  deposit_sen       bigint not null check (deposit_sen >= 0),
  check (end_date >= start_date)
);
create index leases_org_id_idx on leases(org_id);
create index leases_unit_id_idx on leases(unit_id);
create index leases_tenant_id_idx on leases(tenant_id);

-- ============================================================
-- INVOICES
-- ============================================================
create table invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  lease_id     uuid not null references leases(id) on delete cascade,
  kind         text not null check (kind in ('deposit', 'rent')),
  period_index integer,
  period_start date,
  period_end   date,
  due_date     date not null,
  amount_sen   bigint not null check (amount_sen > 0)
);
create index invoices_org_id_idx on invoices(org_id);
create index invoices_lease_id_idx on invoices(lease_id);
create index invoices_due_date_idx on invoices(due_date);

-- ============================================================
-- GATEWAY BILLS
-- ============================================================
create table gateway_bills (
  id         text primary key,  -- cryptographically random, not UUID so it's hard to guess
  org_id     uuid not null references organizations(id) on delete cascade,
  lease_id   uuid not null references leases(id) on delete cascade,
  amount_sen bigint not null check (amount_sen > 0),
  status     text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  created_at timestamptz not null default now()
);
create index gateway_bills_org_id_idx on gateway_bills(org_id);
create index gateway_bills_lease_id_idx on gateway_bills(lease_id);

-- ============================================================
-- PAYMENTS
-- ============================================================
create table payments (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  lease_id         uuid not null references leases(id) on delete cascade,
  amount_sen       bigint not null check (amount_sen > 0),
  unapplied_sen    bigint not null default 0 check (unapplied_sen >= 0),
  method           text not null check (method in ('cash', 'bank_transfer', 'online')),
  status           text not null default 'pending_verification' check (status in ('pending_verification', 'approved', 'rejected', 'voided')),
  received_at      timestamptz not null,
  slip_path        text,
  gateway_bill_id  text references gateway_bills(id),
  created_at       timestamptz not null default now()
);
create index payments_org_id_idx on payments(org_id);
create index payments_lease_id_idx on payments(lease_id);
create index payments_status_idx on payments(status);
create index payments_received_at_idx on payments(received_at);

-- ============================================================
-- PAYMENT ALLOCATIONS
-- ============================================================
create table payment_allocations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  payment_id uuid not null references payments(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  amount_sen bigint not null check (amount_sen > 0),
  unique (payment_id, invoice_id)
);
create index payment_allocations_org_id_idx on payment_allocations(org_id);
create index payment_allocations_payment_id_idx on payment_allocations(payment_id);
create index payment_allocations_invoice_id_idx on payment_allocations(invoice_id);

-- ============================================================
-- AUDIT LOG (append-only enforced by RLS and trigger)
-- ============================================================
create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  actor_id   uuid not null,
  action     text not null,
  entity_id  uuid,
  details    jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_id_idx on audit_log(org_id);
create index audit_log_created_at_idx on audit_log(created_at);

-- Prevent DELETE and UPDATE on audit_log (makes it truly append-only)
create or replace function audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log rows are immutable';
end;
$$;

create trigger audit_log_no_delete
  before delete on audit_log
  for each row execute function audit_log_immutable();

create trigger audit_log_no_update
  before update on audit_log
  for each row execute function audit_log_immutable();

-- ============================================================
-- STORAGE: payment-slips bucket
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-slips',
  'payment-slips',
  false,  -- private bucket
  5242880, -- 5 MB
  array['image/jpeg', 'image/png', 'application/pdf']
)
on conflict (id) do nothing;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Helper function to get current user's org_id (for memberships)
create or replace function get_my_org_id()
returns uuid language sql stable security definer
set search_path = public
as $$
  select org_id from memberships where user_id = auth.uid()
$$;

-- Helper function to get current user's role
create or replace function get_my_role()
returns text language sql stable security definer
set search_path = public
as $$
  select role from memberships where user_id = auth.uid()
$$;

-- Helper function to get current user's tenant_id
create or replace function get_my_tenant_id()
returns uuid language sql stable security definer
set search_path = public
as $$
  select id from tenants where user_id = auth.uid()
$$;

-- Helper: is the current user a tenant?
create or replace function is_tenant()
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from tenants where user_id = auth.uid())
$$;

-- Helper: is the current user staff or manager?
create or replace function is_staff_or_manager()
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from memberships where user_id = auth.uid())
$$;

-- =====================
-- ORGANIZATIONS
-- =====================
alter table organizations enable row level security;

create policy "org members read own org" on organizations
  for select using (
    id = get_my_org_id()
    or id = (select org_id from tenants where user_id = auth.uid() limit 1)
  );

-- =====================
-- MEMBERSHIPS
-- =====================
alter table memberships enable row level security;

create policy "staff/manager read own org memberships" on memberships
  for select using (org_id = get_my_org_id());

-- =====================
-- UNITS
-- =====================
alter table units enable row level security;

create policy "staff/manager read own org units" on units
  for select using (org_id = get_my_org_id());

create policy "tenant read units of own leases" on units
  for select using (
    exists (
      select 1 from leases
      where leases.unit_id = units.id
        and leases.tenant_id = get_my_tenant_id()
    )
  );

-- =====================
-- TENANTS
-- =====================
alter table tenants enable row level security;

create policy "staff/manager read own org tenants" on tenants
  for select using (org_id = get_my_org_id());

create policy "tenant read own row" on tenants
  for select using (user_id = auth.uid());

create policy "tenant update own phone" on tenants
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =====================
-- LEASES
-- =====================
alter table leases enable row level security;

create policy "staff/manager read own org leases" on leases
  for select using (org_id = get_my_org_id());

create policy "tenant read own leases" on leases
  for select using (tenant_id = get_my_tenant_id());

-- =====================
-- INVOICES
-- =====================
alter table invoices enable row level security;

create policy "staff/manager read own org invoices" on invoices
  for select using (org_id = get_my_org_id());

create policy "tenant read own invoices" on invoices
  for select using (
    lease_id in (
      select id from leases where tenant_id = get_my_tenant_id()
    )
  );

-- =====================
-- PAYMENTS
-- =====================
alter table payments enable row level security;

create policy "staff/manager read own org payments" on payments
  for select using (org_id = get_my_org_id());

create policy "tenant read own payments" on payments
  for select using (
    lease_id in (
      select id from leases where tenant_id = get_my_tenant_id()
    )
  );

-- =====================
-- PAYMENT ALLOCATIONS
-- =====================
alter table payment_allocations enable row level security;

create policy "staff/manager read own org allocations" on payment_allocations
  for select using (org_id = get_my_org_id());

create policy "tenant read own allocations" on payment_allocations
  for select using (
    invoice_id in (
      select id from invoices where lease_id in (
        select id from leases where tenant_id = get_my_tenant_id()
      )
    )
  );

-- =====================
-- GATEWAY BILLS
-- =====================
alter table gateway_bills enable row level security;

create policy "staff/manager read own org bills" on gateway_bills
  for select using (org_id = get_my_org_id());

create policy "tenant read own bills" on gateway_bills
  for select using (
    lease_id in (
      select id from leases where tenant_id = get_my_tenant_id()
    )
  );

-- =====================
-- AUDIT LOG
-- =====================
alter table audit_log enable row level security;

create policy "manager read own org audit log" on audit_log
  for select using (
    org_id = get_my_org_id() and get_my_role() = 'manager'
  );

-- Prevent insert through Data API for everyone (service role only via server code)
-- No insert policy means Data API inserts are blocked.

-- ============================================================
-- STORAGE RLS POLICIES
-- ============================================================

-- Staff and managers of the same org can upload to <org_id>/...
create policy "staff_manager upload slips" on storage.objects
  for insert with check (
    bucket_id = 'payment-slips'
    and (storage.foldername(name))[1] = get_my_org_id()::text
    and get_my_role() in ('manager', 'staff')
  );

-- Staff and managers can read slips for their org
create policy "staff_manager read slips" on storage.objects
  for select using (
    bucket_id = 'payment-slips'
    and (storage.foldername(name))[1] = get_my_org_id()::text
    and get_my_role() in ('manager', 'staff')
  );

-- Allow delete for cleanup (when payment creation fails after upload)
create policy "staff_manager delete slips" on storage.objects
  for delete using (
    bucket_id = 'payment-slips'
    and (storage.foldername(name))[1] = get_my_org_id()::text
    and get_my_role() in ('manager', 'staff')
  );

-- ============================================================
-- GRANTS (Data API access for authenticated users)
-- Anon gets nothing. Only what's listed in the brief.
-- ============================================================

-- Remove any default privileges before granting the exact Data API access below.
revoke all on organizations, memberships, units, tenants, leases, invoices,
  payments, payment_allocations, gateway_bills, audit_log
  from anon, authenticated;

-- Grant read to authenticated (RLS will further restrict)
grant select on organizations to authenticated;
grant select on memberships to authenticated;
grant select on units to authenticated;
grant select on tenants to authenticated;
-- Allow tenant to update their phone
grant select, update (phone) on tenants to authenticated;
grant select on leases to authenticated;
grant select on invoices to authenticated;
grant select on payments to authenticated;
grant select on payment_allocations to authenticated;
grant select on gateway_bills to authenticated;
-- Managers only can read audit_log (enforced by RLS)
grant select on audit_log to authenticated;

-- Deny all writes through Data API (no insert/update/delete grants except tenant phone)
-- The grants above already don't include insert/update/delete for most tables.
-- For tenants, only phone update is granted (column-level).

-- Storage needs table privileges for its RLS policies to apply to authenticated users.
-- No anon privileges; policies above restrict staff/manager access to their org's files.
revoke all on storage.objects from anon, authenticated;
grant select, insert, delete on storage.objects to authenticated;

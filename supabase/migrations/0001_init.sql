-- BiT Affairs — core schema
-- Run this in the Supabase SQL editor, or via `supabase db push` with the CLI.
-- Mirrors the shapes already used in src/App.jsx (see buildEvents()) so the
-- eventual data-layer swap is mostly a 1:1 mapping.

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------
-- Organizations & planners
-- ---------------------------------------------------------------

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- One row per planner, keyed to their Supabase Auth user.
-- Created via a trigger on auth.users (see 0002_rls.sql) or manually on invite.
create table planners (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null unique,
  display_name text,
  role text not null default 'team' check (role in ('admin', 'team')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Events (projects) & client access
-- ---------------------------------------------------------------

create table events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  type text not null default 'Other',
  event_date text,
  venue text,
  status text not null default 'Early planning',
  client_name text,
  client_email text,
  budget_total numeric not null default 0,
  created_at timestamptz not null default now()
);

-- Clients authenticate as real Supabase Auth users (via magic link / OTP),
-- but their permission is scoped to exactly one event through this table —
-- not through being "a user with a dashboard". See BitAffairs-Auth-Spec.md.
create table client_access (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  client_user_id uuid references auth.users(id) on delete cascade,
  invited_email text not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, invited_email)
);

-- Which planners are assigned to which event (kept for future finer-grained
-- access; the initial RLS policy grants all org planners access to all org
-- events, matching the prototype's current behavior — see 0002_rls.sql).
create table event_members (
  event_id uuid not null references events(id) on delete cascade,
  planner_id uuid not null references planners(id) on delete cascade,
  member_role text not null default 'support' check (member_role in ('lead', 'support')),
  primary key (event_id, planner_id)
);

-- ---------------------------------------------------------------
-- Project content
-- ---------------------------------------------------------------

create table phases (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  title text not null,
  position int not null default 0
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  phase_id uuid not null references phases(id) on delete cascade,
  label text not null,
  done boolean not null default false,
  assignee text,
  position int not null default 0
);

-- One proposal per event. Status is the admin-approval gate:
--   draft -> pending_review -> sent -> approved
-- Enforced by a trigger, not just application code — see 0003_triggers.sql.
create table proposals (
  event_id uuid primary key references events(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'sent', 'approved', 'disapproved')),
  sent_at timestamptz,
  approved_at timestamptz,
  disapproved_at timestamptz
);

create table proposal_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  label text not null,
  qty int not null default 1,
  unit_cost numeric not null default 0
);

-- Same admin-gate pattern as proposals:
--   pending_review (internal) -> pending (client can see & stamp) -> approved
create table approvals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  label text not null,
  description text,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'pending', 'approved')),
  requested_at timestamptz not null default now(),
  approved_at timestamptz
);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  category text,
  contact text,
  phone text,
  cost numeric not null default 0,
  status text not null default 'inquiry' check (status in ('inquiry', 'pending', 'confirmed'))
);

create table budget_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  label text not null,
  planned numeric not null default 0,
  actual numeric not null default 0
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  author_type text not null check (author_type in ('planner', 'client', 'vendor')),
  author_name text not null,
  body text,
  image_url text,
  created_at timestamptz not null default now()
);

-- Helpful indexes for the lookups the app actually does
create index idx_events_org on events(organization_id);
create index idx_client_access_event on client_access(event_id);
create index idx_client_access_user on client_access(client_user_id);
create index idx_phases_event on phases(event_id);
create index idx_tasks_phase on tasks(phase_id);
create index idx_approvals_event on approvals(event_id);
create index idx_vendors_event on vendors(event_id);
create index idx_messages_event on messages(event_id);

-- Patch: lets an admin generate a short access code for a project that a
-- client can type in directly to reach their portal — no email required.
-- Existing magic-link email access (client_access.client_user_id) is
-- untouched; this adds a second, independent path alongside it.
--
-- Design: codes are redeemed into Supabase's built-in ANONYMOUS auth (a
-- real auth.users row with no email/password). Each redemption creates its
-- own row in client_code_sessions, so the same code can be used from
-- multiple devices without kicking earlier sessions out — unlike naively
-- overwriting a single "current session" pointer.
--
-- IMPORTANT — one manual dashboard step this SQL cannot do for you:
-- Supabase Authentication → Providers → enable "Anonymous Sign-ins" for
-- your project. Code login will fail until that's turned on.
--
-- Run this once in the Supabase SQL Editor on your existing project.

alter table client_access alter column invited_email drop not null;
alter table client_access add column if not exists invite_code text unique;
alter table client_access add column if not exists code_expires_at timestamptz;

create table if not exists client_code_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now()
);
alter table client_code_sessions enable row level security;

-- Extend the existing client-membership check to also recognize a
-- code-redeemed anonymous session, without touching any policy that
-- already calls is_event_client() elsewhere (approvals, proposals, etc. —
-- they all automatically gain code-login support through this one change).
create or replace function is_event_client(target_event_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from client_access ca
    where ca.event_id = target_event_id and ca.client_user_id = auth.uid()
  ) or exists (
    select 1 from client_code_sessions cs
    where cs.event_id = target_event_id and cs.user_id = auth.uid()
  );
$$;

-- Clients can see their own redeemed sessions (harmless, and lets the app
-- confirm "yes, this anonymous user is really attached to this event").
create policy "clients read own code sessions" on client_code_sessions
  for select using (user_id = auth.uid());

-- Planners can see (but not directly write) code sessions for their org's
-- events — useful for an admin to eventually see "3 devices have used this
-- code" without needing a separate audit feature.
create policy "planners read their org's code sessions" on client_code_sessions
  for select using (is_org_planner(event_id));

-- The ONLY way a row is ever written to client_code_sessions. Deliberately
-- no INSERT policy on the table itself for any role — everything must go
-- through this function, which validates the code and its expiry first.
-- SECURITY DEFINER means it runs with the owning role's privileges and is
-- not itself subject to RLS, which is what allows it to both read the
-- normally-locked-down client_access row and write the session row.
create or replace function redeem_client_code(p_code text)
returns uuid
language plpgsql
security definer
as $$
declare
  matched_event_id uuid;
begin
  select event_id into matched_event_id
  from client_access
  where invite_code = p_code
    and (code_expires_at is null or code_expires_at > now());

  if matched_event_id is null then
    raise exception 'Invalid or expired code';
  end if;

  insert into client_code_sessions (event_id, user_id)
  values (matched_event_id, auth.uid());

  return matched_event_id;
end;
$$;

-- Lets an admin generate/regenerate a code without hand-writing SQL each
-- time. Deliberately admin-only (mirrors the admin-gate pattern used
-- throughout this app) and generates a short, easy-to-read/type code.
create or replace function generate_client_code(p_event_id uuid, p_days_valid int default 30)
returns text
language plpgsql
security definer
as $$
declare
  new_code text;
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I — easy to read aloud
  i int;
  existing_id uuid;
begin
  if not (is_org_planner(p_event_id) and is_admin_planner()) then
    raise exception 'Only an admin can generate an access code';
  end if;

  new_code := '';
  for i in 1..8 loop
    new_code := new_code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;

  -- Postgres unique constraints don't treat two NULLs as equal, so a plain
  -- "on conflict" upsert can't be used here — look up any existing
  -- code-only row (invited_email is null) for this event explicitly instead.
  select id into existing_id from client_access
  where event_id = p_event_id and invited_email is null
  limit 1;

  if existing_id is not null then
    update client_access
    set invite_code = new_code, code_expires_at = now() + (p_days_valid || ' days')::interval
    where id = existing_id;
  else
    insert into client_access (event_id, invite_code, code_expires_at, invited_email)
    values (p_event_id, new_code, now() + (p_days_valid || ' days')::interval, null);
  end if;

  return new_code;
end;
$$;

-- Patch: fixes "infinite recursion detected in policy for relation planners"
-- Run this once in the Supabase SQL Editor on your existing project.
-- Safe to run even if some of these don't exist yet — the "drop ... if
-- exists" lines won't error either way.

drop policy if exists "planners can read their own organization" on organizations;
drop policy if exists "planners can read colleagues in their org" on planners;
drop policy if exists "planners read their org's events" on events;
drop policy if exists "planners insert events for their org" on events;
drop policy if exists "planners update their org's events" on events;

create or replace function my_organization_id()
returns uuid
language sql
security definer
stable
as $$
  select organization_id from planners where id = auth.uid();
$$;

create policy "planners can read their own organization"
  on organizations for select
  using (id = my_organization_id());

create policy "planners can read colleagues in their org"
  on planners for select
  using (organization_id = my_organization_id());

create policy "planners read their org's events"
  on events for select
  using (organization_id = my_organization_id());

create policy "planners insert events for their org"
  on events for insert
  with check (organization_id = my_organization_id());

create policy "planners update their org's events"
  on events for update
  using (organization_id = my_organization_id());

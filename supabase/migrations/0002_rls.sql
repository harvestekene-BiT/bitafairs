-- BiT Affairs — row level security
-- This is where "the client can only see their one event" and "planners
-- only see their own org's events" stop being UI behavior and become rules
-- the database itself enforces — the difference between a real permission
-- model and one that only looks like one.

-- ---------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------

-- Is the current authenticated user a planner in this event's organization?
create or replace function is_org_planner(target_event_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from planners p
    join events e on e.organization_id = p.organization_id
    where p.id = auth.uid()
      and e.id = target_event_id
  );
$$;

-- Is the current authenticated user an admin-role planner (any org)?
create or replace function is_admin_planner()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from planners p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- Is the current authenticated user the invited client for this event?
create or replace function is_event_client(target_event_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from client_access ca
    where ca.event_id = target_event_id
      and ca.client_user_id = auth.uid()
  );
$$;

-- The current authenticated planner's organization_id, or null if they
-- aren't one. SECURITY DEFINER is essential here: without it, any policy
-- that calls this function while protecting the planners table itself would
-- re-trigger that same policy recursively (Postgres detects this and fails
-- with "infinite recursion detected in policy for relation"). Running as
-- the function owner bypasses that recursive re-evaluation.
create or replace function my_organization_id()
returns uuid
language sql
security definer
stable
as $$
  select organization_id from planners where id = auth.uid();
$$;

-- ---------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------

alter table organizations enable row level security;
alter table planners enable row level security;
alter table events enable row level security;
alter table client_access enable row level security;
alter table event_members enable row level security;
alter table phases enable row level security;
alter table tasks enable row level security;
alter table proposals enable row level security;
alter table proposal_items enable row level security;
alter table approvals enable row level security;
alter table vendors enable row level security;
alter table budget_items enable row level security;
alter table messages enable row level security;

-- ---------------------------------------------------------------
-- Organizations & planners
-- ---------------------------------------------------------------

create policy "planners can read their own organization"
  on organizations for select
  using (id = my_organization_id());

create policy "planners can read colleagues in their org"
  on planners for select
  using (organization_id = my_organization_id());

-- ---------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------

create policy "planners read their org's events"
  on events for select
  using (organization_id = my_organization_id());

create policy "planners insert events for their org"
  on events for insert
  with check (organization_id = my_organization_id());

create policy "planners update their org's events"
  on events for update
  using (organization_id = my_organization_id());

create policy "admins delete their org's events"
  on events for delete
  using (organization_id = my_organization_id() and is_admin_planner());

create policy "clients read only their own event"
  on events for select
  using (is_event_client(id));

-- ---------------------------------------------------------------
-- Client access (invites) — planners manage, clients read their own row
-- ---------------------------------------------------------------

create policy "planners manage client invites for their events"
  on client_access for all
  using (is_org_planner(event_id))
  with check (is_org_planner(event_id));

create policy "clients read their own access row"
  on client_access for select
  using (client_user_id = auth.uid());

-- ---------------------------------------------------------------
-- Project content — same pattern repeated per table:
-- planners in the org can read/write; clients can only read, and only
-- rows belonging to their one event; vendors table is planner-only
-- (agencies typically don't expose raw vendor cost/contact to clients).
-- ---------------------------------------------------------------

create policy "planners manage phases" on phases for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));
create policy "clients read phases" on phases for select
  using (is_event_client(event_id));

create policy "planners read tasks"
  on tasks for select
  using (is_org_planner((select event_id from phases where phases.id = tasks.phase_id)));

create policy "planners update tasks"
  on tasks for update
  using (is_org_planner((select event_id from phases where phases.id = tasks.phase_id)))
  with check (is_org_planner((select event_id from phases where phases.id = tasks.phase_id)));

-- Admin-only: adding or removing tasks changes what the team is committed
-- to delivering, which stays under the same admin-approval spirit as
-- everything else in this app — team members can still work the tasks
-- (toggle done, reassign) via the update policy above.
create policy "admins insert tasks"
  on tasks for insert
  with check (
    is_org_planner((select event_id from phases where phases.id = tasks.phase_id))
    and is_admin_planner()
  );

create policy "admins delete tasks"
  on tasks for delete
  using (
    is_org_planner((select event_id from phases where phases.id = tasks.phase_id))
    and is_admin_planner()
  );
create policy "clients read tasks" on tasks for select
  using (is_event_client((select event_id from phases where phases.id = tasks.phase_id)));

create policy "planners manage proposals" on proposals for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));
-- Same principle as approvals below: draft and pending_review proposals are
-- invisible to the client at the query level, not just hidden in the UI.
create policy "clients read released proposals only" on proposals for select
  using (is_event_client(event_id) and status in ('sent', 'approved'));

create policy "planners manage proposal items" on proposal_items for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));
create policy "clients read released proposal items only" on proposal_items for select
  using (
    is_event_client(event_id)
    and exists (
      select 1 from proposals p
      where p.event_id = proposal_items.event_id
        and p.status in ('sent', 'approved')
    )
  );

create policy "planners manage approvals" on approvals for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));
-- Clients can only ever see approvals that have been released — the
-- 'pending_review' (internal) state is invisible to them at the query level,
-- not just hidden in the UI.
create policy "clients read released approvals only" on approvals for select
  using (is_event_client(event_id) and status <> 'pending_review');

create policy "planners manage vendors" on vendors for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));
-- No client policy on vendors at all — clients get zero rows, by default,
-- not by convention.

create policy "planners manage budget" on budget_items for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));
-- Deliberately no client policy on budget_items — the app never shows
-- planned-vs-actual internal budget figures to clients, only the proposal
-- total. Matching that in RLS means a client can never get these rows back
-- even if a future UI bug tried to query them.

create policy "planners manage messages" on messages for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));
create policy "clients read their event's messages" on messages for select
  using (is_event_client(event_id));
-- Insert only, not update/delete — a client can post as themselves but can
-- never edit or remove a message once sent, by the planner, a vendor, or
-- themselves. Full "for all" would have let them silently rewrite history.
create policy "clients post as themselves" on messages for insert
  with check (is_event_client(event_id) and author_type = 'client');

create policy "planners manage event_members" on event_members for all
  using (is_org_planner(event_id)) with check (is_org_planner(event_id));

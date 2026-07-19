-- BiT Affairs — let clients request a task
--
-- Clients can't insert directly into `tasks` (that's still admin-only, see
-- 0005_admin_controls.sql) — instead they drop a request here, an admin
-- reviews it, and either turns it into a real task on a phase (which goes
-- through the normal admin-only insert path) or dismisses it. This keeps
-- the same "client proposes, agency decides what actually lands on the
-- plan" shape as approvals and proposals elsewhere in this app.

create table task_requests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  label text not null,
  description text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'dismissed')),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Set only when approved — which task it became, so the client sees a
  -- link between what they asked for and what showed up on the checklist.
  resolved_task_id uuid references tasks(id) on delete set null
);

create index idx_task_requests_event on task_requests(event_id);

alter table task_requests enable row level security;

create policy "clients create task requests for their event"
  on task_requests for insert
  with check (is_event_client(event_id));

create policy "clients read their event's task requests"
  on task_requests for select
  using (is_event_client(event_id));

create policy "planners read task requests for their org"
  on task_requests for select
  using (is_org_planner(event_id));

-- Resolving a request (approve or dismiss) is an admin action, same as
-- every other "decide what the client sees" lever in this app — team
-- members can still see the queue, they just can't clear it themselves.
create policy "admins resolve task requests"
  on task_requests for update
  using (is_org_planner(event_id) and is_admin_planner())
  with check (is_org_planner(event_id) and is_admin_planner());

-- Enforced in Postgres, not just the UI: a request can only move from
-- 'pending' to 'approved' or 'dismissed', never backwards or sideways, and
-- resolved_at is stamped automatically rather than trusted from the client.
create or replace function enforce_task_request_transition()
returns trigger
language plpgsql
security definer
as $$
begin
  if old.status <> 'pending' then
    raise exception 'This request has already been resolved.';
  end if;
  if new.status not in ('approved', 'dismissed') then
    raise exception 'A task request can only be approved or dismissed.';
  end if;
  new.resolved_at := now();
  return new;
end;
$$;

create trigger trg_enforce_task_request_transition
  before update on task_requests
  for each row
  execute function enforce_task_request_transition();

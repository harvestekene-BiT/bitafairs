-- BiT Affairs — private tasks: admin-created, visible only to admins and
-- whichever team members the admin specifically appoints to it.
--
-- Every other task on a phase checklist is still visible to the whole org
-- team and the client (see 0001/0002). This adds a second class of task
-- that never reaches the client at all, and on the team side is invisible
-- to anyone not named on it — for things like a surprise element of the
-- event, a sensitive vendor issue, or anything the admin doesn't want on
-- the shared checklist.

alter table tasks
  add column visibility text not null default 'team' check (visibility in ('team', 'restricted'));

-- The appointed list for a restricted task. Empty/irrelevant for 'team'
-- tasks — visibility on those is governed entirely by org membership, same
-- as before this migration.
create table task_assignees (
  task_id uuid not null references tasks(id) on delete cascade,
  planner_id uuid not null references planners(id) on delete cascade,
  primary key (task_id, planner_id)
);

alter table task_assignees enable row level security;

-- Small helper so the tasks/task_assignees policies below don't each
-- repeat the phases join — mirrors the style of is_org_planner() etc. in
-- 0002_rls.sql.
create or replace function task_event_id(p_task_id uuid)
returns uuid
language sql
security definer
stable
as $$
  select phases.event_id from tasks join phases on phases.id = tasks.phase_id where tasks.id = p_task_id;
$$;

create or replace function can_see_restricted_task(p_task_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select is_admin_planner() or exists (
    select 1 from task_assignees ta where ta.task_id = p_task_id and ta.planner_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------
-- Replace the tasks policies from 0002_rls.sql with visibility-aware
-- versions. drop + recreate rather than alter, since Postgres has no
-- "alter policy using clause" shorthand.
-- ---------------------------------------------------------------

drop policy "planners read tasks" on tasks;
create policy "planners read tasks" on tasks for select
  using (
    is_org_planner((select event_id from phases where phases.id = tasks.phase_id))
    and (visibility = 'team' or can_see_restricted_task(tasks.id))
  );

drop policy "planners update tasks" on tasks;
create policy "planners update tasks" on tasks for update
  using (
    is_org_planner((select event_id from phases where phases.id = tasks.phase_id))
    and (visibility = 'team' or can_see_restricted_task(tasks.id))
  )
  with check (
    is_org_planner((select event_id from phases where phases.id = tasks.phase_id))
    and (visibility = 'team' or can_see_restricted_task(tasks.id))
  );

drop policy "clients read tasks" on tasks;
create policy "clients read tasks" on tasks for select
  using (
    is_event_client((select event_id from phases where phases.id = tasks.phase_id))
    and visibility = 'team'
  );

-- Insert/delete stay admin-only exactly as in 0005_admin_controls.sql —
-- visibility doesn't change who may create or remove a task, only who may
-- see or update an existing one.

-- ---------------------------------------------------------------
-- task_assignees — who admins have appointed to a restricted task.
-- Managing the list (add/remove appointees) is admin-only, same as
-- creating the task itself. Reading the list follows the same visibility
-- rule as the task it belongs to.
-- ---------------------------------------------------------------

create policy "admins manage task assignees"
  on task_assignees for all
  using (is_org_planner(task_event_id(task_assignees.task_id)) and is_admin_planner())
  with check (is_org_planner(task_event_id(task_assignees.task_id)) and is_admin_planner());

create policy "planners read task assignees for tasks they can see"
  on task_assignees for select
  using (
    is_org_planner(task_event_id(task_assignees.task_id))
    and can_see_restricted_task(task_assignees.task_id)
  );

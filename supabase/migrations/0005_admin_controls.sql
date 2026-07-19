-- Patch: admin-only project deletion, and admin-only task add/delete
-- (team members can still toggle a task's done/assignee — just not create
-- or remove tasks outright, and can never delete a project).
-- Run this once in the Supabase SQL Editor on your existing project.

-- Events currently have no DELETE policy at all, meaning nobody could
-- delete a project through the API regardless of role. Add one, admin-only.
create policy "admins delete their org's events"
  on events for delete
  using (organization_id = my_organization_id() and is_admin_planner());

-- Tasks previously had a single "for all" policy covering select/insert/
-- update/delete for any org planner. Split it so insert/delete require
-- admin, while select/update (toggling done, reassigning) stay open to the
-- whole team — that split can't be expressed in one USING/WITH CHECK clause,
-- so the original policy is replaced with four narrower ones.
drop policy if exists "planners manage tasks" on tasks;

create policy "planners read tasks"
  on tasks for select
  using (is_org_planner((select event_id from phases where phases.id = tasks.phase_id)));

create policy "planners update tasks"
  on tasks for update
  using (is_org_planner((select event_id from phases where phases.id = tasks.phase_id)))
  with check (is_org_planner((select event_id from phases where phases.id = tasks.phase_id)));

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

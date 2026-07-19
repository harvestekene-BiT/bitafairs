-- BiT Affairs — let clients see vendors and budget for their own event
--
-- 0002_rls.sql originally left these two tables planner-only on purpose
-- (agencies often don't want raw vendor cost/contact info or planned-vs-
-- actual budget figures visible to clients). This migration reverses that
-- choice: clients can now read (but never write) vendor and budget rows
-- for the one event they're scoped to — the same rows an admin sees,
-- read-only. Nothing about the planner-side policies changes.

create policy "clients read vendors for their event"
  on vendors for select
  using (is_event_client(event_id));

create policy "clients read budget items for their event"
  on budget_items for select
  using (is_event_client(event_id));

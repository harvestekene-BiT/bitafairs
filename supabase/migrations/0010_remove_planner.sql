-- BiT Affairs — let admins remove team members
--
-- Deleting a planner's row here does NOT delete their underlying Supabase
-- Auth account — an admin removing a teammate from the agency shouldn't
-- require the service-role key (unlike inviting, which creates an auth
-- user and does need it — see invite-planner). Removing the planners row
-- is enough: it's what every RLS policy in this app checks, so the moment
-- it's gone, that person's organization_id disappears too, and every
-- other table stops returning anything for them. If they try to sign in
-- again, getCurrentPlanner() returns null and the app shows "no Studio
-- access" — see the maybeSingle() change in supabaseClient.js.

create policy "admins delete planners in their org"
  on planners for delete
  using (organization_id = my_organization_id() and is_admin_planner());

-- Two rules enforced here, not just in the UI: an admin can never delete
-- their own row (no accidental self-lockout), and an organization can
-- never be left with zero admins (no one left able to manage the team).
create or replace function enforce_planner_deletion()
returns trigger
language plpgsql
security definer
as $$
declare
  remaining_admins int;
begin
  if old.id = auth.uid() then
    raise exception 'You cannot remove your own account — have another admin do it.';
  end if;

  if old.role = 'admin' then
    select count(*) into remaining_admins
    from planners
    where organization_id = old.organization_id
      and role = 'admin'
      and id <> old.id;
    if remaining_admins = 0 then
      raise exception 'Cannot remove the last admin in an organization.';
    end if;
  end if;

  return old;
end;
$$;

create trigger trg_enforce_planner_deletion
  before delete on planners
  for each row
  execute function enforce_planner_deletion();

-- BiT Affairs — let the disapproval stamp work on milestone approvals too,
-- not just proposals.
--
-- Proposals got approve/disapprove in 0006_disapproval.sql; approvals never
-- did — a client could only stamp "approved" on a released approval
-- request, with no way to say "not yet" and no state to represent it. This
-- brings approvals to parity: pending -> approved OR disapproved, and an
-- admin can re-release a disapproved request back to the client once it's
-- been addressed (reusing the same "Release to client" action that already
-- moves pending_review -> pending).

alter table approvals add column if not exists disapproved_at timestamptz;

alter table approvals drop constraint if exists approvals_status_check;
alter table approvals add constraint approvals_status_check
  check (status in ('pending_review', 'pending', 'approved', 'disapproved'));

create or replace function enforce_approval_transition()
returns trigger
language plpgsql
security definer
as $$
declare
  caller_is_admin boolean := is_org_planner(new.event_id) and is_admin_planner();
  caller_is_client boolean := is_event_client(new.event_id);
begin
  if caller_is_client then
    if old.status <> 'pending' or new.status not in ('approved', 'disapproved') then
      raise exception 'Clients may only approve or disapprove a released approval request';
    end if;
    if new.status = 'approved' then
      new.approved_at := now();
      new.disapproved_at := null;
    else
      new.disapproved_at := now();
      new.approved_at := null;
    end if;

  elsif caller_is_admin then
    if not (old.status in ('pending_review', 'disapproved') and new.status = 'pending') then
      raise exception 'Invalid approval transition for admin: % -> %', old.status, new.status;
    end if;

  else
    -- Team members (and anyone else) cannot change approval status at all
    -- once created — only request new ones.
    raise exception 'Not authorized to change this approval''s status';
  end if;

  return new;
end;
$$;
-- create trigger not needed — trg_approval_transition from 0003_triggers.sql
-- already points at this function name and picks up the new body via
-- `create or replace` above.

-- Patch: adds a "disapproved" proposal state, lets clients disapprove (not
-- just approve) a sent proposal, and makes both approved and disapproved
-- proposals editable again — with editing an approved proposal
-- automatically pulling it back into the admin-review pipeline, since a
-- changed proposal is no longer the thing the client actually agreed to.
-- Run this once in the Supabase SQL Editor on your existing project.

alter table proposals add column if not exists disapproved_at timestamptz;

alter table proposals drop constraint if exists proposals_status_check;
alter table proposals add constraint proposals_status_check
  check (status in ('draft', 'pending_review', 'sent', 'approved', 'disapproved'));

-- Replaces the whole state-machine trigger from 0003_triggers.sql with an
-- extended version. Same shape, three new allowances:
--   1. Clients can now transition sent -> disapproved (previously only
--      sent -> approved).
--   2. Team members AND admins can transition approved -> pending_review —
--      this is what the proposal_items trigger below relies on to safely
--      pull an edited, previously-approved proposal back through review,
--      regardless of who made the edit.
--   3. draft OR disapproved can be submitted for review (resubmission
--      after a client disapproval reuses the same "submit for review" flow
--      as an initial draft).
create or replace function enforce_proposal_transition()
returns trigger
language plpgsql
security definer
as $$
declare
  caller_is_admin boolean := is_org_planner(new.event_id) and is_admin_planner();
  caller_is_team boolean := is_org_planner(new.event_id) and not is_admin_planner();
  caller_is_client boolean := is_event_client(new.event_id);
begin
  if caller_is_client then
    if old.status <> 'sent' or new.status not in ('approved', 'disapproved') then
      raise exception 'Clients may only approve or disapprove a proposal that has already been sent to them';
    end if;
    if new.status = 'approved' then
      new.approved_at := now();
      new.disapproved_at := null;
    else
      new.disapproved_at := now();
      new.approved_at := null;
    end if;

  elsif caller_is_admin then
    if not (
      (old.status in ('draft', 'pending_review', 'disapproved') and new.status = 'sent') or
      (old.status = 'pending_review' and new.status = 'draft') or
      (old.status = 'approved' and new.status = 'pending_review')
    ) then
      raise exception 'Invalid proposal transition for admin: % -> %', old.status, new.status;
    end if;
    if new.status = 'sent' then
      new.sent_at := now();
    end if;

  elsif caller_is_team then
    if not (
      (old.status in ('draft', 'disapproved') and new.status = 'pending_review') or
      (old.status = 'approved' and new.status = 'pending_review')
    ) then
      raise exception 'Team members may only submit a draft or disapproved proposal for admin review';
    end if;

  else
    raise exception 'Not authorized to modify this proposal';
  end if;

  return new;
end;
$$;

-- Automatically pulls an approved proposal back to pending_review the
-- moment any of its line items change — before/during/after edit, the
-- client should never be looking at "approved" next to terms they never
-- actually saw. Runs regardless of whether the editor is a team member or
-- an admin, reusing the "approved -> pending_review" allowance added above.
create or replace function revert_proposal_on_item_change()
returns trigger
language plpgsql
security definer
as $$
declare
  affected_event_id uuid;
  current_status text;
begin
  affected_event_id := coalesce(new.event_id, old.event_id);
  select status into current_status from proposals where event_id = affected_event_id;
  if current_status = 'approved' then
    update proposals set status = 'pending_review' where event_id = affected_event_id;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_revert_proposal_on_item_change on proposal_items;
create trigger trg_revert_proposal_on_item_change
  after insert or update or delete on proposal_items
  for each row
  execute function revert_proposal_on_item_change();

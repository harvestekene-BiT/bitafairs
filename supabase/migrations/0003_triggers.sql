-- BiT Affairs — server-side enforcement of the admin-approval gate
--
-- This is the part that actually matters for "strengthening" the feature
-- built earlier: in the app today, "only Admins can release work to
-- clients" is enforced by which buttons render. That's fine for UX, but
-- anyone calling the API directly (or editing browser state) could ignore
-- it. These triggers make the rule real: Postgres itself will reject an
-- illegal status transition, no matter what called it or how.

-- ---------------------------------------------------------------
-- Proposals: draft -> pending_review -> sent -> approved
-- ---------------------------------------------------------------

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

create trigger trg_proposal_transition
  before update on proposals
  for each row
  execute function enforce_proposal_transition();

-- Automatically pulls an approved proposal back to pending_review the
-- moment any of its line items change, regardless of who edited them —
-- the client should never see "approved" next to terms they never saw.
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

create trigger trg_revert_proposal_on_item_change
  after insert or update or delete on proposal_items
  for each row
  execute function revert_proposal_on_item_change();

-- ---------------------------------------------------------------
-- Approvals: pending_review (internal) -> pending (client-visible) -> approved
-- ---------------------------------------------------------------

-- On creation: only an admin may create an approval request that's already
-- client-visible ('pending'). Everyone else's requests start internal,
-- regardless of what status value they tried to send — this closes the
-- obvious bypass of "just send status: 'pending' in the insert payload".
create or replace function enforce_approval_insert()
returns trigger
language plpgsql
security definer
as $$
begin
  if not (is_org_planner(new.event_id) and is_admin_planner()) then
    new.status := 'pending_review';
  end if;
  return new;
end;
$$;

create trigger trg_approval_insert
  before insert on approvals
  for each row
  execute function enforce_approval_insert();

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
    if old.status <> 'pending' or new.status <> 'approved' then
      raise exception 'Clients may only approve a released approval request';
    end if;
    new.approved_at := now();

  elsif caller_is_admin then
    if not (old.status = 'pending_review' and new.status = 'pending') then
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

create trigger trg_approval_transition
  before update on approvals
  for each row
  execute function enforce_approval_transition();

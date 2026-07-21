-- BiT Affairs — fix: "Reset to draft" silently did nothing for a sent,
-- approved, or disapproved proposal.
--
-- The button in ProposalView is shown whenever status !== 'draft' (see
-- src/App.jsx), but enforce_proposal_transition only ever let an admin
-- reset from 'pending_review'. Clicking Reset on a proposal that was
-- already sent to the client — the exact case where an admin most wants
-- to pull it back, edit it, and resend — hit the trigger's exception,
-- which the caller only logs to the console: nothing visibly happened,
-- which is exactly the bug report this fixes.

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
      (old.status = 'approved' and new.status = 'pending_review') or
      -- The actual fix: any non-draft status can be reset back to draft
      -- for editing, not just pending_review. Matches the button's real
      -- UI condition (shown whenever status !== 'draft') instead of a
      -- narrower rule the UI never actually respected.
      (old.status <> 'draft' and new.status = 'draft')
    ) then
      raise exception 'Invalid proposal transition for admin: % -> %', old.status, new.status;
    end if;
    if new.status = 'sent' then
      new.sent_at := now();
    end if;
    if new.status = 'draft' then
      -- Clean slate — a resurfacing stale "sent 3 weeks ago" timestamp on
      -- a proposal that's since been edited and is about to be resent
      -- would be actively misleading, both to whoever reads it internally
      -- and (once resent) to the client.
      new.sent_at := null;
      new.approved_at := null;
      new.disapproved_at := null;
    end if;

  elsif caller_is_team then
    if not (
      (old.status in ('draft', 'disapproved') and new.status = 'pending_review') or
      (old.status = 'approved' and new.status = 'pending_review')
    ) then
      raise exception 'Team members may only submit a draft or disapproved proposal for admin review';
    end if;

  else
    raise exception 'Not authorized to change this proposal''s status';
  end if;

  return new;
end;
$$;

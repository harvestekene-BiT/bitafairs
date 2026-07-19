-- BiT Affairs — fix: the client's approve/disapprove actions on proposals
-- and approvals were never actually reachable.
--
-- Both tables had a client SELECT policy and a state-machine trigger that
-- assumed clients could UPDATE these rows, but no RLS policy ever granted
-- clients UPDATE at all — only "planners manage proposals" / "planners
-- manage approvals", both scoped to is_org_planner. Postgres RLS filters
-- rows to zero before a trigger ever runs, so every client approve/
-- disapprove call has been silently updating 0 rows since 0006 and 0013
-- were written. The fix is the same shape as everywhere else in this app:
-- grant the UPDATE at the RLS layer, let the existing BEFORE UPDATE
-- triggers (enforce_proposal_transition / enforce_approval_transition)
-- keep doing the actual state-machine validation.

create policy "clients update their event's proposal"
  on proposals for update
  using (is_event_client(event_id))
  with check (is_event_client(event_id));

create policy "clients update their event's approvals"
  on approvals for update
  using (is_event_client(event_id))
  with check (is_event_client(event_id));

-- Second, related gap: 0006_disapproval.sql added the 'disapproved' status
-- to proposals but never added it to the client-facing SELECT policies, so
-- a disapproved proposal would vanish from the client's own query — the
-- portal would show a blank draft instead of "you requested changes".
-- (approvals didn't have this problem — its client SELECT policy is
-- "status <> 'pending_review'", which already covered 'disapproved'.)

drop policy "clients read released proposals only" on proposals;
create policy "clients read released proposals only" on proposals for select
  using (is_event_client(event_id) and status in ('sent', 'approved', 'disapproved'));

drop policy "clients read released proposal items only" on proposal_items;
create policy "clients read released proposal items only" on proposal_items for select
  using (
    is_event_client(event_id)
    and exists (
      select 1 from proposals p
      where p.event_id = proposal_items.event_id
        and p.status in ('sent', 'approved', 'disapproved')
    )
  );

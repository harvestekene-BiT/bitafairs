-- BiT Affairs — real phone push notifications (PWA + Web Push).
--
-- This migration only sets up push_subscriptions: where each browser's
-- push endpoint gets stored once someone grants notification permission
-- (see the client-side subscribe flow in src/App.jsx and
-- src/lib/supabaseClient.js).
--
-- The other half — actually calling the send-push Edge Function whenever
-- a message/proposal/approval changes — is deliberately NOT done here as
-- a hand-written SQL trigger. Supabase has a purpose-built, officially
-- supported feature for exactly this ("Database Webhooks", under
-- Database → Webhooks in the dashboard) that does the same underlying
-- thing (a trigger calling out via pg_net) without a custom secrets table
-- or any SQL to get exactly right — see the "Push notifications" section
-- of README.md for the three webhooks to create there.

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one of these is set: a planner's own subscription (org-wide —
  -- matches how messages/proposals/approvals visibility already works for
  -- planners, see 0002_rls.sql), or a client's, scoped to their one event.
  planner_id uuid references planners(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  constraint push_subscriptions_owner_check check (
    (planner_id is not null and event_id is null) or (planner_id is null and event_id is not null)
  )
);

create index idx_push_subscriptions_planner on push_subscriptions(planner_id);
create index idx_push_subscriptions_event on push_subscriptions(event_id);

alter table push_subscriptions enable row level security;

create policy "planners manage their own push subscriptions"
  on push_subscriptions for all
  using (planner_id = auth.uid())
  with check (planner_id = auth.uid());

create policy "clients manage their own event's push subscriptions"
  on push_subscriptions for all
  using (event_id is not null and is_event_client(event_id))
  with check (event_id is not null and is_event_client(event_id));

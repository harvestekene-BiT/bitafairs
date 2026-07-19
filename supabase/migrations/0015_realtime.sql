-- BiT Affairs — turn on live updates for proposals, approvals, messages,
-- and task requests, so neither side of the app needs a manual refresh to
-- see the other side's activity.
--
-- Supabase's `supabase_realtime` publication starts empty — a table's
-- changes aren't broadcast to anyone until it's added here, regardless of
-- what RLS policies exist on it. Realtime "Postgres Changes" subscriptions
-- do respect the table's existing RLS SELECT policies per connected user
-- (Supabase has broadcast this way since the 2021 Realtime RLS update) —
-- so turning this on doesn't loosen who can see what: a client's live
-- subscription still only ever receives rows their existing SELECT
-- policies already allow, same as a normal query. This is purely "deliver
-- the same permitted rows immediately" rather than "on next page load".
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table proposals;
alter publication supabase_realtime add table approvals;
alter publication supabase_realtime add table task_requests;

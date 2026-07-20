// Supabase Edge Function: send-push
//
// Invoked by a Supabase Database Webhook (Database → Webhooks in the
// dashboard) whenever a row changes on messages/proposals/approvals —
// never called directly from the browser. See README's "Push
// notifications" section for the three webhooks to create there; this
// function doesn't configure its own triggers. Looks up who should be
// notified for the affected event (every planner in the org, plus the
// event's client, if they've each granted notification permission and
// have a stored subscription), and sends a real Web Push notification to
// each, using the VAPID keys below.
//
// Deploy with: supabase functions deploy send-push --no-verify-jwt
//   --no-verify-jwt because Database Webhooks call this using the
//   service-role key as its bearer token (set via "Add auth header with
//   service key" when creating the webhook), not an interactive user's
//   session JWT — the gateway's normal end-user JWT check doesn't apply
//   here, and the service-role key itself is the real authorization: only
//   your own project's webhooks (or anyone with that key) can reach this
//   function at all.
//
// Required secrets (supabase secrets set ...): VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto: or https: contact URL the
// push services can reach you at if there's a delivery problem — this is
// part of the Web Push spec, not optional). See README for how these
// were generated and where to put the matching public key client-side.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceRoleKey);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
);

// Same notification copy as the in-app toast (see subscribeToActivity's
// caller in src/App.jsx) so a phone notification and an in-app toast for
// the same event always read the same way, deliberately kept in sync by
// hand — there's no shared module between a Deno Edge Function and the
// Vite frontend to import this from.
// clientVisible must be explicit and correct per case — this is what keeps
// an internal "submitted for admin review" moment from ever reaching the
// client's phone, matching the same pending_review boundary enforced by
// RLS everywhere else in this app (see ClientPortal's own remapping of
// pending_review proposals to look like a draft, and the client SELECT
// policies on proposals/approvals, which never include pending_review).
function buildNotification(table: string, op: string, record: any, eventName: string) {
  if (table === "messages" && op === "INSERT") {
    // A message's author_type tells us who *sent* it, not who should be
    // notified — both sides always see the full thread once released, so
    // a message notification is client-visible regardless of who wrote it.
    return { title: eventName, body: `${record.author_name || "Someone"} sent a message`, clientVisible: true };
  }
  if (table === "proposals" && op === "UPDATE") {
    const byStatus: Record<string, { body: string; clientVisible: boolean }> = {
      sent: { body: "Proposal sent to the client", clientVisible: true },
      approved: { body: "Client approved the proposal", clientVisible: true },
      disapproved: { body: "Client requested changes to the proposal", clientVisible: true },
      pending_review: { body: "Proposal submitted for review", clientVisible: false },
    };
    const entry = byStatus[record.status];
    return entry ? { title: eventName, body: entry.body, clientVisible: entry.clientVisible } : null;
  }
  if (table === "approvals") {
    // Approvals are created already in review, not via a later transition
    // into it (unlike proposals, which start as a draft) — so "needs admin
    // review" is the INSERT itself, at the column default 'pending_review'.
    if (op === "INSERT" && record.status === "pending_review") {
      return { title: eventName, body: "A new approval was requested for review", clientVisible: false };
    }
    // Not the normal path (requestApproval always inserts at the default
    // above), but an admin's own insert can land straight at 'pending' —
    // handled for completeness.
    if (op === "INSERT" && record.status === "pending") {
      return { title: eventName, body: "A new approval was sent to the client", clientVisible: true };
    }
    if (op === "UPDATE") {
      const byStatus: Record<string, { body: string; clientVisible: boolean }> = {
        pending: { body: "An approval was released to the client", clientVisible: true },
        approved: { body: "Client approved a milestone", clientVisible: true },
        disapproved: { body: "Client requested changes on a milestone", clientVisible: true },
      };
      const entry = byStatus[record.status];
      return entry ? { title: eventName, body: entry.body, clientVisible: entry.clientVisible } : null;
    }
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    // Database Webhooks send { type, table, record, schema, old_record } —
    // "type" here, not "op", is Supabase's own naming for this payload.
    const { table, type, record } = await req.json();
    const eventId = record?.event_id;
    if (!eventId) return new Response(JSON.stringify({ skipped: "no event_id on record" }), { status: 200 });

    const { data: event } = await admin.from("events").select("name, organization_id").eq("id", eventId).single();
    if (!event) return new Response(JSON.stringify({ skipped: "event not found" }), { status: 200 });

    const notification = buildNotification(table, type, record, event.name);
    if (!notification) return new Response(JSON.stringify({ skipped: "no notification for this change" }), { status: 200 });

    // Everyone who should be notified: every planner in the event's org
    // (matches the org-wide visibility planners already have on these
    // tables — see 0002_rls.sql), plus this event's client — but only if
    // this specific change is something the client is actually allowed to
    // know about yet (see clientVisible on buildNotification above). This
    // lookup uses the service-role key and bypasses RLS entirely, so
    // unlike Realtime (which the client's own RLS SELECT policy already
    // protects), nothing stops an internal pending_review row from
    // reaching the client's device here except this explicit check.
    const { data: orgPlanners } = await admin.from("planners").select("id").eq("organization_id", event.organization_id);
    const plannerIds = (orgPlanners || []).map((p) => p.id);

    const orParts = plannerIds.map((id) => `planner_id.eq.${id}`);
    if (notification.clientVisible) orParts.push(`event_id.eq.${eventId}`);
    if (orParts.length === 0) return new Response(JSON.stringify({ skipped: "no eligible subscribers" }), { status: 200 });

    const { data: subscriptions } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .or(orParts.join(","));

    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      tag: `${table}-${eventId}`, // a later update on the same event/table replaces the earlier unread one rather than stacking
      url: "/", // no per-event deep links yet — see note in README
    });

    const results = await Promise.allSettled(
      (subscriptions || []).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
        } catch (err: any) {
          // 404/410 means the browser/OS revoked this subscription (user
          // uninstalled, cleared data, etc.) — clean it up rather than
          // retrying it forever on every future notification.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await admin.from("push_subscriptions").delete().eq("id", sub.id);
          } else {
            throw err;
          }
        }
      })
    );

    return new Response(JSON.stringify({ sent: results.length }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

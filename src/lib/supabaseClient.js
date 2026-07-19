// Supabase client wrapper for BiT Affairs.
//
// IMPORTANT: this file only ever uses the public "anon" key, which is safe
// to ship to the browser — every query it makes is still filtered by the
// RLS policies in supabase/migrations/0002_rls.sql. It never uses the
// service-role key, which must never appear in frontend code (see the
// invite-client Edge Function for the one operation that needs it).
//
// App.jsx calls every function in this file directly — there is no local
// fallback mode. If VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY aren't set,
// App.jsx shows a "Backend not configured" screen instead of using this
// file at all (see supabaseConfigured below).

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;

// Whether a real backend is actually configured. App.jsx checks this before
// rendering anything else — createClient() throws immediately if given an
// empty URL/key, so we must not call it at all until we know both are present.
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = supabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null;

if (!supabaseConfigured && typeof window !== "undefined") {
  console.warn(
    "Supabase env vars are not set — BiT Affairs cannot run without a " +
    "connected backend. Copy .env.example to .env and fill in your " +
    "project's URL and anon key. See README.md for full setup steps."
  );
}

function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase is not configured — see .env.example.");
  }
  return supabase;
}

/* ---------------- Planner auth ---------------- */

export async function signInPlanner(email, password) {
  const { data, error } = await requireSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw error;
}

export async function getCurrentPlanner() {
  const { data: { user } } = await requireSupabase().auth.getUser();
  if (!user) return null;
  // maybeSingle, not single — a planner removed by an admin (see removePlanner
  // below) has no row here anymore, and that must come back as null, not a
  // thrown "no rows" Postgres error, so the caller's own "no planner profile"
  // message is what the person actually sees.
  const { data, error } = await requireSupabase().from("planners").select("*").eq("id", user.id).maybeSingle();
  if (error) throw error;
  return data; // includes .role ('admin' | 'team') and .organization_id
}

/* ---------------- Client auth (magic link, no password) ---------------- */

export async function requestClientMagicLink(email) {
  // Sends a real email via Supabase Auth. redirectTo should be the deployed
  // app URL — Supabase Auth settings must have this URL allow-listed.
  const { error } = await requireSupabase().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function getCurrentClientEvent() {
  const { data: { user } } = await requireSupabase().auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("client_access")
    .select("event_id")
    .eq("client_user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (data?.event_id) return data.event_id;

  // Not a magic-link client — check if this is an anonymous session that
  // redeemed an access code instead (see 0008_client_code_login.sql).
  const { data: codeSession, error: codeError } = await supabase
    .from("client_code_sessions")
    .select("event_id")
    .eq("user_id", user.id)
    .order("redeemed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (codeError) throw codeError;
  return codeSession?.event_id ?? null;
}

/* ---------------- Events ---------------- */

// RLS does the real filtering here — a planner only ever gets their org's
// events back, a client only ever gets their own single event.
export async function fetchEvents() {
  const { data, error } = await requireSupabase().from("events").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function fetchEventDetail(eventId) {
  const [phases, tasks, proposal, proposalItems, approvals, vendors, budgetItems, messages, members, taskRequests] = await Promise.all([
    requireSupabase().from("phases").select("*").eq("event_id", eventId).order("position"),
    requireSupabase().from("tasks").select("*").in(
      "phase_id",
      (await requireSupabase().from("phases").select("id").eq("event_id", eventId)).data?.map((p) => p.id) ?? []
    ),
    requireSupabase().from("proposals").select("*").eq("event_id", eventId).maybeSingle(),
    requireSupabase().from("proposal_items").select("*").eq("event_id", eventId),
    requireSupabase().from("approvals").select("*").eq("event_id", eventId).order("requested_at"),
    requireSupabase().from("vendors").select("*").eq("event_id", eventId), // clients can read these too — see 0009_client_vendors_budget.sql
    requireSupabase().from("budget_items").select("*").eq("event_id", eventId), // clients can read these too — see 0009_client_vendors_budget.sql
    requireSupabase().from("messages").select("*").eq("event_id", eventId).order("created_at"),
    // planner_id is required here (not just email/display_name) so the UI
    // can appoint specific people to a restricted task — see task_assignees.
    requireSupabase().from("event_members").select("planner_id, member_role, planners(email, display_name)").eq("event_id", eventId),
    // Empty for team members, planner-and-up + client-owned rows only —
    // see 0011_client_task_requests.sql.
    requireSupabase().from("task_requests").select("*").eq("event_id", eventId).order("requested_at", { ascending: false }),
  ]);

  // task_assignees isn't scoped by event_id directly (it hangs off tasks),
  // so fetch it keyed to the task ids we actually got back — RLS still
  // filters this to rows the caller is allowed to see either way.
  const taskIds = (tasks.data ?? []).map((t) => t.id);
  const taskAssignees = taskIds.length
    ? await requireSupabase().from("task_assignees").select("task_id, planner_id").in("task_id", taskIds)
    : { data: [] };

  return {
    phases: phases.data ?? [],
    tasks: tasks.data ?? [],
    proposal: proposal.data ?? null,
    proposalItems: proposalItems.data ?? [],
    approvals: approvals.data ?? [],
    vendors: vendors.data ?? [],
    budgetItems: budgetItems.data ?? [],
    messages: messages.data ?? [],
    members: members.data ?? [],
    taskRequests: taskRequests.data ?? [],
    taskAssignees: taskAssignees.data ?? [],
  };
}

/* ---------------- Mutations (RLS + triggers enforce who can do what) ---------------- */

export async function toggleTask(taskId, done) {
  const { error } = await requireSupabase().from("tasks").update({ done }).eq("id", taskId);
  if (error) throw error;
}

export async function submitProposalForReview(eventId) {
  const { error } = await requireSupabase().from("proposals").update({ status: "pending_review" }).eq("event_id", eventId);
  if (error) throw error; // trigger rejects this unless caller is a team member on a draft
}

export async function approveAndSendProposal(eventId) {
  const { error } = await requireSupabase().from("proposals").update({ status: "sent" }).eq("event_id", eventId);
  if (error) throw error; // trigger rejects this unless caller is an admin
}

export async function rejectProposalToDraft(eventId) {
  const { error } = await requireSupabase().from("proposals").update({ status: "draft" }).eq("event_id", eventId);
  if (error) throw error; // trigger rejects this unless caller is an admin
}

export async function clientApproveProposal(eventId) {
  const { error } = await requireSupabase().from("proposals").update({ status: "approved" }).eq("event_id", eventId);
  if (error) throw error; // trigger rejects this unless caller is the invited client and status is 'sent'
}

export async function clientDisapproveProposal(eventId) {
  const { error } = await requireSupabase().from("proposals").update({ status: "disapproved" }).eq("event_id", eventId);
  if (error) throw error; // trigger rejects this unless caller is the invited client and status is 'sent'
}

export async function requestApproval(eventId, label, description) {
  // Trigger forces status to 'pending_review' unless the caller is an admin.
  const { error } = await requireSupabase().from("approvals").insert({ event_id: eventId, label, description });
  if (error) throw error;
}

export async function releaseApprovalToClient(approvalId) {
  const { error } = await requireSupabase().from("approvals").update({ status: "pending" }).eq("id", approvalId);
  if (error) throw error; // trigger rejects this unless caller is an admin
}

export async function clientApproveMilestone(approvalId) {
  const { error } = await requireSupabase().from("approvals").update({ status: "approved" }).eq("id", approvalId);
  if (error) throw error; // trigger rejects this unless caller is the invited client and status is 'pending'
}

/* ---------------- Realtime ---------------- */
// See 0015_realtime.sql for enabling this on the Postgres side.

// One always-on subscription covering messages, proposals, approvals, and
// task_requests. No event_id filter is needed: Realtime evaluates each
// table's existing RLS SELECT policy per connected user on every change,
// so a planner only ever receives rows for their org's events and a
// client only ever receives rows for their one event — same scoping as a
// normal query, just pushed immediately instead of waiting for the next
// fetch. Returns an unsubscribe function.
export function subscribeToActivity(onChange) {
  const tables = ["messages", "proposals", "approvals", "task_requests"];
  let channel = requireSupabase().channel("bitaffairs-activity");
  for (const table of tables) {
    channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => onChange(table, payload));
  }
  channel.subscribe();
  return () => requireSupabase().removeChannel(channel);
}

export async function sendMessage(eventId, authorType, authorName, body, imageUrl) {
  const { error } = await requireSupabase().from("messages").insert({
    event_id: eventId, author_type: authorType, author_name: authorName, body, image_url: imageUrl,
  });
  if (error) throw error;
}

/* ---------------- Tasks, vendors, and project creation ---------------- */

/* ---------------- Proposal line items ---------------- */
// Editable while the proposal is in "draft" — once submitted for review or
// sent, changes should go through "send back to draft" first, keeping the
// admin-approval workflow meaningful rather than editable out from under it.

export async function addProposalItem(eventId, item) {
  const { error } = await requireSupabase().from("proposal_items").insert({
    event_id: eventId, label: item.label, qty: item.qty, unit_cost: item.unitCost,
  });
  if (error) throw error;
}

export async function updateProposalItem(itemId, item) {
  const { error } = await requireSupabase().from("proposal_items")
    .update({ label: item.label, qty: item.qty, unit_cost: item.unitCost })
    .eq("id", itemId);
  if (error) throw error;
}

export async function deleteProposalItem(itemId) {
  const { error } = await requireSupabase().from("proposal_items").delete().eq("id", itemId);
  if (error) throw error;
}

export async function inviteClient(eventId, clientEmail) {
  const { data, error } = await requireSupabase().functions.invoke("invite-client", {
    body: { eventId, clientEmail },
  });
  if (error) throw error;
  return data;
}

export async function generateClientCode(eventId) {
  const { data, error } = await requireSupabase().rpc("generate_client_code", { p_event_id: eventId });
  if (error) throw error;
  return data; // the code itself, as a string
}

// Anonymous sign-in must be enabled in the Supabase dashboard (Authentication
// → Providers → Anonymous Sign-ins) or this will fail with a clear error.
export async function redeemClientCode(code) {
  const client = requireSupabase();
  const { error: authError } = await client.auth.signInAnonymously();
  if (authError) throw authError;
  const { data, error } = await client.rpc("redeem_client_code", { p_code: code.trim().toUpperCase() });
  if (error) throw error;
  return data; // the event_id this code unlocked
}

export async function invitePlanner(email, role) {
  const { data, error } = await requireSupabase().functions.invoke("invite-planner", {
    body: { email, role },
  });
  if (error) throw error;
  return data;
}

export async function fetchTeamMembers() {
  const { data, error } = await requireSupabase().from("planners").select("id, email, role").order("email");
  if (error) throw error;
  return data;
}

export async function updatePlannerRole(plannerId, role) {
  const { error } = await requireSupabase().from("planners").update({ role }).eq("id", plannerId);
  if (error) throw error;
}

// Removes a teammate's Studio access. Does not touch their underlying auth
// account — see 0010_remove_planner.sql for why that's enough, and for the
// server-side guards (can't remove yourself, can't remove the last admin)
// that make this safe to call directly from the client.
export async function removePlanner(plannerId) {
  const { error } = await requireSupabase().from("planners").delete().eq("id", plannerId);
  if (error) throw error;
}

export async function assignTask(taskId, assignee) {
  const { error } = await requireSupabase().from("tasks").update({ assignee }).eq("id", taskId);
  if (error) throw error;
}

export async function addVendor(eventId, vendor) {
  const { error } = await requireSupabase().from("vendors").insert({
    event_id: eventId,
    name: vendor.name,
    category: vendor.category,
    contact: vendor.contact,
    phone: vendor.phone || null,
    cost: vendor.cost,
    status: "inquiry",
  });
  if (error) throw error;
}

export async function updateVendorPhone(vendorId, phone) {
  const { error } = await requireSupabase().from("vendors").update({ phone }).eq("id", vendorId);
  if (error) throw error;
}

export async function cycleVendorStatus(vendorId, nextStatus) {
  const { error } = await requireSupabase().from("vendors").update({ status: nextStatus }).eq("id", vendorId);
  if (error) throw error;
}

// Creates the event row plus its starter proposal row and default phases/tasks
// in one pass. Not wrapped in a single DB transaction (supabase-js doesn't
// expose multi-statement transactions directly) — for production use, this
// is a good candidate to move into a Postgres function (see approve_proposal
// in 0003_triggers.sql for the pattern) so it's atomic.
export async function createEvent({ organizationId, plannerId, name, type, date, venue, clientName, clientEmail, budgetTotal, phaseTemplate }) {
  const client = requireSupabase();

  const { data: event, error: eventError } = await client
    .from("events")
    .insert({
      organization_id: organizationId,
      name,
      type,
      event_date: date,
      venue,
      status: "Early planning",
      budget_total: budgetTotal,
    })
    .select()
    .single();
  if (eventError) throw eventError;

  const { error: memberError } = await client
    .from("event_members")
    .insert({ event_id: event.id, planner_id: plannerId, member_role: "lead" });
  if (memberError) throw memberError;

  const { error: proposalError } = await client.from("proposals").insert({ event_id: event.id, status: "draft" });
  if (proposalError) throw proposalError;

  if (clientEmail) {
    const { error: clientError } = await client
      .from("client_access")
      .insert({ event_id: event.id, invited_email: clientEmail.toLowerCase().trim() });
    if (clientError) throw clientError;
  }

  for (let i = 0; i < (phaseTemplate || []).length; i++) {
    const phase = phaseTemplate[i];
    const { data: phaseRow, error: phaseError } = await client
      .from("phases")
      .insert({ event_id: event.id, title: phase.title, position: i })
      .select()
      .single();
    if (phaseError) throw phaseError;

    const taskRows = phase.tasks.map((label, ti) => ({
      phase_id: phaseRow.id, label, done: false, assignee: null, position: ti,
    }));
    if (taskRows.length > 0) {
      const { error: taskError } = await client.from("tasks").insert(taskRows);
      if (taskError) throw taskError;
    }
  }

  return event.id;
}

/* ---------------- Admin: delete projects, manage tasks directly ---------------- */

// Deleting the event cascades to every child row (phases, tasks, proposals,
// approvals, vendors, budget items, messages, client access) via the
// "on delete cascade" foreign keys in 0001_init.sql — one call is enough.
// The RLS delete policy (0005_admin_controls.sql) additionally requires the
// caller to be an admin in that event's organization, not just any planner.
export async function deleteEvent(eventId) {
  const { error } = await requireSupabase().from("events").delete().eq("id", eventId);
  if (error) throw error;
}

// Admin-only at the database level too — see the split insert/delete
// policies on "tasks" in 0005_admin_controls.sql. Team members can still
// toggle done/assignee on existing tasks (that policy is unchanged).
// Pass { visibility: "restricted", assigneePlannerIds: [...] } to create a
// task only admins and those specific planners can see or manage — see
// 0012_restricted_tasks.sql. Two calls, not one transaction (same
// trade-off noted on createEvent above) — if the second call fails the
// task exists but with no appointees, which for a restricted task simply
// means only admins can see it until someone is added.
export async function addTask(phaseId, label, { visibility = "team", assigneePlannerIds = [] } = {}) {
  const { data, error } = await requireSupabase()
    .from("tasks")
    .insert({ phase_id: phaseId, label, done: false, visibility })
    .select()
    .single();
  if (error) throw error;

  if (visibility === "restricted" && assigneePlannerIds.length > 0) {
    const { error: assigneeError } = await requireSupabase()
      .from("task_assignees")
      .insert(assigneePlannerIds.map((plannerId) => ({ task_id: data.id, planner_id: plannerId })));
    if (assigneeError) throw assigneeError;
  }
  return data;
}

export async function deleteTask(taskId) {
  const { error } = await requireSupabase().from("tasks").delete().eq("id", taskId);
  if (error) throw error;
}

/* ---------------- Client task requests ---------------- */
// Clients propose, admins dispose — see 0011_client_task_requests.sql.

export async function requestTask(eventId, label, description) {
  const { error } = await requireSupabase().from("task_requests").insert({ event_id: eventId, label, description });
  if (error) throw error;
}

export async function dismissTaskRequest(requestId) {
  const { error } = await requireSupabase().from("task_requests").update({ status: "dismissed" }).eq("id", requestId);
  if (error) throw error; // trigger rejects this unless caller is an admin and the request is still pending
}

// Turns a request into a real task on the chosen phase, then marks the
// request approved and links it to the task it became. Admin-only, same
// as addTask itself — the request-approval policy just gates the status
// update; the tasks insert policy independently gates the task creation.
export async function approveTaskRequest(requestId, phaseId, label) {
  const task = await addTask(phaseId, label);
  const { error } = await requireSupabase()
    .from("task_requests")
    .update({ status: "approved", resolved_task_id: task.id })
    .eq("id", requestId);
  if (error) throw error;
  return task;
}

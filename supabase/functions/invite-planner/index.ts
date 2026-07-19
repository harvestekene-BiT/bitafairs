// Supabase Edge Function: invite-planner
//
// Lets an admin add a new team member (or another admin) to their agency,
// without touching the SQL Editor by hand. Mirrors invite-client's shape —
// same reason this can't happen client-side: creating the auth user and
// inserting into `planners` needs the service-role key, which must never
// reach the browser.
//
// Deploy with: supabase functions deploy invite-planner
// Shares the same secrets as invite-client (SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_URL, SUPABASE_ANON_KEY) — these are reserved names Supabase
// injects automatically into every Edge Function, so there's nothing to
// set by hand here.

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callerClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { email, role } = await req.json();
    if (!email || !["admin", "team"].includes(role)) {
      return new Response(JSON.stringify({ error: "email and a valid role ('admin' or 'team') are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Only an existing admin may add teammates.
    const { data: callerPlanner } = await adminClient.from("planners").select("organization_id, role").eq("id", user.id).single();
    if (!callerPlanner || callerPlanner.role !== "admin") {
      return new Response(JSON.stringify({ error: "Only an admin can add team members" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      redirectTo: Deno.env.get("APP_URL") ?? undefined,
    });
    if (inviteError) throw inviteError;

    const { error: insertError } = await adminClient.from("planners").insert({
      id: invited.user.id,
      organization_id: callerPlanner.organization_id,
      email: email.toLowerCase().trim(),
      role,
    });
    if (insertError) throw insertError;

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

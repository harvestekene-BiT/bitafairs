# BiT Affairs

Event production studio + client approval portal. React + Vite frontend, Supabase (Postgres + Auth + Edge Functions) backend.

**This app requires a real Supabase backend to run.** There is no offline/demo mode — if it isn't connected to a configured Supabase project, it shows a "Backend not configured" screen instead of pretending to work. What follows is a complete walkthrough to get a real, working instance live.

## What this is

- **Studio** — the agency's dashboard: create projects, manage tasks, proposals, vendors, budgets, and a client-facing message thread. Two internal roles: **Team member** (work goes to an admin for review before reaching a client) and **Admin** (reviews and releases work, oversees an approvals queue across every project, manages team membership). Admins can mark a task private — visible and manageable only by admins and whichever team members they appoint — and can turn a client's task request into a real checklist item.
- **Client portal** — a scoped view for exactly one event: timeline, proposal, approvals (with a brass "stamp" approval interaction), vendors, budget, messages, and task requests. Clients can propose a task for the checklist; an admin decides whether it's added. Vendors and budget are read-only for clients — the same figures the agency sees, but only planners can add a vendor, change a vendor's status, or edit a budget line. Clients sign in with a passwordless magic-link email, never a password.
- **Installable + push notifications.** Both Studio and the client portal can be installed to a phone's home screen (PWA — no app store), and both sides get real push notifications for new messages, proposals, and approvals, even when the app isn't open. See "Push notifications" further down for the (one-time, multi-step) setup this needs.

---

## Part 1 — Set up the backend (Supabase)

You'll need a free [Supabase](https://supabase.com) account and, for one step, the [Supabase CLI](https://supabase.com/docs/guides/cli) installed locally (`npm install -g supabase` or see their install docs for your OS).

1. **Create a project** at [supabase.com](https://supabase.com) → New Project. Pick a region close to your users and set a database password (save it somewhere).

2. **Run the database migrations.** In the Supabase dashboard, open the **SQL Editor**, and run each file in `supabase/migrations/` **in this exact order** (paste the contents of each file into a new query and run it):
   - `0001_init.sql` — creates every table (organizations, planners, events, client access, tasks, proposals, approvals, vendors, budget items, messages)
   - `0002_rls.sql` — Row Level Security policies: planners see only their org's events, clients see only their one event
   - `0003_triggers.sql` — database triggers that enforce the admin-approval gate as a real rule (a non-admin's request to "send to client" is rejected by Postgres itself, not just hidden by the UI)
   - `0004_fix_recursion.sql` — fixes a policy bug from an earlier pass (self-referential RLS check on the planners table caused "infinite recursion detected")
   - `0005_admin_controls.sql` — restricts project deletion and adding/removing tasks to admins only, at the database level (team members can still update existing tasks — toggle done, reassign)
   - `0006_disapproval.sql` — lets clients request changes (not just approve) on a sent proposal, and makes approved/disapproved proposals editable again
   - `0007_vendor_phone.sql` — adds a phone number field to vendors
   - `0008_client_code_login.sql` — lets an admin generate a short access code so a client can log in without email. **After running this file, also go to Authentication → Providers in the Supabase dashboard and enable "Anonymous Sign-ins"** — code login depends on it and will fail with an auth error until it's turned on.
   - `0009_client_vendors_budget.sql` — lets clients read (never write) vendor and budget rows for their own event, the same information the Studio side sees. Previously these two tables had no client-facing policy at all.
   - `0010_remove_planner.sql` — lets an admin remove a teammate's Studio access. Enforced in Postgres: an admin can never remove themselves, and an org can never be left with zero admins.
   - `0011_client_task_requests.sql` — lets a client propose a task for their event's checklist. It lands in a review queue, not directly on the plan — an admin decides whether to add it (`0012` covers who can then see it) or dismiss it.
   - `0012_restricted_tasks.sql` — lets an admin mark a task "private": visible and editable only by admins and whichever team members the admin specifically appoints, never by the client. Regular tasks are unaffected.
   - `0013_approval_disapproval.sql` — lets a client disapprove (request changes on) a released milestone approval, not just approve it — the same approve/disapprove pair proposals already had. An admin can re-release a disapproved approval to the client once it's addressed.
   - `0014_fix_client_proposal_approval_updates.sql` — **fixes a real bug**: the client's approve/disapprove actions on proposals and approvals had a SELECT policy and a state-machine trigger, but no RLS UPDATE policy was ever granted, so every client approve/disapprove call was silently updating 0 rows. Also fixes the client's proposal SELECT policy, which never included the `disapproved` status added in `0006`, so a disapproved proposal would disappear from the client's own query.
   - `0015_realtime.sql` — adds `messages`, `proposals`, `approvals`, and `task_requests` to the `supabase_realtime` publication, so both sides of the app get live updates without a page refresh (see "Realtime" below).
   - `0016_push_notifications.sql` — creates `push_subscriptions`, where each browser's push endpoint is stored once someone grants notification permission. See "Push notifications" below for the rest of the setup — this migration alone doesn't turn notifications on.

3. **Deploy the Edge Functions.** These are the operations that need elevated privileges — inviting a client, inviting a teammate — so they must run server-side, never in the browser:
   ```bash
   supabase login
   supabase link --project-ref your-project-ref   # find this in your project's dashboard URL
   supabase functions deploy invite-client
   supabase functions deploy invite-planner
   supabase secrets set APP_URL=https://your-eventual-deployed-url.com
   ```
   Note: you do **not** need to (and can't) manually set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` — every `SUPABASE_`-prefixed name is reserved, and Supabase automatically injects all three into every Edge Function's environment already. Running `supabase secrets set SUPABASE_ANON_KEY=...` will just fail or be ignored; there's nothing to configure there. `APP_URL` is the only secret this project actually needs you to set by hand. The service-role key never appears in frontend code or gets committed to git — it only ever lives in Supabase's own managed environment.

4. **Allow your app's URL for magic-link redirects.** In the dashboard, go to Authentication → URL Configuration, and add:
   - `http://localhost:5173` (for local development)
   - Your real deployed URL once you have it from Part 3 below (you'll come back to add this)

5. **Create your first organization and admin user.** There's no sign-up screen yet (see Known Limitations), so the very first admin account is created by hand, once:
   - In the dashboard, go to Authentication → Users → Add user. Create a user with your email and a password.
   - In the SQL Editor, run:
     ```sql
     insert into organizations (name) values ('Your Agency Name') returning id;
     -- copy the returned id, then:
     insert into planners (id, organization_id, email, role)
     values ('paste-the-auth-user-id-here', 'paste-the-organization-id-here', 'you@youragency.com', 'admin');
     ```
   - The user's `id` is visible on their row in Authentication → Users.

6. **Get your API keys.** Project Settings → API → copy the **Project URL** and **anon public key**. You'll need both in Part 2.

---

## Part 2 — Configure and run it

1. Install [Node.js](https://nodejs.org) 18+ if you don't have it.
2. In this folder:
   ```bash
   npm install
   cp .env.example .env
   ```
3. Open `.env` and fill in the values from step 6 above (plus the VAPID public key, if you're setting up push notifications — see "Push notifications" below):
   ```
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   VITE_VAPID_PUBLIC_KEY=your-vapid-public-key
   ```
4. Run it locally:
   ```bash
   npm run dev
   ```
   Open the printed URL (usually `http://localhost:5173`). Sign in with the admin account you created in step 5. You should land on an empty Studio dashboard — create your first project to confirm everything's wired correctly.

---

## Part 3 — Deploy it live

### Recommended: Vercel

1. Push this project to a GitHub repository (create a new repo, then `git init`, `git add .`, `git commit`, and push this folder to it, if you haven't already).
2. Go to [vercel.com](https://vercel.com) → Add New Project → import that repo. Vercel auto-detects Vite.
3. Before clicking Deploy, add your environment variables (Vercel's project settings → Environment Variables):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_VAPID_PUBLIC_KEY` (only if you've set up push notifications — see below; harmless to leave unset otherwise, notifications just won't be offered)
4. Click Deploy. You'll get a live URL like `bitaffairs-yourname.vercel.app`.
5. **Go back to Supabase** (Authentication → URL Configuration) and add this real URL to the allowed redirect list — magic links won't work until you do this.
6. Also update the Edge Function's `APP_URL` secret to match:
   ```bash
   supabase secrets set APP_URL=https://bitaffairs-yourname.vercel.app
   ```

### Custom domain
In Vercel's project settings → Domains, add your own domain (e.g. `app.youragency.com`) and follow the DNS instructions shown — SSL is automatic and free. Remember to also add this final domain to Supabase's redirect URL allowlist (step 5 above).

### Alternative hosts

### Netlify (good alternative if Vercel is giving you trouble)

1. Push this project to a GitHub repository if it isn't already.
2. Go to [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → connect GitHub → pick the repo.
3. Build settings: build command `npm run build`, publish directory `dist`. Netlify usually detects these automatically for a Vite project.
4. Before or right after the first deploy, go to **Site configuration → Environment variables** and add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_VAPID_PUBLIC_KEY` (only if you've set up push notifications — see below)
5. **Trigger a new deploy after adding them** — same rule as Vercel: Netlify doesn't rebuild automatically just because you saved new variables. Go to **Deploys** tab → **Trigger deploy → Deploy site**.
6. You'll get a live URL like `your-site-name.netlify.app`. Add this (and your custom domain, once set up) to Supabase's Authentication → URL Configuration allowed redirect list, same as with Vercel.
7. Security headers (`public/_headers`) are picked up automatically by Netlify — no extra config needed, unlike the Vercel version which needs `vercel.json`.

One practical tip regardless of which platform you use: **only ever run one project pointed at this repo.** Duplicate projects with similar auto-generated names (`your-app`, `your-app-1`, etc.) are the single most common cause of "I set the environment variables but it's still broken" — you end up editing a project that isn't the one actually serving your live URL.

### GitHub Pages
`npm run build`, then push the `dist/` folder's contents to a `gh-pages` branch and enable Pages on that branch. This one's more manual: GitHub Pages doesn't have a dashboard for environment variables, so `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` need to be injected via GitHub Actions secrets in your build workflow instead. It also doesn't support the `_headers`/`vercel.json` security headers. Recommended only if you're already comfortable with GitHub Actions — Vercel or Netlify are more straightforward otherwise.

---

## Inviting your team and clients

- **Team members**: there's no in-app invite flow yet for planners (see Known Limitations) — add additional planners the same way you created the first admin (step 5 in Part 1), using `role: 'team'` instead of `'admin'`.
- **Clients**: from inside a project (Studio → the project → Overview tab), either use the "Invite client by email" box (calls the real `invite-client` Edge Function, sends a magic sign-in link), or click "Generate access code" for a client who'd rather not use email — an 8-character code, valid 30 days, that they type in directly on the "I have an access code" screen. Regenerating a code replaces the old one.

---

## Known limitations, honestly

- **Planner sign-up is now in the UI** for adding *additional* teammates (Studio → Team, admin-only) — but the very first admin for a new organization still has to be created manually via the Supabase dashboard/SQL Editor (step 5 in Part 1), since there's no "create your agency from scratch" flow yet.
- **Mutations re-fetch rather than update optimistically.** Every action (toggling a task, sending a message, etc.) re-fetches that one event from the database afterward instead of patching local state instantly — simpler and more obviously correct for a first real-backend pass, at the cost of a small delay per action.
- **This has now been run against a live Supabase project and deployed** — most of the app has been through several rounds of real fixes since the initial build (see git history / migration comments for specifics on what broke and why). **Push notifications specifically are the newest, least battle-tested piece** — the code is correct by careful construction and cross-checked against Supabase's own documentation, but hasn't yet been exercised against a real deployed instance the way the rest of the app has. Expect to debug something small the first time you actually send one.

---

## Security

**No software is "unhackable"** — that's not a real property anything can claim. Here's what's actually in place, and what still deserves attention before handling sensitive real-world data at scale.

### In place
- **Real server-side enforcement, not just UI gating.** The admin-approval workflow is enforced by Postgres triggers (`supabase/migrations/0003_triggers.sql`) — a non-admin's request to release work to a client is rejected by the database itself.
- **Row Level Security everywhere.** Planners can only query their own organization's data; clients can only ever query their one event, and never see unreleased (draft/pending-review) proposals and approvals — enforced at the database layer, not hidden in the UI. Clients *can* see vendor details and budget figures for their event (same information the Studio side sees) as of `0009_client_vendors_budget.sql`, but only to read — adding a vendor, changing a vendor's status, or editing budget line items is still planner-only, enforced by the same RLS policies. A task marked "private" (`0012_restricted_tasks.sql`) is invisible even to other team members unless an admin appointed them to it specifically, and is never visible to the client regardless. Only the invited client for an event can approve, disapprove, message, or request a task on that event's portal — enforced by RLS (`0014_fix_client_proposal_approval_updates.sql`), not just by which screen the UI happens to show. When an admin uses "Preview client portal," the UI itself disables those controls too (see `previewMode` on `ClientPortal` in `src/App.jsx`) so the preview can't be mistaken for a way to act as the client.

### Realtime

Proposals, approvals, and messages update live on both the Studio and client side — no page refresh needed — and both sides get a toast notification when something changes on any event they have access to (a planner across their org, a client on their one event). This is powered by Supabase's Postgres Changes: `0015_realtime.sql` adds the relevant tables to the `supabase_realtime` publication, and `subscribeToActivity()` in `src/lib/supabaseClient.js` opens one subscription per session. Realtime evaluates each table's normal RLS SELECT policy per connected user, so this doesn't expose anything a plain query wouldn't already — it just delivers it immediately instead of on next load. Task requests also live-refresh the review queue, without a toast (the toast is scoped to messages/proposals/approvals).

If notifications don't seem to be arriving after running the migrations, check your project's Database → Replication settings in the Supabase dashboard and confirm `messages`, `proposals`, `approvals`, and `task_requests` show as enabled under the `supabase_realtime` publication.

### Push notifications (installable app + phone notifications)

Realtime toasts (above) only work while someone has the site open in a tab. This is the separate piece that reaches a phone even when the app is closed: BiT Affairs is a PWA (installable, works offline for the shell, has a real app icon on the home screen) with Web Push wired up for messages, proposals, and approvals.

**The installable-app part needs no setup** — `public/manifest.webmanifest` and `public/sw.js` are already in place and take effect the moment you deploy. On Android, Chrome will offer "Install app" / "Add to Home Screen" automatically. On iPhone, there's no automatic prompt — the person has to open the site in Safari, tap the Share icon, then **Add to Home Screen** themselves. Once installed that way, iOS supports real push notifications too (since iOS 16.4) — but *only* for the installed home-screen version, never for a tab still open in Safari itself.

**Push notifications need a one-time setup**, in this order:

1. **Generate a VAPID key pair.** This project's Edge Function and frontend were built and tested against a real pair generated for you already — if you haven't changed anything, you can use these directly:
   ```
   VAPID_PUBLIC_KEY=BPnCMHXgELciGZ5567L6diAihQfMZSypM6C757EAmSh5xi06pHzknemUiky6RTkN7Afq5QwSowkKyxogReqS1j8
   VAPID_PRIVATE_KEY=Cgm5T5ZN-eRrQ-SQ1n-4Yhb1ploZlEiTar4KSdPvqWQ
   ```
   Treat the private key like any other secret (never commit it, never put it in `.env`/frontend code). If you'd rather generate your own pair: `node -e "console.log(require('web-push').generateVAPIDKeys())"` after `npm install web-push` anywhere you have Node — or ask me and I'll generate a fresh one.

2. **Set the public key in your frontend env** — add to `.env` locally and to Vercel/Netlify's environment variables (see Part 2/3 above):
   ```
   VITE_VAPID_PUBLIC_KEY=BPnCMHXgELciGZ5567L6diAihQfMZSypM6C757EAmSh5xi06pHzknemUiky6RTkN7Afq5QwSowkKyxogReqS1j8
   ```
   This one is safe to expose — it's the public half by design. Remember Vercel/Netlify only pick up new env vars on the *next* deploy, same as the Supabase URL/key.

3. **Set the private key and subject on the Edge Function:**
   ```bash
   supabase secrets set VAPID_PUBLIC_KEY=BPnCMHXgELciGZ5567L6diAihQfMZSypM6C757EAmSh5xi06pHzknemUiky6RTkN7Afq5QwSowkKyxogReqS1j8
   supabase secrets set VAPID_PRIVATE_KEY=Cgm5T5ZN-eRrQ-SQ1n-4Yhb1ploZlEiTar4KSdPvqWQ
   supabase secrets set VAPID_SUBJECT=mailto:you@youragency.com
   ```
   `VAPID_SUBJECT` is a contact the push services (Apple/Google/Mozilla) can reach if there's ever a delivery problem — required by the Web Push spec, not optional. Use a real address you check.

4. **Deploy the Edge Function:**
   ```bash
   supabase functions deploy send-push --no-verify-jwt
   ```
   The `--no-verify-jwt` flag matters here — this function is called by Supabase's own infrastructure (a Database Webhook, next step), not by a signed-in user's browser, so the normal per-user auth check doesn't apply.

5. **Create three Database Webhooks** so Postgres actually calls `send-push` when something happens. In the Supabase dashboard: **Database → Webhooks → Create a new hook**, three times:
   | Name | Table | Events | Type | URL |
   |---|---|---|---|---|
   | `push-on-message` | `messages` | Insert | Edge Function | `send-push` |
   | `push-on-proposal` | `proposals` | Update | Edge Function | `send-push` |
   | `push-on-approval` | `approvals` | Insert, Update | Edge Function | `send-push` |

   For each one, when you pick "Edge Function" as the type and select `send-push`, Supabase shows an "HTTP Headers" section — click **Add new header → Add auth header with service key**. This is what lets `send-push` authenticate the call; without it the function will reject the request.

6. **Run the migration** (if you haven't already as part of the batch above): `0016_push_notifications.sql`.

Once all six steps are done: open the app, sign in, and you (or your client) should see the "Turn on notifications?" banner in the bottom-left corner — click Enable, accept the browser's permission prompt, and that device is registered. A bell icon stays in the header afterward as a permanent status indicator/control. Test it by having someone else send a message or approve something on that event — a real OS-level notification should arrive within a few seconds, even with the site closed.

**Known limitation:** tapping a push notification currently opens the app to wherever it starts (the dashboard, or the client portal root) rather than jumping straight to the specific event/message — the app doesn't have per-page routing yet, so there's no URL to deep-link to. Worth adding later if this becomes annoying in practice.
- **No script-injection vectors.** The app never uses `dangerouslySetInnerHTML`, `eval`, or raw `innerHTML` — all user text goes through React's default output escaping.
- **Input limits and validation**: message bodies, names, and descriptions are length-capped (`LIMITS` in `src/App.jsx`); uploaded images are validated as image files, capped at 15MB, and resized/compressed client-side.
- **The service-role key never reaches the browser** — it lives only in the `invite-client` Edge Function's server-side environment.
- **HTTP security headers** (`vercel.json`): CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. These apply on Vercel automatically; translate to your host's equivalent (e.g. Netlify's `_headers` file) if deploying elsewhere.

### Worth doing before scaling up
- **Add a planner invite flow** so accounts aren't created by hand in the SQL Editor.
- **Rate-limit** login attempts and magic-link requests (Supabase has some built-in protections; review their current limits for your plan).
- **Audit logging** for contractually meaningful actions (proposal sent, client approved) — currently you have `sent_at`/`approved_at` timestamps on the rows themselves, which covers the basics, but a dedicated append-only audit table would be more robust.
- **Review Supabase's default session lengths** and adjust to your risk tolerance under Authentication settings.

## Tech stack

- React 18 + Vite
- Supabase (Postgres, Auth, Row Level Security, Edge Functions)
- [lucide-react](https://lucide.dev) for icons
- No external UI framework — all styling is inline, using the design tokens defined at the top of `src/App.jsx`

# BiT Affairs — Authentication & Access Spec

**Purpose:** define how planners (agency staff) and clients log in separately and how access is scoped, so the current prototype can be connected to a real backend.

**Recommended stack:** Supabase (Postgres + Auth + email) or Firebase (Firestore + Auth). Either handles password auth, magic-link email, and row-level permission rules out of the box — no need to build an auth server from scratch.

---

## 1. Two distinct login paths

| | Planner | Client |
|---|---|---|
| How they get an account | Signs up / is invited by an agency Owner | Never signs up — added to one event by a planner |
| Credentials | Email + password (or SSO) | One-time invite link (magic link), optional password on first use |
| Scope of access | Every event belonging to their organization, per their role | Exactly one event |
| Where they land | Studio dashboard | That event's client portal only |

A client is not "a user with a dashboard" — they're a guest whose access is scoped to a single record. Modeling it that way (rather than as a lightweight user account) keeps their permissions impossible to get wrong.

---

## 2. Roles & permissions

| Role | Scope | Can do |
|---|---|---|
| Owner | Organization | Everything, incl. billing & adding planners |
| Coordinator | Assigned events | Edit tasks, send proposals, request approvals, manage vendors/budget |
| Viewer | Assigned events | Read-only — useful for junior staff or interns |
| Client | One event | Read timeline/proposal/approvals, approve/stamp — cannot edit anything |

Enforce this server-side (e.g., Postgres Row Level Security policies keyed on `organization_id` / `event_id`), not just by hiding UI — the prototype currently only hides UI, which is not secure on its own.

---

## 3. Database schema

```sql
organizations
  id uuid primary key
  name text
  created_at timestamptz

planners
  id uuid primary key references auth.users(id)
  organization_id uuid references organizations(id)
  email text unique
  role text check (role in ('owner','coordinator','viewer'))

clients
  id uuid primary key
  email text
  name text

events
  id uuid primary key
  organization_id uuid references organizations(id)
  name text
  type text
  event_date date
  venue text
  status text

event_members            -- which planners work this event
  event_id uuid references events(id)
  planner_id uuid references planners(id)
  role text check (role in ('lead','support'))
  primary key (event_id, planner_id)

client_access            -- the entire client permission model
  id uuid primary key
  event_id uuid references events(id)
  client_id uuid references clients(id)
  invite_token text unique
  token_expires_at timestamptz
  accepted_at timestamptz
  password_hash text null   -- set only if client opts into a password

phases, tasks, proposals, proposal_items, approvals, vendors, budget_items
  -- each scoped by event_id, mirroring the shapes already used in the
  -- BitAffairs.jsx prototype (see buildEvents() for the exact shape)
```

The load-bearing row is `client_access`: one invite token unlocks one `event_id`. Everything the client-facing UI queries is filtered through that row.

---

## 4. Auth flows

### Planner sign-in
1. Planner enters email + password on the Studio login screen.
2. Auth provider verifies credentials, issues a session (JWT).
3. Session includes `organization_id`; app fetches events where the planner is in `event_members` (or all org events, if Owner).

### Client invite
1. Planner enters a client's email against an event → backend creates a row in `client_access` with a signed, expiring `invite_token`, and sends an email containing a link like:
   `https://bitaffairs.app/invite/{invite_token}`
2. Client clicks it. Backend validates the token (not expired, not already revoked), creates a session scoped to that `event_id` only, and marks `accepted_at`.
3. Optional: on first visit, offer "set a password so you don't need a new link next time" — stores `password_hash` on that same `client_access` row, scoped to that one event. A second event = a second, separate access row and (if desired) separate password.
4. If the client re-visits without a valid session, they need a new link (planner can resend) or use their password if they set one.

### Session expiry & revocation
- Planner sessions: standard JWT expiry + refresh token, revocable by the Owner (e.g., if someone leaves the agency).
- Client sessions: shorter-lived by default since the stakes of a leaked event link are lower but not zero (guest lists, budgets). Planner should be able to revoke a `client_access` row at any time (e.g., wrong email was invited).

---

## 5. What changes in the current prototype

The prototype (`BitAffairs.jsx`) already has the right *shape* — it just fakes persistence with `window.storage` and fakes login with a timed spinner. To connect it to a real backend:

1. Replace `window.storage.get/set` calls with real API calls (REST or Supabase client SDK) reading/writing the tables above.
2. Replace `PlannerLoginForm`'s mock `setTimeout` with an actual call to the auth provider's sign-in method.
3. Replace `ClientInviteLanding`'s event-picker dropdown (a demo stand-in for "which email did you get") with reading the `invite_token` out of the URL and validating it server-side.
4. Remove the Studio/Client demo toggle in the top nav entirely — it exists only so this prototype is easy to click through in one browser tab.

---

## 6. Security notes for whoever implements this

- Never trust the client-side role check alone — enforce scope in the database (RLS) or API middleware.
- Invite tokens should be single-purpose, expiring (e.g., 14 days), and revocable.
- Rate-limit both login attempts and invite-token guesses.
- Log approval/stamp actions with a timestamp and the authenticated identity that performed them — this is effectively a lightweight audit trail for a "client approved X" claim, which may matter contractually.

## 7. Hardening checklist (do these before handling real client data)

No system is "unhackable" — the goal is removing the cheap, common attack paths and making the expensive ones the only ones left. In rough priority order:

1. **Password storage**: hash with `bcrypt` or `argon2` (never store plaintext or use reversible encryption). Never log passwords, even in error traces.
2. **Session tokens**: short-lived JWTs (e.g., 15–60 min) with silent refresh, stored in `httpOnly`, `Secure`, `SameSite=strict` cookies — not `localStorage`, which is readable by any script that runs on the page (including a future dependency that turns malicious).
3. **Invite tokens**: generate with a cryptographically secure random source (e.g., `crypto.randomBytes(32)`), store only a hash of the token server-side (like a password), expire them, and make them single-use once accepted.
4. **Transport**: HTTPS everywhere, HSTS enabled, no mixed content. Vercel/Netlify give you this by default — don't disable it.
5. **Rate limiting**: cap login attempts and invite-token validation attempts per IP/account (e.g., 5 attempts per 15 minutes) to blunt brute-forcing.
6. **Authorization, not just authentication**: every API endpoint must independently check "does this session actually have rights to this event_id" — never infer permission from what the UI happens to show.
7. **Input validation server-side**: repeat every client-side check (length limits, email format, file type/size) on the server. Client-side validation is only ever a UX nicety — it stops nothing from someone using the API directly.
8. **File uploads**: validate real file type from file bytes (not just the extension or claimed MIME type), scan for malware if budget allows, and store outside the web root or in dedicated object storage (S3, Supabase Storage) with signed, expiring URLs rather than public buckets.
9. **Secrets management**: API keys, database credentials, and signing secrets go in environment variables or a secrets manager — never committed to the repo, never in client-side code (anything shipped to the browser is public, full stop).
10. **Dependency hygiene**: run `npm audit` (or equivalent) regularly, and keep React/Vite/dependencies patched — most real-world breaches exploit known, already-patched vulnerabilities in outdated packages, not novel attacks.
11. **Audit logging**: record who did what and when for anything contractually meaningful (proposal sent, client approved, admin released an item) — separate from application logs, ideally append-only.
12. **Backups & recovery**: automated database backups with a tested restore process — losing a client's event data is a business risk even without an "attack."

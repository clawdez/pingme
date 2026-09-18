# Mr. Robot brief — PingMe: schools → Tables (join a table / create a table)

**Owner:** Clawdez (dispatched by Ez 2026-09-08, voice)
**Repo:** `~/.openclaw/workspace-mrrobot/repos/pingme`
**Supabase project:** `yuqahobbcwibekzvitec` (ez Pro org — NOT diehard-loads, NOT dead clawdez `jjgamvhvdqqjcizvpowk`)
**Lane:** single writer, this brief only.
**Runtime:** Fable 5.1 (fallback: Opus).
**Method:** spec-test-loop skill — spec, failing tests, implement, loop until 100% green. Green lane rules — feature branch → DRAFT PR → Clawdez flips to READY + merges after review.

---

## Why (context from Ez)

The "schools" model doesn't fit — most users aren't at universities. The mental model Ez landed on:

> "join / create a table — anybody who joins this table can get notified when people are playing at this place. or specific area. these are tables near you and they can join those tables to basically opt in to get notifications for when people are playing in those specific areas."

So a **Table** is not just a room label — it's a **place-anchored notification group** people opt into. When someone pings from a Table ("I'm playing here now"), everyone joined to that Table gets notified.

Rename `schools` → `tables` throughout DB, UI, and copy. Existing `schools` data migrates as pre-approved tables. Keep the pending flow.

---

## Naming rule (critical, don't get confused)

- **Table** (new): the community / place / notification group. Users join tables, create tables, ping from tables.
- **Court** (existing, DO NOT RENAME): the ping-pong game surface UI element — `court-wrap`, `court-timer`, `court-svg`, `court-card`. This is the visual playfield. Leave it alone.

If you find any variable / class / copy that mixes them (e.g. "your court" meaning community), that was legacy schools-era ambiguity — resolve it to `table` when it means community, keep `court` when it means the game surface.

---

## Data model

### New table (DB): `tables`
Replaces `schools`. Same slug-based identity, same pending gate, plus place data.

```sql
create table public.tables (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,               -- 'zilker-park-pickleball', 'ttu-rec-center'
  display_name text not null,              -- 'Zilker Park Pickleball'
  activity text,                           -- 'pickleball' | 'basketball' | 'ping-pong' | 'general' | null
  place_hint text,                         -- optional user-provided location string ('Zilker Park, Austin TX')
  zip text,                                -- optional, for "tables near you"
  city text,                               -- resolved from zip if provided
  region text,                             -- 'TX', 'OH', etc.
  created_by uuid references auth.users(id),
  pending boolean not null default true,
  member_count int not null default 0,     -- denormalized, updated by trigger
  approved_at timestamptz,
  created_at timestamptz default now()
);

create index tables_slug_idx on public.tables(slug);
create index tables_zip_idx on public.tables(zip) where zip is not null;
create index tables_city_idx on public.tables(city) where city is not null;
```

### New table (DB): `table_members`
Opt-in membership → notification subscription.

```sql
create table public.table_members (
  table_id uuid references public.tables(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (table_id, user_id)
);
```

### Migration from `schools`
- Migration `0004_tables_from_schools.sql` (or next number).
- Copy every row from `schools` into `tables` (slug/display_name/pending flags preserved).
- Copy every user's `school_slug` (or however current membership is tracked) into `table_members`.
- Keep `schools` table around for one release (data safety) — do NOT drop; add a comment noting deprecated.
- Update `suggest_school()` / `approve_school()` RPCs → `suggest_table()` / `approve_table()`. Keep old function names as thin aliases for one release so a mid-flight client doesn't 500.
- Auto-approve rule: when a `tables` row's `member_count` crosses **3**, set `pending = false, approved_at = now()`. Add a trigger on `table_members` insert.

### RLS
- `tables` — pending rows visible only to `created_by` and members; approved rows visible to all authenticated users.
- `table_members` — user can see their own memberships and the member list of tables they belong to.

---

## User flows (UI)

### 1. Onboarding — "find your table"

Replace the current schools picker with:

```
┌─────────────────────────────────┐
│ Where do you play?              │
│                                 │
│ [ search or zip → ]             │
│                                 │
│ Popular near you:               │
│   • Zilker Park Pickleball  (12)│
│   • UT Rec Center           (34)│
│   • Downtown YMCA           ( 8)│
│                                 │
│ Don't see it? [+ create a table]│
│                                 │
│ [ skip for now ]                │
└─────────────────────────────────┘
```

- If user provides a zip → resolve to city → show tables in that city sorted by member_count desc.
- If user types a name → fuzzy-match slug + display_name.
- "+ create a table" → inline modal: name, optional activity (dropdown or free-text), optional place hint, optional zip. Submits as `pending = true`, auto-joins creator, auto-approves when 3rd member joins.
- "skip" → user has no default table; they can join later from browse.

### 2. Browse tables

New route/view `/tables` (or a tab):
- **Tables near you** — sorted by proximity if zip known, else member_count.
- **Your tables** — tables user has joined, most recent activity first.
- **Trending** — tables with pings in the last 24h.
- Each row: name, activity chip, city, member count, [join / leave] button.

### 3. Ping from a table

Existing ping flow gains a "**at [table]**" selector:
- Default = user's most-recently-active joined table.
- Ping payload includes `table_id`. When ping fires, push notification goes to all `table_members` for that table (minus the sender).
- If no tables joined, ping falls back to legacy "open" ping (backward compat).

### 4. Notifications
- New notification pref: per-table mute (default on for tables you joined). Store in `table_members` as `notifications_enabled bool default true`.

---

## Copy changes (search-and-replace guidance)

- "school" (lowercase) → "table" (in user-facing copy only, NOT in ping-pong game code)
- "schools" → "tables"
- "your school" → "your table"
- "pick your school" → "find your table"
- "don't see your school? type it →" → "don't see your table? create one →"
- "pending school" → "pending table"
- Do NOT touch: any `court-*` identifier, `court`, `Court` when it refers to the ping-pong SVG game surface, physics engine, or timer.

---

## Endpoints / edge functions to update

Grep the codebase for `school`, `schools`, `suggest_school`, `approve_school`, `school_slug`, `school_id` and refactor. Some will be:
- `app.js` boot flow (picker component)
- Supabase RLS policies (already covered above)
- Any edge function that queries schools by slug
- Push notification target selection (from user's school → to all table_members)

---

## Tests (write FIRST, spec-test-loop)

New test file `tests/tables.test.js` (mirror existing `tests/schools.test.js` if any):
- create table (pending, creator auto-joined)
- join table (member_count increments)
- 3rd join → pending flips to false, approved_at set
- leave table (member_count decrements, notifications_enabled row removed)
- ping with `table_id` → notification list = all members minus sender
- reserved slugs still bounce (`other`, `none`, `admin`, `test`)
- rate limit: 3 table creates per user per day
- slug length 2–80, truncated at 32 with trailing `-` stripped (existing rule)
- RLS: pending table invisible to non-member/non-creator
- migration: every existing school row appears as a `tables` row with same slug, same pending state
- migration: every user's school membership appears in `table_members`
- backward compat: `suggest_school()` RPC still works and inserts into `tables` (alias)

Full suite must stay green (91/91 or whatever count is after signup rewrite lands — this brief rebases on top).

---

## Hard rules

- **Wait for `mrrobot/email-required-signup` branch to merge before starting.** Rebase on that + latest main. (Clawdez auto-dispatches this brief only after the signup lane frees up.)
- **One writer** on `~/.openclaw/workspace-mrrobot/repos/pingme` for the run.
- **Supabase = pingme project `yuqahobbcwibekzvitec` only.** Do NOT touch diehard-loads or dead clawdez `jjgamvhvdqqjcizvpowk`.
- **Feature branch:** `mrrobot/schools-to-tables`. Never push to main.
- **DRAFT PR only.** Clawdez flips to READY + merges after review.
- **Do NOT drop `schools` table.** Deprecate in comment, delete in a later PR.
- **Do NOT touch the ping-pong game code** (`court-*` identifiers, physics, timer, SVG).
- **No `--no-verify`.** Every failing test blocks.
- **No secrets in report.** Grep for `sk_`, `sbp_`, `re_`, `bearer` before writing.

---

## Reporting

Write `MRROBOT-REPORT-TABLES.md` in the repo root when done:
- Branch + commit SHA + PR link.
- Migration file path + row counts (`schools` → `tables`, users → `table_members`).
- Test count before/after (must be ≥ prior + new tables tests).
- Copy diff summary (files touched).
- Any deviation from this brief + why.
- Screenshot / description of the new picker + browse UI (Playwright test artifact fine).
- Explicit line: which existing routes still reference `schools` and are intentionally left as aliases for one release.

Last line MUST be `MRROBOT:DONE` iff fully complete + all tests green, else `MRROBOT:BLOCKED <reason>`.

# Mr. Robot brief — PingMe: schools → Scenes (join / create a scene)

**Owner:** Clawdez (dispatched by Ez 2026-09-08, voice — "yeah scene I like scene")
**Repo:** `~/.openclaw/workspace-mrrobot/repos/pingme`
**Supabase project:** `yuqahobbcwibekzvitec` (ez Pro org — NOT diehard-loads, NOT dead clawdez `jjgamvhvdqqjcizvpowk`)
**Runtime:** Fable 5.1 (fallback: Opus).
**Method:** spec-test-loop skill — spec, failing tests, implement, loop until 100% green. Green-lane rules — feature branch → DRAFT PR → Clawdez flips to READY + merges after review.

---

## Why (context from Ez, verbatim)

> "So far I think rooms is the best one because rooms can have multiple tables. And you should be able to get pinged if you want to go there — more like if you want to play in that area. Yeah scene, I like scene."

Ez killed "Tables" (a place can have many tables — collapses) and killed "Rally" (his gut). Landed on **Scene** — the gathering / vibe at a location. A Scene is a **place-anchored notification group** users opt into. When someone pings from a Scene ("I'm here playing now"), everyone joined to that Scene gets notified.

Rename `schools` → `scenes` throughout DB, UI, and copy. Existing `schools` data migrates as pre-approved scenes. Keep the pending gate.

---

## Naming rule (no collisions to worry about)

- **Scene** (new): the community / place / notification group. Users join scenes, create scenes, ping from scenes.
- **Court** (existing, DO NOT RENAME): the ping-pong game-surface UI element — `court-wrap`, `court-timer`, `court-svg`, `court-card`. Physical playfield. Leave alone.

"Scene" does not collide with any existing identifier in `app.js` or `styles.css` (grep-verified before dispatch — 0 matches for `scene`, `scenes`, `Scene`).

If a variable / class / copy currently mixes `school` with a community meaning, refactor to `scene`. If it references the game surface, keep `court`.

---

## Data model

### New DB table: `scenes` (replaces `schools`)

```sql
create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,               -- 'zilker-park-pickleball', 'ttu-rec-center'
  display_name text not null,              -- 'Zilker Park Pickleball'
  activity text,                           -- 'pickleball' | 'basketball' | 'ping-pong' | 'general' | null
  place_hint text,                         -- optional user-provided location ('Zilker Park, Austin TX')
  zip text,                                -- optional, for "scenes near you"
  city text,                               -- resolved from zip if provided
  region text,                             -- 'TX', 'OH', etc.
  created_by uuid references auth.users(id),
  pending boolean not null default true,
  member_count int not null default 0,     -- denormalized, updated by trigger
  approved_at timestamptz,
  created_at timestamptz default now()
);
create index scenes_slug_idx on public.scenes(slug);
create index scenes_zip_idx on public.scenes(zip) where zip is not null;
create index scenes_city_idx on public.scenes(city) where city is not null;
```

### New DB table: `scene_members` (opt-in membership = notification subscription)

```sql
create table public.scene_members (
  scene_id uuid references public.scenes(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  joined_at timestamptz default now(),
  notifications_enabled boolean not null default true,
  primary key (scene_id, user_id)
);
```

### Migration from `schools`
- Migration `0005_scenes_from_schools.sql` (next number after signup migration).
- Copy every row from `schools` into `scenes` (slug / display_name / pending flags preserved).
- Copy every user's `school_slug` into `scene_members`.
- Keep `schools` table around for one release (safety) — do NOT drop.
- Update `suggest_school()` / `approve_school()` RPCs → `suggest_scene()` / `approve_scene()`. Keep old function names as thin aliases for one release so a mid-flight browser client does not 500.
- Auto-approve rule: when a `scenes` row's `member_count` crosses **3**, set `pending = false, approved_at = now()`. Trigger on `scene_members` insert.

### RLS
- `scenes` — pending rows visible only to `created_by` and members; approved rows visible to all authenticated users.
- `scene_members` — user sees their own memberships and the member list of scenes they belong to.

---

## User flows (UI)

### 1. Onboarding — "find your scene"

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
│ Don't see it? [+ create a scene]│
│                                 │
│ [ skip for now ]                │
└─────────────────────────────────┘
```

- Zip → resolve to city → show scenes in that city sorted by `member_count desc`.
- Name → fuzzy-match slug + display_name.
- "+ create a scene" → inline modal: name, optional activity (dropdown or free-text), optional place hint, optional zip. Submits `pending = true`, auto-joins creator, auto-approves when 3rd member joins.
- "skip" → user has no default scene; can join later from browse.

### 2. Browse scenes — new route/view `/scenes`
- **Scenes near you** — proximity if zip known, else `member_count`.
- **Your scenes** — joined scenes, most recent activity first.
- **Trending** — scenes with pings in last 24h.
- Row: name · activity chip · city · member count · [join / leave] button.

### 3. Ping from a scene
- Existing ping flow gains an "at [scene]" selector.
- Default = user's most-recently-active joined scene.
- Ping payload includes `scene_id`. On ping fire → push notification to all `scene_members` for that scene (minus sender) whose `notifications_enabled = true`.
- No scenes joined → ping falls back to legacy "open" (backward compat).

### 4. Notifications
- Per-scene mute in `scene_members.notifications_enabled` (default true).
- Settings screen: list of joined scenes with per-scene toggle.

---

## Copy changes (search-and-replace guidance)

User-facing copy only — NEVER touch ping-pong game code:
- `school` → `scene`
- `schools` → `scenes`
- "your school" → "your scene"
- "pick your school" → "find your scene"
- "don't see your school? type it →" → "don't see your scene? create one →"
- "pending school" → "pending scene"
- Do NOT touch: any `court-*` identifier / `court` / `Court` when referencing ping-pong SVG game surface, physics, or timer.

---

## Endpoints / edge functions

Grep the codebase for `school`, `schools`, `suggest_school`, `approve_school`, `school_slug`, `school_id` and refactor. Expected hits:
- `app.js` boot flow (picker component)
- Supabase RLS policies (covered above)
- Any edge function that queries schools by slug
- Push-notification target selection (from user's school → all `scene_members`)

---

## Tests (write FIRST, spec-test-loop)

New test file `tests/scenes.test.js` (mirror existing tests if any):
- create scene (pending, creator auto-joined)
- join scene (member_count increments)
- 3rd join → pending flips to false, approved_at set
- leave scene (member_count decrements)
- ping with `scene_id` → notification list = all members minus sender minus muted
- reserved slugs still bounce (`other`, `none`, `admin`, `test`)
- rate limit: 3 scene creates per user per day
- slug length 2–80, truncated at 32 with trailing `-` stripped
- RLS: pending scene invisible to non-member/non-creator
- migration: every existing school row appears as a `scenes` row with same slug + pending state
- migration: every user's school membership appears in `scene_members`
- backward compat: `suggest_school()` RPC still works and inserts into `scenes` (alias)

Full suite must stay green (baseline 133/133 after signup rewrite landed — this brief rebases on latest main).

---

## Hard rules

- **Rebase on latest `main`.** Signup rewrite landed as `ad9dd33`; use that as base.
- **One writer** on `~/.openclaw/workspace-mrrobot/repos/pingme` for the run (mrrobot.sh flock handles it).
- **Supabase = pingme project `yuqahobbcwibekzvitec` only.** Do NOT touch diehard-loads or dead clawdez `jjgamvhvdqqjcizvpowk`.
- **Feature branch:** `mrrobot/schools-to-scenes`. Never push to main.
- **DRAFT PR only.** Clawdez flips to READY + merges after review.
- **Do NOT drop `schools` table.** Deprecate in comment; delete in a later PR.
- **Do NOT touch ping-pong game code** (`court-*` identifiers, physics, timer, SVG).
- **No `--no-verify`.** Every failing test blocks.
- **No secrets in report.** Grep for `sk_`, `sbp_`, `re_`, `bearer` before writing.

---

## Reporting

Write `MRROBOT-REPORT-SCENES.md` in the repo root when done:
- Branch + commit SHA + PR link.
- Migration file path + row counts (`schools` → `scenes`, users → `scene_members`).
- Test count before/after (must be ≥ prior + new scenes tests).
- Copy diff summary (files touched).
- Any deviation from this brief + why.
- Screenshot / description of the new picker + browse UI (Playwright artifact fine).
- Explicit line: which existing routes still reference `schools` and are intentionally left as aliases for one release.

Last line MUST be `MRROBOT:DONE` iff fully complete + all tests green, else `MRROBOT:BLOCKED <reason>`.

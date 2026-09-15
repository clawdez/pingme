# Mr. Robot brief — pingme: email-required signup + verify-to-login

**Owner:** Clawdez (dispatched by Ez 2026-09-08)
**Repo:** `~/.openclaw/workspace-mrrobot/repos/pingme` (symlink to workspace/pingme)
**Lane:** single writer, this brief only.
**Runtime:** Fable 5.1 (fallback: Opus).
**Method:** spec-test-loop skill — spec first, failing test, implement, verify.
**Green lane rules:** feature branch → PR → merge only if suite is 100% green.

---

## What Ez said

> "It's also not saving ppls login with emails and if they make an acct shld make them verify email so they can login again"

## Root cause (I already dug in)

`showSetupScreen2` (`app.js:4054`) calls `sb.auth.signInAnonymously()` on the "i'm in" path. That creates an anon `auth.users` row with **no email** — the account is tied to the Supabase session in localStorage only. Wipe the browser, lose the account. Can't sign in from a second device either.

Sign-in via `showSetupEmail` → `send-email` action `signin-send` only works for **existing** users (line 214-220 of `supabase/functions/send-email/index.ts`): if the email isn't already in `auth.users`, it returns a generic "if that email exists" and never sends a code. So the sign-in path is fundamentally cut off from the current anon-signup users.

## Goals

### 1. New signup path: email → OTP → verify → then name (no more anon)

Replace the anon signup with an email-required flow. Flow:

1. Welcome screen ("i'm in" / "sign in") — unchanged.
2. **NEW** — "i'm in" tapped → show `showSetupSignupEmail` (email input).
3. `send-email` action `signup-send` — create the `auth.users` row via `sb.auth.admin.createUser({ email, email_confirm: false })` (or update existing unverified row), store OTP in `email_otps`, send via Resend. If email is already verified/registered, return `{ error: 'that email is already registered — sign in instead' }` and surface a "sign in" button on the client.
4. Show OTP entry screen (same UI as `showSetupEmail`'s OTP screen).
5. `send-email` action `signup-verify` — verify OTP, set `email_confirm=true` via `sb.auth.admin.updateUserById`, mark `profiles.email_verified=true`, return `token_hash` so the client can call `sb.auth.verifyOtp({ token_hash, type: 'magiclink' })`.
6. `onAuthStateChange` fires → `showSetupScreen2(user, null, prefilledName)` — the existing name step, which now creates the profile tied to a real email-verified auth user.

### 2. Sign-in still works for verified email accounts

The existing `showSetupEmail` → `signin-send`/`signin-verify` flow already handles this correctly. Verify it still works end-to-end after the signup change. Add a nudge to the "invalid email or no account" case that suggests "create an account →".

### 3. Kill (or gate) the anon fallback

The `signInAnonymously()` call currently at `app.js:4055` should be **removed** as the default. Optional: keep as an emergency fallback behind a `FEATURES.anonSignup` flag defaulted to `false`. Any existing anon users on prod stay logged in via their session — the change only affects **new** signups.

### 4. Existing anon users can still add email to save their account

The current `link-email` flow (`app.js:3711`+) that lets a signed-in user attach their email should keep working. No changes required unless a test exposes a break.

---

## Non-goals (out of scope, do not touch)

- School picker layout — already fixed and merged in PR #5 today.
- Push notifications (Resend/VAPID configs).
- Any Supabase project other than `yuqahobbcwibekzvitec` (pingme).
- Any change to the pending-schools flow shipped in PR #4.

---

## Hard rules

- **One writer** on `~/.openclaw/workspace-mrrobot/repos/pingme` for this run.
- **Feature branch** `mrrobot/email-required-signup` off `main`. Never push to `main`.
- **All 91 existing tests stay green.** Plus new tests for signup-send / signup-verify happy path, duplicate-email rejection, invalid OTP, expired OTP, email-format validation.
- **Supabase migration** if `email_otps` schema needs to change to hold pre-user rows (currently keyed by `user_id`). If you widen it, snapshot the old data in a backup table first — reversible-only.
- **No secrets in briefs/reports/PR bodies.** Grep for `sk_`, `sbp_`, `re_`, `bearer` before writing anywhere.
- **No `--no-verify`.** No test skips.
- **Do NOT merge.** Open PR as READY (not draft) with green CI. Clawdez merges after review.
- **Deploy affects live users on usepingme.com.** No half-shipped auth changes. The whole flow works or the PR doesn't ship.

---

## Files you'll likely touch

- `app.js` — `showSetup`, `showSetupScreen2`, add `showSetupSignupEmail` + `showSetupSignupOtp`, remove/gate `signInAnonymously` path.
- `supabase/functions/send-email/index.ts` — add `signup-send` and `signup-verify` actions.
- Possibly `supabase/migrations/YYYYMMDD_email_otps_prehuman.sql` — widen `email_otps` to allow rows without `user_id` (nullable + keyed by email + purpose enum).
- `test/pending-schools.test.js` — no changes needed, but re-run.
- `test/friends-schools.test.js` — same.
- `test/send-email-auth.test.js` — extend for new actions.
- NEW `test/signup-flow.test.js` — end-to-end: email screen → OTP → verify → name step → profile created with email_verified=true.

---

## Reporting

Write final report to `/home/openclaw_agent/.openclaw/workspace/pingme/MRROBOT-REPORT-EMAIL-SIGNUP.md`:

- PR link, commit SHA, test count (must be > 91)
- Which files changed and why
- Any deviation from this brief and why
- Follow-ups you punted (with rationale)
- Deploy verification: check `usepingme.com` post-merge (Clawdez merges) shows the new signup flow

Last line of report MUST be exactly `MRROBOT:DONE` (all tests green, PR ready) or `MRROBOT:BLOCKED <one-line reason>`.

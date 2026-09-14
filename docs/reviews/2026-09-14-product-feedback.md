# Ping Me: live product feedback, 2026-09-14

Documentation-only review. No application code, account creation, real pings, messages, status changes or deployment were performed. This branch is based on clawdez/pingme main through a public review fork. The deployed revision of usepingme.com was not independently established.

## Live site result

Visited https://usepingme.com/, which redirected to https://www.usepingme.com/. The welcome screen loaded successfully. Clicking already have an account? sign in opened the email-code form. Submitting an empty email produced enter a valid email. No code was sent and no account email was supplied for this bounded review. This is an authentication evidence gap, not an app outage or reproduced authentication defect.

## Accessible sign-in context

The email input appeared as an unnamed text field in the accessibility snapshot, while the screenshot showed an ENTER YOUR EMAIL heading and your email placeholder. The same snapshot also included underlying app and sheet controls while the sign-in page was active. A snapshot alone does not prove keyboard focus can escape or establish a security issue.

Recommendation: give the email input a programmatically associated label; connect validation to the input and announce it. Check whether inactive screens should be hidden or inert so assistive technology receives only the active journey.

Acceptance: a screen reader announces Email for the input; empty/invalid submission announces the corrective message; keyboard and screen-reader navigation remain within the active sign-in page; returning to welcome restores sensible focus. Test with an authorized account that successful code verification returns to the intended invite/scene context.

## Keep preview failure separate from live availability

An earlier September 14 check of https://pingme-git-mrrobot-friends-schools-clawdezs-projects.vercel.app/?school=ttu showed looks like you are offline / cannot reach pingme right now; one retry returned to the error. The school parameter remained in the URL but successful session restoration was not established. That observation belongs to that preview and must not be reported as a reproduced usepingme.com outage.

Recommendation: preserve invitation context through recoverable failures; give a useful next step after retry failure; distinguish connection, service and session causes only when known. Acceptance: on a controlled preview, simulate boot failure, retry and recovery; verify invitation context survives, errors remain actionable, and repeated retries do not duplicate subscriptions or requests.

## Remaining validation

Invite-to-response, scene membership, notification delivery and authenticated recovery remain unverified here. Review them with an authorized test account and explicitly designated recipients before treating the complete journey as passed.

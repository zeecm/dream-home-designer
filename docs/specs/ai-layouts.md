# Spec: AI walls from a plan image, and suggested layouts (bring your own key)

Owner request (5 Nov 2026). Spec by the project-manager agent.

## Keys: in the browser, for now
Per provider (Claude, OpenAI, Gemini), kept on this device only (never in project JSON,
exports, share links, `/api` requests or telemetry), calls go straight from the browser to
the provider (Anthropic's direct-browser-access header). Reasons: accounts are off; our
server holds no secret that could leak; plan images don't pass through us; no proxy cost.
Later (accounts on): opt-in "keep my key with my account", sealed under `KEYS_SECRET`, with a
Worker proxy. View-only links have AI off. Suggest keys with a spending limit.

## Stage 1: walls from an image
- Settings "AI model": provider, key, model, Test, Forget, "Stored on this device only", rough
  cost per run.
- "Trace walls for me" in the plan image panel after Set scale, and in the guide.
- Pipeline: the model reads the image (walls, doors and swings, windows, room names, HS,
  bathrooms, hatching) and returns JSON; core straightens to 0/90° within 2°, closes gaps under
  5 cm, rounds thickness to 100/150/200/300 mm.
- Review before anything is added: a draft layer in its own colour, counts and area (compared
  with a printed area), doubtful walls amber and dashed, tap a draft wall to drop it; Accept /
  Try again / Discard. Accept is one command (one undo step); on a plan with walls, "Replace
  walls" with a confirm.
- Privacy: say what is sent where before the first send; send only the image.
- Failures with plain messages: bad key (401), quota (429), network/CORS, 90 s timeout and
  Cancel, bad JSON (repair once), refusal, implausible result, blurry photo, offline, partial.

Acceptance: on the sample HDB PDF ≥ 90% of wall length within 5 cm of the hand trace, rooms
close, area within 3%; Accept and Undo exact; the key never leaves the browser except to the
provider (tested); each failure leaves the plan unchanged with its message; works by finger
on a 390 px phone.

## Stage 2: suggested layouts
- Walls can be marked structural (proposed from hatching or ≥ 200 mm, confirmed by the user).
- "Suggest layouts" from the renovation bar: a short brief (household, work from home, elders,
  children, cooking, wishes, what to keep); 3 alternatives.
- Each is a list of operations on existing ids (hack, build, half, glass, door, rename),
  validated and applied to a copy of "before", so the renovation diff and change list work.
  Drafts are kept locally, not in the project.
- Cards: mini plan, name, 3 reasons, change totals, room areas ±, rule checks; Preview (before/
  after and 3D compare); "Use this" makes it the renovation (one undo step).
- Rules, checked in core (a breach drops that option): structural walls, household shelter,
  outer walls and windows untouched; bathrooms and wet kitchen stay; every bedroom keeps a
  window; doors ≥ 750 mm (bath 650), corridors ≥ 900 mm; no swing clashes; work triangle < 7 m.
  Hacking needs HDB approval: reminders, not approvals.

Acceptance: 3 options from the sample in 2 minutes; none breaks a rule (50 mocked runs);
change lists match; Use this + Undo exact; compare works; one failed option leaves the others.

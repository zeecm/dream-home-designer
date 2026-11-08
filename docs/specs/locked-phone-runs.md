# Spec: AI runs that survive a locked phone

Owner approved 8 Nov 2026 (HANDOVER §7). Three parts: **(1) resume** with a wake lock, **(2) opt-in
cloud runs**, **(3) server-stored keys: built, flag off** until Google sign-in (#21) is live.

## Decisions (8 Nov 2026)

**Lead decisions:**
- The technical limits as proposed: one cloud run per plan at a time, a 2 MB start body, the key
  wiped at the end, on Stop or failure, after 10 min with no progress and 20 min at most, results
  kept 7 days at most. (The owner removed the rate limits; see below.)
- Auto-resume (Part 1) is accepted: back within 10 min of the last progress, the plan unchanged
  and what's left within the approved figure, a run carries on with no tap.
- The privacy wording, the VAPID secret and turning cloud runs on in production wait on the
  owner (issue #56).
- Part 3 (server-stored keys) stays off until the owner says so.

**Owner decisions (issue #56); these override the spec below where they differ:**
- **No rate limits or quotas** (it is the person's own key): no per-address limits and no
  service-wide cap. Only the technical guards above stay.
- **Confirm every cloud run:** before each one, show the estimated tokens and cost (typical and at
  most) and ask to confirm, every time.
- **A privacy notice page** is needed before Part 2 ships to production.
- **The VAPID push key pair:** agents may generate it and set it as a Worker secret. If the tool
  refuses `wrangler secret put`, say so; don't work around it.
- **Production:** cloud runs stay off in production until the owner has tried one with a real
  key and said yes (on in preview).

## Problem

A designer run (`apps/web/src/ai/designer/run.ts`) is several streamed model calls, the solver and
up to 3 fix rounds: 30 s to 3+ min. Every call goes from the browser on the person's own key. On a
phone, locking the screen or answering a WhatsApp message suspends the page within seconds; the
requests in flight die. Today the runner retries a dropped request twice once the page is back
(`request.ts`, `NET_WAITS`, up to 10 min), but:

- if the phone discards or reloads the page (iOS does this often), the run is gone: the card stays
  "running" for ever or ends stopped, and "Design the rest" prices the rooms again;
- after 10 min away, or a third drop, the run halts;
- nothing tells the person to keep the screen on, or for how long;
- a whole-flat run simply can't finish if the person needs to put the phone down.

Home owners plan on the sofa, on the MRT and at the void deck with the ID. They will lock the phone.

## User stories

1. I start "Design the whole flat" on my phone, lock it for a minute, unlock: it carries on from the
   room it was on, and the rooms already done are not paid for again.
2. While it runs I see "Keep this screen open · about 2 min left", and my screen doesn't dim.
3. My phone reloaded the page while I was away: on return, the design picks up where it was, or
   asks me one question if things changed.
4. I want to start a big run and put my phone away. I tick "Run in the cloud", read in two lines
   what that means for my key, go ahead, and close the app. When I come back (or get a
   notification) the design is in my conversation, exactly as if it ran here.
5. I never want my key to leave my phone: I simply never tick it, and nothing changes for me.
6. I press Stop on a cloud run and it stops spending at once; what finished is kept.

## The three parts and PR order

| PR | Part | What | API/edge deploy first? |
|---|---|---|---|
| 1 | 1 | Run checkpoint in IndexedDB, resume on return or reload, wake lock, time left, copy | No |
| 2 | 2 | Runner made host-neutral: `run.ts`, `request.ts`, `stream.ts` and the streaming parts of `providers.ts` move to shared code (core or a new `packages/runner`, tech lead) with `fetch`, clock and storage injected. **No behaviour change**; the web app uses the moved code; all existing tests pass | No |
| 3 | 2 | Edge: `RunObject` Durable Object (one per plan), `/api/runs` routes in the Worker (never forwarded to the Go container), limits, log scrubbing, tests. Flag `CLOUD_RUNS` on in preview, off in production | Yes (edge) |
| 4 | 2 | Web: "Run in the cloud" on the cost card and priced buttons, consent sheet, live view, collect on return, copy changes (AI settings, `credentials.ts`, `_headers` comment), e2e. Production flag on after QA passes on preview | Yes (flag on) |
| 5 | 2 | Notifications: push-only service worker, web app manifest, VAPID, "Tell me when it's done" | Yes (edge), needs VAPID secret (owner) |
| 6 | 3 | Server-stored keys behind `SERVER_KEYS` (off everywhere), account-only, no UI reachable | Yes (D1 migration) |

PR 1 ships alone and helps everyone. PR 2 is pure refactor and keeps the browser and the Worker on
one runner: the cloud must never be a second implementation that drifts.

---

## Part 1: resume and wake lock

### Behaviour

**Checkpoint.** A designer run writes a run record to IndexedDB (`dhd-talk`, beside the
conversation) at its start and after every finished step (layout, each room, each fix round):
run id, proposal id and letter, `RunPlan`, the level fingerprint it started on, each step's status,
fix requests left, usage so far, the approved figure ("at most"), started at, last progress at.
The proposal option already saves its design after each step; the record adds what's needed to
carry on. The record is removed when the run ends (done, stopped, halted, failed).

**One owner.** The running tab holds a Web Lock named for the run (as `talk/turn.ts` does for
replies). A record whose lock nobody holds is an interrupted run.

**Coming back, same page (the usual case: locked 30 s).** On `visibilitychange` to visible (and
`online`): finished steps stand; steps that were in flight are sent again at once. These re-sends
do not count as the network retries in `request.ts` (a lock is not a bad connection). The cut-off
attempt is metered "~" as today. No question is asked.

**Coming back after a reload or discard.** On opening the conversation for that plan:
- auto-carry on, no tap, when all hold: back within **10 min** of the last progress, the plan's
  level fingerprint is unchanged, and what's left (at its high) still fits under the approved figure
  and the tab's limit;
- otherwise the card shows the interrupted state with one question (copy below). Carry on resumes
  from the last finished step; Keep as it is ends it as "stopped" (today's stopped card, with its
  "Design Kitchen too" priced press).

**Wake lock.** While a run is running (not paused, not waiting for the person), the app holds a
Screen Wake Lock. It is re-requested on return to visible (the browser drops it when hidden) and
released when the run ends, pauses at a limit, or is stopped. No wake lock for chat replies.

**Time left.** Shown on the running card: from the steps left, timed by this run's own finished
steps (median per kind), else defaults (layout 45 s, room 30 s, fix round 20 s, two rooms at a
time). Rounded: "about 3 min left", "about 1 min left", "less than a minute left", "almost done"
on the last step. Recomputed after each step only (no ticking clock); never goes up by more than
one minute between updates unless a fix round starts ("fixing 1 problem · about 1 min left").

### Copy

| Where | Text |
|---|---|
| Running card, phone/tablet (`pointer: coarse`) | **Keep this screen open** · about 2 min left |
| Under it, small, phone | Locking your phone pauses the design. It carries on when you come back. |
| Running card, desktop | Designing · about 2 min left |
| Wake lock refused or unsupported, phone | Keep this screen open · about 2 min left. Your screen may turn off on its own: tap it now and then. |
| Event on return, same page | Back. Carrying on from Bedroom 2: 3 of 5 rooms done, not paid for again. |
| Event on auto-carry on after reload | Picked up where it stopped: 3 of 5 rooms done, not paid for again. |
| Interrupted card (asks) | This design stopped when the page closed. 3 of 5 rooms are done and kept. [Carry on · at most US$0.40] [Keep as it is] |
| Same, plan changed | …Your plan has changed since. [Carry on with the plan as it is now · at most US$0.40] [Keep as it is] |
| Cut-off note in the message's cost detail | Bedroom 2 was cut off when the screen locked and sent again: about ~US$0.03 extra may be billed. |

The figure on Carry on is the remaining steps at their high plus fix rounds left (the existing
`remainingHigh`), bound to the press like Go ahead.

### Edge cases (Part 1)

| Case | Behaviour |
|---|---|
| Away more than 10 min, page alive | No auto re-send; the card asks (Interrupted card). Today's 10 min halt is replaced by this |
| Offline on return | Card: "Waiting for the connection… 3 of 5 done." Carries on when `online` fires |
| Two tabs, run tab alive | Other tab shows "Designing in another tab" with no Stop (today's rule) |
| Two tabs, run tab closed | Whichever tab opens the conversation first takes the lock and resumes or asks; the other sees "in another tab" |
| Stop pressed | Ends it; record removed; never resumed; no wake lock |
| Paused at the tab's limit when the page died | On return: the pause question again, not auto-carry on |
| Key forgotten or changed meanwhile | Asks; with no key, Carry on opens AI settings. A different provider or model: "Carry on with Claude Sonnet 5.5? It was started with Claude Opus 5.5." and the figure re-priced |
| Layout step was in flight | Re-sent whole (it's one call); rooms only start after it |
| Private window, no IndexedDB | Resume works only while the page lives; reload loses the run (today's memory warning) |
| Low-power mode refuses the wake lock | Refused copy above; nothing else changes |
| Plan deleted meanwhile | Record dropped silently with the conversation |

### Acceptance criteria (Part 1)

1. Start a 5-step run (recorded streams). Fire `visibilitychange` hidden after step 2 with step 3
   in flight, abort its stream, then visible: steps 1-2 are not requested again (request count),
   step 3 is requested once more, the run finishes, the cut-off attempt shows "~" in the detail.
2. Same, but the 3rd and 4th hide/show cycles during one run still carry on (no halt after the 2nd).
3. Reload the page mid-step 3 (`page.reload()`): within 10 min and plan unchanged, the run resumes
   with no tap, steps 1-2 not requested again, and the event line says "Picked up where it stopped".
4. Reload, then move a wall before reopening: the card asks with "Your plan has changed since", and
   nothing is requested until Carry on.
5. Advance the clock past 10 min after the last progress, reload: the card asks; Keep as it is gives
   today's stopped card with "Design … too" priced.
6. The Carry on figure equals `remainingHigh` for the steps left; the press is refused (cost card)
   if the re-priced figure is higher than the button showed.
7. `navigator.wakeLock.request('screen')` is called when the run starts, again after each return to
   visible, and the sentinel is released on done, stop and pause (stubbed API, call log).
8. On a 390 px phone profile the running card shows "Keep this screen open" and a time-left line;
   on 1280 desktop it shows "Designing · about N min left" without "Keep this screen open".
9. With `navigator.wakeLock` undefined, the refused copy shows and the run is unaffected.
10. Time left only changes when a step ends, uses the listed rounding, and says "almost done" on the
    last step.
11. Two tabs: the second tab never sends a request while the first holds the run lock; after the
    first closes, exactly one tab resumes (request count across both).
12. Stop, then reload: no resume, no question, no record left in IndexedDB.
13. No run record, key or price is in the project document, export, share link or any `/api` request.

### Part 1 as built (8 Nov 2026)

- The checkpoint is `ProposalOption.run` (`RunCheckpoint` in core's talk schema), written in the
  same IndexedDB write as the option's saved rooms; no record version bump (an older build leaves
  it out). The Web Lock is `dhd-run:{run id}`. The resume plan is priced in the designer's worker
  (`resume` in `talk/pricing.ts`).
- The runner's requests carry `resumeOnReturn`: a step cut off while the page was hidden (or one
  that went quiet meanwhile) waits for the page to be back and online, then goes again at once,
  not counted as a network retry. Each send pays for its prompt again, so one step is sent again
  at most twice, and never past the run's figure or the tab's limit (the room gate's own check,
  as `mayRetry`); past either, or away more than 10 min, the run ends `interrupted` and its card
  asks. Talk calls keep their own recovery as it was.
- What a run spent is written to its checkpoint as each request is metered, with each step in
  flight and the most it may cost (`inflight`). Carrying on counts the steps that were in flight
  at their most as spent (a page that died mid-step never metered them), so by itself it never
  goes past the figure it was approved for.
- Stop, or opening another plan mid-run, marks the checkpoint `stopped` before the requests are
  aborted, and the run's end is written into its own plan's record whichever plan is open: a
  stopped run is never carried on or asked about.
- An older build reading a record drops the checkpoint (it doesn't know it). The option is then
  running with nothing to carry on from: this build's card shows it as stopped, with its "Design …
  too" buttons.
- Differences from the copy above: the cost detail says "Kitchen was cut off and sent again: about
  ~US$0.03 extra may be billed." (the cause isn't kept after a reload); a run paused at a limit
  when the page died asks with the interrupted card, not the pause question; a Carry on priced
  higher since says "The price has gone up since; check it again before going ahead." and shows
  the new figure on the button.
- Tests: `run.test.ts` (cut off while hidden, four times running; away 11 min; killed, then carried
  on from the checkpoint, with Carry on's figure), `timeLeft.test.ts`, `wakeLock.test.ts`, and
  `e2e/designer.spec.ts` "a locked phone" (criteria 1-13).

---

## Part 2: opt-in cloud runs

### How it works (for the spec reader; the tech lead owns the design)

- Start: `POST /api/runs` with the plan id (bearer: owner or edit token), the run's inputs (context
  snapshot, `RunPlan`, draft, price table incl. the person's own overrides, approved figure, the
  tab's limit left, design options) and, **in the JSON body only**, the provider, model and key.
- The Worker checks the role through the API, then hands the run to the plan's `RunObject`
  (`idFromName(projectId)`), which runs the shared runner with the solver from `packages/core`.
  The key lives in that object's memory only; its storage holds inputs, step results and usage,
  never the key. `/api/runs` is never forwarded to the Go container.
- The browser gets a run id and a run token (random, kept in IndexedDB with the conversation).
  `GET /api/runs/{id}` (state and results so far) and a live stream (SSE or WebSocket) need the run
  token. `POST /api/runs/{id}/stop`, `.../finish` (go on past a limit), `.../resume` (key again).
- On return the app collects: each finished step goes into the proposal option through the same
  save path as a local run, the usage into the conversation and this tab's spend, then the result
  is re-checked on the plan as it is now (v1 re-check). Then `DELETE /api/runs/{id}`.
- Results are kept with the plan on our server (under the plan, not in the plan document: **no
  schema change**) until collected, at most **7 days**, and deleted with the plan.

### Behaviour

**Where it's offered.** On every priced press that starts a designer run (cost card's Go ahead,
scope buttons, Another idea, Design … too, Carry on): a choice under the figure. Only when the plan
is saved on our server, the person can edit it, the model's price is known, and `CLOUD_RUNS` is on.
Never on view links. Default every time: **On this device**. The choice is not remembered.

- Desktop: a two-option segmented control under the price: "On this device | In the cloud".
- Phone: the same, full width, 44 px. On a phone, if the run's time estimate is over 1 min, a hint
  line: "Takes about 3 min. To put your phone away, run it in the cloud."

**Every cloud run:** choosing "In the cloud" opens a short consent sheet (bottom sheet on phone,
dialog on desktop) with the run's estimated tokens and cost, typical and at most, to confirm, every
time (owner, #56). The one-line reminder below sits under the choice.

**While it runs:** the card looks like a local run (steps, thinking line, ghosts as steps land)
plus a "Running in the cloud" chip. No wake lock. Closing the tab or locking the phone changes
nothing. On return the card catches up from the server.

**Stop:** sends stop; the server aborts its provider requests, wipes the key, keeps finished steps;
cut-off steps are "~", as local.

**Paused at a limit (approved figure or the tab's limit as sent):** the server pauses and holds the
key for at most 10 min. The card (and a notification, if on) asks Finish or Stop. Unanswered: it
stops, wipes the key, and keeps what's done.

### Copy: consent and privacy

**Consent sheet** (title, body, checkbox, buttons):

> **Run this design in the cloud?**
>
> Your phone or computer can be closed while it runs. To do that, this design runs on our server:
>
> - Your Claude key is sent to our server for **this design only**. It is used to call Claude for
>   you, kept in memory, never saved or written to a log, and wiped when the design ends, when you
>   stop it, or after 20 minutes at most.
> - Your plan and what you've told the designer go with it, to design from. The result waits on our
>   server until you open the plan again, at most 7 days, then it's deleted.
> - Claude bills your key exactly as it would here: the same price, shown before you go ahead. We
>   don't charge for this.
>
> ☐ Send my key for this design
>
> [Run in the cloud · about US$0.90] [Run on this device]

("Claude" is the provider's short name: Claude, OpenAI or Gemini.) The primary button is disabled
until the box is ticked. "Run on this device" goes ahead locally at the same figure.

**One-line reminder** (later runs, under the choice when "In the cloud" is picked):
"Your key goes to our server for this design only, and is wiped when it ends. What this means"

**AI settings note** (replaces the current second sentence in `AiSettingsDialog.tsx`):
"Your key is kept in this browser only and goes, with what you send, only to the provider you
pick. The one exception is a design you choose to run in the cloud: then the key goes to our server
for that design only, is used only to call your provider, and is wiped when it ends. It's never
saved or logged there."

**What changes in the promise.** Today: "kept in this browser only … never in a request to our
server". After: still kept (at rest) only in this browser; still never in a project, export, share
link, or any request to our server **except** the body of `POST /api/runs` (and `/resume`) for a
run the person ticked. Update to match: the `credentials.ts` header comment, the `_headers` CSP
comment, HANDOVER §4 (AI) and the e2e that checks keys never reach `/api`.

**Other copy**

| Where | Text |
|---|---|
| Chip on a running cloud card | Running in the cloud |
| Under it | You can close the app. The design will be here when you're back. |
| Return, done | Designed in the cloud while you were away: 5 of 5 rooms. US$0.84 on your Claude key. |
| Return, still running | Still running in the cloud: 3 of 5 rooms done. |
| Stop sent, offline | Can't reach our server, so the design is still running there and may keep spending, at most US$0.40 more. It will stop as soon as you're back online. [Stop now] stays pressed |
| Not offered: local plan | Running in the cloud needs the plan saved online. |
| Not offered: unknown price | Running in the cloud needs a model with a known price, so your limit holds. |
| Another run on this plan | A design is already running in the cloud for this plan. Try again when it's done, or run this one on this device. |
| Server restarted mid-run (key lost) | The cloud run was interrupted. 3 of 5 rooms are done and kept. [Carry on in the cloud · at most US$0.40] [Carry on on this device] [Keep as it is] |
| Key refused / quota, in the cloud | Same as local (v1 copy), plus "Your key has been wiped from our server." |
| Results expired | This cloud design waited 7 days and was deleted. Nothing was charged after it finished. |

### Cost and price

- **No change to model billing.** The same provider calls, the same prompt caching, the same
  `estimatePlan` figure, the same "at most" with up to 3 fix-ups, the same Go ahead binding, the
  same per-message cost and conversation total. A cloud run is a cost card choice, not a new card.
- The server enforces the approved figure and the tab limit left (sent at start) with the same
  pause rules; the person's own price overrides go with the run so the server meters identically.
- Usage lands in the conversation and in the spend meter of the tab that collects it.
- We charge nothing. Our own Cloudflare cost is bounded by the limits below.

### Offline, tab closed, two tabs, Stop

| Case | Behaviour |
|---|---|
| Offline at start | Choice disabled: "You're offline." (Local runs behave as today) |
| Goes offline mid-run | Run continues on the server; card: "Running in the cloud. Offline here: it'll update when you're back." |
| Tab closed / phone locked / app switched | Nothing happens to the run. Run token stays in IndexedDB |
| Reopen, run done | Collected at once into the card, then deleted on the server; event line "Designed in the cloud…" |
| Reopen with tab-only key gone | Collection needs only the run token, not the key |
| Two tabs, same browser | Both show the live card (same token); Stop from either; collection is once, keyed by run id |
| Another device or person (edit link) | Can't see the run; starting one gets the "already running" line; local runs there are not blocked by us (their own key) |
| Stop | As above; offline Stop is queued and retried with the offline copy |
| Plan deleted mid-run | Run stops, key wiped, results deleted |
| Plan edited during the run (any device) | Run uses the snapshot it started with; on collection it's re-checked on the plan as it is (v1) |

### Notifications (PR 5)

- Never asked on load or on first visit. Offered only on a running cloud card: [Tell me when it's
  done]. Tapping it calls the browser's permission prompt.
- Granted: a push subscription goes with the run and is deleted when the run ends. One notification
  per run, on done, stopped by a limit pause, or failure. Text carries no plan content:
  "Your design is ready" / "Your design is paused at your spending limit" / "Your design couldn't
  finish", title "Dream Home Designer". Tapping opens the plan's conversation.
- Denied or dismissed: the button becomes "Notifications are off for this site in your browser
  settings." and is never shown again in that browser.
- iPhone and iPad: web notifications work only from the Home Screen app. In Safari the button says
  "To be told on iPhone, add this app to your Home Screen (Share, Add to Home Screen)." Needs a web
  app manifest and a push-only service worker (no offline caching in this spec).

### Limits

- **One cloud run per plan at a time** (the `RunObject` is per plan; second start gets 409). And
  never a local and a cloud run on one plan at once in the same browser.
- **No rate limits or quotas** (owner, #56): no per-address limits and no service-wide cap.
- **Timeouts:** run wall time 20 min, then stopped with finished steps kept; key wiped at the end,
  on Stop, on a refused key or quota, after 10 min paused, or 20 min after start, whichever first;
  a step with no provider event for 120 s is retried as local (`QUIET_MS`).
- **Sizes:** start body at most 2 MB (413 otherwise; "This plan is too big to run in the cloud").
- **Retention:** results deleted on collection, or after 7 days uncollected.

### View and share links: never

View links, edit links shared with others, exports, the project file, version history and the
contractor sheet never show, include or start a cloud run. Run endpoints refuse a viewer token
(403) and any request without the run token for reads. Run records are not in `GET /projects/{id}`.

### Edge cases (Part 2)

| Case | Behaviour |
|---|---|
| Provider rate limit in the cloud | Same waits as local (15 s, 30 s), one room at a time |
| Provider error text echoes a masked key (OpenAI "sk-…abcd") | Scrubbed before it's stored or logged; the card shows the provider's message without it |
| Worker deploy or Durable Object restart mid-run | Key lost by design; run marked interrupted; card offers Carry on in the cloud (sends the key again for the same run, no new consent), on this device, or Keep as it is |
| Clock skew between device and server | Times from the server only |
| Person forgets the key in AI settings mid-run | The cloud run carries on (its copy is in server memory until it ends); AI settings says "A design is running in the cloud with this key. [Stop it]" |
| Person changes key mid-run | No effect on the running design |
| Private window | Allowed, with "This private window forgets the run when it closes. Keep it open to see the result." |
| Results never collected | Deleted after 7 days; the card on next open shows the expired line |
| Two cloud runs on two plans | Allowed (per-plan limit), within the address limits |

### Acceptance criteria (Part 2)

Provider calls are mocked in tests (recorded streams); no test calls a real provider.

1. With `CLOUD_RUNS` off, no cloud choice appears anywhere and `/api/runs` returns 404.
2. The choice appears on Go ahead, scope buttons, Another idea, Design … too and Carry on; not on a
   view link, a local-only plan, an unknown-price model, or offline (each with its line).
3. Default is On this device on every run, including straight after a cloud run.
4. Every cloud choice opens the consent sheet with the run's estimated tokens and cost (typical and
   at most); the primary button is disabled until the box is ticked; "What this means" opens the
   sheet.
5. The consent and AI settings copy match this spec word for word (provider name substituted).
6. The cost figure on the cloud button equals the local one for the same press.
7. The key appears only in the JSON body of `POST /api/runs` and `/resume`, never in a URL, header,
   query, other `/api` request, IndexedDB run record, or the project document (e2e request log).
8. Edge unit test: after a run with a canary key, the Durable Object's storage and every captured
   `console.*` line contain no canary substring; after the run ends, the object holds no key.
9. Manual on preview: a run with a canary key, then a Workers Logs search for the canary returns
   nothing.
10. A run started, then the page closed: the run finishes on the server (edge test with mocked
    provider); reopening collects it into the proposal with the same steps, design and usage as the
    same run done locally from the same recordings; then `GET /api/runs/{id}` is 404.
11. Stop from the card ends provider requests within 2 s (mock sees aborts), keeps finished steps,
    marks cut-off ones "~".
12. Stop while offline shows the offline copy and is sent when `online` fires.
13. A second start on the same plan gets 409 and the "already running" line. No start is refused
    for how many runs an address or the service has started (owner, #56).
14. Paused at the approved figure: the card offers Finish/Stop; untouched for 10 min (fake clock),
    the run stops and the key is wiped.
15. Run wall time over 20 min (fake clock): stopped, finished steps kept, key wiped.
16. A viewer token gets 403 on every `/api/runs` route; reads without the run token get 403.
17. Deleting the plan mid-run stops it and deletes its run data (edge test).
18. A simulated object restart mid-run marks it interrupted; Carry on in the cloud sends the key
    once more and does not request finished steps again.
19. Provider 401 text with a masked key is scrubbed in the stored step error and in logs.
20. Phone 390 px, fingers only: choice, consent sheet, running chip, return state are all reachable
    with 44 px targets and no sideways scroll; screenshots reviewed (ux-reviewer).
21. Notifications (PR 5): no permission prompt before "Tell me when it's done"; granted, one push
    on done with the listed text and no plan content; denied, the settings line and no more prompts;
    Safari not installed shows the Home Screen line.

---

## Part 3: server-stored keys (built, disabled)

- Account-only (`/api/me/keys`): save, list (provider and last 4 characters only), delete. Sealed
  with AES-GCM under `KEYS_SECRET` like owner keys; a key is never returned once saved; used only
  by a cloud run started by that account, decrypted into the run's memory.
- Behind `SERVER_KEYS`, **off in production and preview**; turning it on is the owner's decision
  after #21. No UI reachable while off (not hidden by CSS: not rendered).

### Acceptance criteria (Part 3)

1. With `SERVER_KEYS` off (both wrangler envs), every `/api/me/keys` route returns 404 and no UI,
   copy or setting mentions saved server keys (DOM search).
2. In unit tests with the flag on: save, list (last 4 only), use in a cloud run, delete; D1 rows
   contain no plaintext key; a different account can't list or use it.
3. Deleting the account deletes its keys.

---

## Out of scope

- Cloud for chat replies, plan tracing and photo-real renders (single requests; chat already
  recovers from its checkpoint).
- Seeing or collecting a cloud run on another device (needs accounts; with Part 3 later).
- Charging for cloud runs, or running on our own key.
- Offline caching or a full installable app beyond the push-only service worker and manifest.
- Background Sync or keeping local runs alive in the background (browsers don't allow it reliably).
- Turning on server-stored keys.

## Telemetry

One usage event `cloud-run` with detail `start`, `done`, `stopped`, `interrupted` or `expired`; no
ids, plan content or keys (add to `EVENT_NAMES`).

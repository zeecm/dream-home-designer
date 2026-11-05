# Design: AI walls from a plan image (stage 1)

Spec: `ai-layouts.md`. This is the technical design for stage 1 (keys + trace), and the
seams stage 2 (suggested layouts) and the AI render reuse.

## Keys and providers (browser only)
- `apps/web/src/ai/keys.ts`: `{ provider: 'anthropic' | 'openai' | 'gemini', key, model }`
  in localStorage (`dhd-ai`), this browser only. Never in the project, exports, share
  links, `/api` requests or logs. View-only links have AI off.
- `apps/web/src/ai/providers.ts`: one interface,
  `readPlan(image, prompt, schema, signal): Promise<unknown>` (JSON matching the schema),
  three implementations, all called straight from the browser:
  - Claude: official `@anthropic-ai/sdk` (`dangerouslyAllowBrowser: true`, which is the
    point: the user's own key in the user's own browser), model `claude-opus-5-5` by
    default, image as base64, JSON via `output_config.format` (json_schema), server-side
    refusal fallback (`fallbacks: "default"`), `stop_reason` checked before reading.
  - OpenAI: `POST https://api.openai.com/v1/chat/completions` with `response_format`
    json_schema (strict), image as a data URL. Model typed by the user (default given).
  - Gemini: `POST generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
    with `responseMimeType: application/json` and `responseSchema`, image as inlineData.
- Errors mapped to one set: bad key, quota or rate limit, unreachable, timeout (90 s, with
  Cancel), refused, unreadable answer.

## What the model is asked for (core: `packages/core/src/trace.ts`)
- A zod schema, `PlanReading`, in the image's own pixels (the model sees pixels; metres
  come from the plan's calibration, so a wrong guess of scale can't distort the result):
  walls `{ a: {x, y}, b: {x, y}, thickness_px }`, openings `{ kind, a, b, swing_side? }` (as a
  span along a wall), rooms `{ name, at }`, and the printed total area if it sees one.
- `readingToPlan(reading, underlay)`: pixels to metres (`underlayToWorld`), then cleaned:
  walls within 2° of the plan's axes straightened, ends within 5 cm merged into shared
  corners (walls share vertex ids), ends that stop just short of a wall joined onto it,
  thickness rounded to 0.1 / 0.15 / 0.2 / 0.3 m, openings put on the nearest wall they
  run along, rooms found from the walls (`syncRooms`) and named from the nearest label.
  Pure and unit-tested with hand-made readings.
- `importTrace(levelId, plan, ids)`: one `Command` (ids made outside the recipe) adding the
  corners, walls and openings, or replacing the level's walls (Replace walls), one undo step.

## UI
- Project menu "AI assistant…": provider, key (password field), model, Test, Forget, and
  "Your key and plan image go only to <provider>, from this browser."
- Plan image panel (after Set scale): "Trace walls with AI". Disabled with a reason until
  there is a key, a plan image and a scale.
- Running: a progress card over the plan with Cancel. Done: the draft drawn over the image
  (accent colour, dashed for doubtful walls), counts (walls, doors, windows, rooms, area vs
  the printed area), Accept / Try again / Discard. Accept is one undo step.

## Later stages reuse
- Suggested layouts: the same providers, a different schema (operations on existing ids),
  validated in core and applied to a copy of "before" as a renovation.
- Photo-real render: the 3D view's PNG sent to an image model (OpenAI or Gemini image
  generation; Claude has no image output) with a style prompt.

## Risks
- A key in localStorage is readable by any script on the page: no third-party scripts, add
  a Content-Security-Policy with `connect-src` limited to our API and the three providers.
- Model accuracy on photos and low-resolution scans: the review step, and the hand tools
  to fix what it gets wrong.

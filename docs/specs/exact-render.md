# Spec: Exact render (photo-real, drawn by the app)

Spec by the project-manager agent, 6 Nov 2026. Slice 0 (spike) S, slice 1 M. No schema change,
no API change.

**Problem.** Owner, 6 Nov: "the ai render still adds furniture where there aren't any and adds
doors or wall holes where there aren't any in the plan" and "It should be EXACTLY like in the
designed layout, just making it look like a real life render". An image model repaints the
picture, so no prompt can promise that (PR #38 makes it less likely). The answer is a render
the app makes itself: a path tracer that draws the real 3D scene, so every wall, door, window
and piece is where the plan has it, by construction, with real light. Free, no key, nothing
leaves the device.

## The engine (checked 6 Nov 2026)
- `three-gpu-pathtracer` (MIT, Garrett Johnson). Latest **0.0.28** (2 Nov 2026) is
  **WebGPU-first** (`WebGPUPathTracer`, `three/webgpu`) and needs **three ≥ 0.187**; its
  `WebGLPathTracer` is still exported but logs "deprecated". 0.0.24 (Feb 2026, last WebGL-only
  release) needs three ≥ 0.180. We are on **three 0.170** (web and render), R3F 8, drei 9.
- **0.0.23** (June 2024) declares three ≥ 0.151 and three-mesh-bvh ≥ 0.7.4. Checked: every name
  it imports from `three` exists in 0.170, and the three-mesh-bvh it needs (0.7.8) is already in
  our lockfile (via drei). Built module 222 KB, **54 KB gzip**.
- WebGL2 required (float render targets); one-sample-per-pixel progressive; supports
  MeshStandard/MeshPhysical only (transmission, ior, clearcoat, sheen, normal maps, emissive);
  directional, point, spot (with radius), rect and circular area lights (direct lights via MIS);
  environment maps (`GradientEquirectTexture`, `ProceduralEquirectTexture`); tiles,
  `renderScale`, `dynamicLowRes`, `minSamples`, `DenoiseMaterial` (smart denoise);
  `CompatibilityDetector` (precision and shader-compile checks). No instanced or interleaved
  geometry; all textures share wrap/filter flags. Point lights have no radius (hard shadows).
- **Decision for slice 1: pin `three-gpu-pathtracer@0.0.23` with WebGL2, lazy-loaded, behind
  our own `ExactEngine` interface** (start, sample, stop, read pixels, dispose), so a WebGPU
  engine (0.0.28) can replace it when three is upgraded (slice 5, tech-lead and owner: the
  three/R3F/React upgrade is a standing decision in HANDOVER §2).

## User stories
1. As an owner showing my spouse the plan, I want a picture that looks like a photo of *our*
   flat, with nothing added, so we decide on what we will really build.
2. As someone without an AI key, I want photo-real pictures for free.
3. On my phone in the walk-through, I want to stop where I stand and get a real-looking picture
   of that spot.
4. I want to see the room at 9 am and at 7 pm, with the lamps on, to judge light and colour.
5. I want to download the picture at a good size to send to my ID or family chat.
6. (Optional) I want an AI "polish" of the exact picture, told plainly that it may change details.

## Behaviour

### The dialog (same "Photo-real render" button on the 3D view and in the walk)
Top of the body, a two-way switch: **Exact** | **AI impression**. Opens on **Exact** every
time (not remembered: the owner's expectation is exactness). AI impression is today's dialog,
unchanged.

Exact, as it opens:
1. Same "Render from" choice as today (orbit/outside views: "From eye height in <room>"
   default, or "From this view"); the walk skips it.
2. It starts by itself (it's free): "Preparing the scene…" (lazy load, build, BVH, shader
   compile; first time on a device can take longer: say so after 5 s: "Getting the renderer
   ready; the first time takes longest."). Then the picture appears and sharpens in place.
3. Note under the picture: "Drawn by the app from your 3D model: walls, doors, windows and
   furniture are exactly as planned. Made on this device, free."
4. Foot (sticky, as today): progress line, then actions.
   - Progress: `Sample 48 of 256 · 0:12` and a thin bar; when done: `Done · 256 samples ·
     0:41`. Screen readers get "Render done" once (aria-live polite), not every sample.
   - Actions: **Stop** while running (keeps the picture as it is), **Carry on** after a Stop
     (resumes from the same samples), **Download** (enabled from the first picture),
     **Polish with AI** (slice 4).
   - Settings row (slice 2): Quality (Quick / Good / Best), Time, Lamps (Auto / On / Off),
     Brightness slider. A change to Quality, Time, Lamps or Render from restarts the samples;
     Brightness does not (it is exposure, applied at display).
5. Tapping or clicking the picture opens it full screen (slice 2; pinch zoom on touch; Esc or
   Close).
6. Closing stops the render, frees its GPU memory and removes its canvas; the 3D view or walk
   carries on from the same spot (as today).

While the Exact tab renders, **the 3D view underneath stops drawing** (R3F frameloop paused) so
the GPU serves one job; it resumes on close or on switching to AI impression.

### Desktop (≥ 900 px wide)
Dialog `min(960px, 100vw − 32px)`; picture up to `min(60vh, 540px)` tall at the view's aspect.

### Phone portrait
Dialog full screen as today. Picture full width, up to 55vh. Settings fold into a "Settings"
disclosure under the picture (closed by default). Foot: progress line, then Stop/Carry on and
Download; 44 px targets.

### Phone landscape (320–500 px tall)
Body in two columns: picture left (full body height), progress, settings and actions right,
scrolling on its own. No control under the home indicator.

### Walk-through
Opened from the walk's camera button: the walk pauses (`paused`, sticks released), the render
uses the walk camera exactly (position, direction, field of view), ceilings on. Close: the walk
resumes at the same pose.

## Picture, progress and quality
| Quality | Samples | Long side (desktop / phone) | Time cap (desktop / phone) |
|---|---|---|---|
| Quick | 64 | 1280 / 960 | 30 s / 45 s |
| Good (default) | 256 | 1600 / 1280 | 90 s / 120 s |
| Best (desktop only) | 1024 | 2560 | 6 min |

- Aspect = the view's (walk: the screen's). Download is the rendered pixels, PNG,
  `<plan>-exact-render.png`; no upscaling.
- Slice 1 has Good only (desktop 1600, phone 1280, the same caps).
- It stops at the sample target or the time cap, whichever first, and says which:
  "Stopped at 2 min: 140 samples. Carry on for a cleaner picture."
- Early samples are shown through the denoiser and at `lowResScale` while moving from 1 to
  ~16 samples, so the first picture reads cleanly; past 64 samples the denoiser fades out.
- Tab hidden: pause; visible again: carry on. Each frame's GPU work kept small (tiles) so Stop,
  Close and scrolling answer within 200 ms.
- "Phone" = coarse pointer or a screen under 900 px; phones also get `bounces` 3 (desktop 5),
  `textureSize` 512 (models' textures are 512 px already), `transmissiveBounces` 6 everywhere.

## Devices that can't, or are too slow
- No WebGL2, `CompatibilityDetector` fails (precision, shader), or a lost context at start:
  the Exact tab is disabled with a reason ("Exact renders need WebGL 2, which this browser
  doesn't have." / "This device's graphics can't run the exact render."), and the dialog opens
  on AI impression with today's behaviour; no key, no render, and it says both.
- Too slow: after 4 samples the app estimates time to target. If over the cap: "This will
  take about 6 min here; it stops at 2 min. Try Quick." (slice 2 offers the Quick button
  inline). Slice 1 just renders to the cap.
- Context lost mid-render: keep the last picture, "The graphics card reset; your picture so
  far is kept. Try again (Quick is lighter)."
- Shader compile over 30 s or a failed compile: stop with "Couldn't start the exact render on
  this device." and offer AI impression.

## Camera
- Exactly the camera of the chosen view: orbit view as is ("From this view", ceilings off, a
  cut-away "doll's house" render), eye height via the existing `eyeLevelCamera` (1.6 m, 70°,
  8° down, ceilings on), or the walk camera (ceilings on).
- Same field of view, near 0.02 m. No depth of field, no lens distortion, no auto-straightened
  verticals (later idea).
- The exact render and the AI tab share the chosen camera, so switching tabs compares like for
  like.

## Scene: the same geometry, new materials and real light
**Geometry by construction.** The scene is built by the same `LevelMeshes` (packages/render)
the 3D view uses, from the version shown (before/after), with a photo material cache passed in
place of `MaterialCache`. Nothing is added except lights, the sky and a ground plane. Models are
the same GLBs (`ModelLibrary`). Electrical points, aircon, trunking, people, glass and half
walls come along unchanged. Wait up to 10 s for models in view to load; still loading: render
with their boxes and say "2 pieces were still loading and show as boxes."

### Materials mapping (packages/render, `photoMaterial(id)`, MeshPhysicalMaterial)
Colours stay the finish's colour (the plan's swatch), so the picture matches what was chosen.
"Slice 3" is the texture added later; slice 1 is colour and the parameters given.

| Material id | Slice 1 parameters | Slice 3 texture |
|---|---|---|
| `wood-oak`, `wood-walnut` | roughness 0.5, clearcoat 0.3 (cc rough 0.35) | planks 1.2 × 0.18 m, grain, V-grooves |
| `vinyl-ash` | roughness 0.55, specularIntensity 0.4 | planks 1.2 × 0.18 m |
| `tile-grey`, `tile-white` | roughness 0.3 | 600 × 600 mm, 2 mm grout (grey) |
| `marble` | roughness 0.1, clearcoat 1 (0.05) | veins, 600 × 600 slabs |
| `concrete` | roughness 0.45 | mottled, trowel marks |
| `carpet-grey` | roughness 1, sheen 0.6 (sheen rough 0.8) | fibre normal |
| `paint-*` (presets, custom `paint-#rrggbb`, ceilings) | roughness 0.9, specularIntensity 0.3 (matt emulsion) | none |
| `wallpaper-*` | today's canvas pattern as `map`, roughness as listed | fluted: normal map |
| `door` | roughness 0.45 (laminate) | wood grain |
| `aluminium` | roughness 0.45, metalness 0 (powder coat) | none |
| clear glass (walls, fixed glass, windows, glazed leaves) | transmission 1, roughness 0, ior 1.5, thin (thickness 0), colour #f4faf8 | none |
| frosted glass | transmission 1, roughness 0.45, ior 1.5 | none |
| `furniture-wood` / `-wood-dark` | roughness 0.55 | grain |
| `furniture-fabric` / `-fabric-light` | roughness 0.95, sheen 1 (sheen rough 0.7) | weave normal |
| `furniture-white`, `-charcoal` | roughness 0.45 | none |
| `furniture-metal` | metalness 1, roughness 0.35 | none |
| `furniture-glass` (TV screens, dark glass tops) | roughness 0.05, clearcoat 1, no transmission | none |
| `furniture-ceramic` | roughness 0.2, clearcoat 1 | none |
| `furniture-leaf` | roughness 0.7, sheen 0.3 | none |
| `furniture-figure` | roughness 0.85 | none |
| `furniture-lamp` (shades) | emissive #ffe2b8 only when lamps are on, else none | none |
| `faceplate` | roughness 0.3, **no emissive** (the 3D view's brightening trick) | none |
| `furniture-placeholder` | roughness 1 | none |
| unknown id | today's fallback colour (magenta, so it gets noticed in review) | none |
| Poly Haven GLBs | their own PBR maps as loaded; materials the pipeline made plain-transparent glass become transmission 1 | n/a |
| Uploaded GLBs | as loaded; Basic/Lambert/Phong converted to Standard with the same colour and map | n/a |
| Ground (outside) | `#9a9a94`, roughness 1, at the level's elevation − 0.01 m | none |

### Light sources
| Source | How | Notes |
|---|---|---|
| Sky | environment `GradientEquirectTexture`: zenith from today's sky colour by `daylight`, horizon lighter, below horizon the ground colour | Lights rooms through windows and doorways; indirect light (GI) replaces the 3D view's hemisphere, ambient and "even" fills, which are **not** used |
| Sun | `DirectionalLight` along `sunDirection(site, sunPosition(site, day, hour))`, colour as the 3D view's `sunColor`, intensity by altitude; off below the horizon | Hard-edged in 0.0.23; slice 2 tries a sun disk (0.5–1°) in a `ProceduralEquirectTexture` for soft edges |
| Ceiling lights | `PhysicalSpotLight`, radius 0.05 m, pointing down, angle 60°, penumbra 0.6 | Soft shadows under furniture |
| Pendants, floor and table lamps | `PointLight` at the bulb from `itemLights`, decay 2, **distance 0** (walls really block now), plus the glowing shade | Every lamp in the level, no 8-nearest cap |
| Intensity | `candela` from the catalogue used as is (three's physical units); the 3D view's `LAMP_SCALE` is not used | Tuned once in slice 0 against the sun and sky |

- **Lamps Auto** (default): on when `daylight < 0.35`, or when the camera's room (or its
  open-plan space) has no window to the outside; otherwise off. On / Off override (slice 2;
  slice 1 is Auto only).
- **Time**: the 3D view's Time slider hour, today's date (as now). Slice 2 adds a Time select
  in the dialog: "As in the 3D view (4 pm)", 9 am, 12 noon, 4 pm, 7 pm, 9 pm.
- **Exposure**: auto, set once from the frame's log-average luminance at 8 samples (so it
  doesn't pump), clamped to ± 3 EV; tone mapping AgX (or ACES if AgX looks wrong in slice 0).
  Brightness slider ± 2 EV on top (slice 2), live.

## Edge cases
- **Glass walls, glazed doors**: see-through with reflections; the next room lit by its own
  light. Frames solid. Frosted: light passes, view blurred.
- **Half walls, glass above**: exact heights from `LevelMeshes`; the glass above to the
  ceiling as in 3D (the known gap: it goes to the level's ceiling under a lower room ceiling).
- **Mirrors**: none in the catalogue or finishes; out of scope (the renderer would handle a
  `metalness 1, roughness 0` finish; see ideas).
- **No windows in the room, daytime**: lamps Auto turn on. No lamps either: render anyway
  (light from doorways only) and hint "Little daylight reaches this room. Add a ceiling light
  (Lighting) or turn to a room with a window."
- **Night (sun below horizon)**: sky deep blue at low intensity, windows dark, lamps on. No
  lamps in the level: hint "No lamps in this plan: add lights, or pick a daytime hour."
- **Overhead "From this view"**: no ceilings, sun from above; lamps per Auto.
- **Camera inside a wall or piece** (an orbit view inside a wardrobe): render as is; the
  eye-height default avoids it.
- **Comparing before and after**: renders the version picked above the plan, and says
  "Renovation (after)" or "As it is (before)" under the picture.
- **Many lamps (over 30)**: allowed; samples are slower; no cap.
- **Huge uploaded model** (scene over 1.5 M triangles): warn "Large models make this slow."
- **Dark mode**: the picture is not affected.
- **Dialog closed while preparing**: the load and build are dropped; no errors in the console.
- **Model failed to load**: its box renders; same note as loading.

## Polish with AI (slice 4)
- In Exact, once there is a picture with ≥ 64 samples and an OpenAI/Gemini key: **Polish with
  AI** sends the exact render (not the flat 3D view) through `renderPhoto` with a "polish"
  prompt: "This is already a correct, physically lit render of a real room. Keep every edge;
  only refine material detail and photographic finish."
- Note beside it, always: "AI may still change details. The exact render stays as the true
  picture." Result shows with a switch **Exact | Polished**; both download.
- No key: the button reads "Polish with AI (needs your OpenAI or Gemini key)" and opens AI
  settings. The AI impression tab's own input can also switch to the exact render when one
  exists (default on), since a lit render is a far better start than the flat view.

## Performance budgets (targets; slice 0 measures and records them in HANDOVER)
Reference devices: desktop = M1 MacBook Air and an Intel Iris Xe laptop (Chrome); mid phone =
iPhone 13 (Safari) and Galaxy A55 or Pixel 7a (Chrome). Scene: the sample flat furnished
(~25 pieces, ~150 k triangles), from eye height in the living room at 4 pm.
| Step | Desktop | Mid phone |
|---|---|---|
| Lazy chunk (engine + adapter) | ≤ 150 KB gzip, only when Exact opens | same |
| Prepare (build, BVH, shaders), first time | ≤ 3 s | ≤ 8 s |
| First picture on screen | ≤ 4 s after opening | ≤ 10 s |
| Good-enough (denoised, 32 samples at 1280 px long side) | ≤ 8 s | ≤ 25 s |
| Good (256 samples) | ≤ 45 s | cap 120 s (≈ 100+ samples acceptable) |
| Main-thread block per frame | ≤ 30 ms | ≤ 50 ms |
| GPU memory for the render | ≤ 500 MB | ≤ 250 MB |
| After close | 3D view back at its earlier frame rate within 1 s | same |
If slice 0 misses the phone targets: lower `renderScale` to 0.75, bounces 2, Quick default on
phones; if still missed, phones get AI impression by default with Exact as "slow on this phone".

## Out of scope
A view out of the window (neighbouring blocks, greenery): sky and ground only. Animation or
video, 360° panoramas (idea), depth of field, a white-balance control, editing materials from
the dialog, rendering in a worker or on the server, saving renders into the project.

## Acceptance criteria
Unit (packages/render and core):
1. `photoMaterial` returns the table's parameters for every id in `FLOOR_FINISHES`, `PAINTS`,
   `WALLPAPERS` and the palette; a custom `paint-#123456` gets colour #123456, roughness 0.9;
   clear glass has transmission 1; `faceplate` has black emissive.
2. **Same geometry**: for the sample flat (before and after), the exact scene's meshes are the
   same set of names as `LevelMeshes` with ceilings, and each mesh's position attribute is
   identical (same array contents); the only extra objects are lights, ground and sky.
3. Lights: lamps on gives one light per `itemLights` entry (a fixture with 12 lamps gives 12),
   ceiling ones are spot lights pointing down; lamps off gives none and no emissive shades;
   sun direction equals `sunDirection` within 1e-6; sun absent at 21:00 in Singapore.
4. Lamps Auto: on at 21:00; off at 12:00 in a room with a window; on at 12:00 in a room with no
   outside window and no open-plan neighbour with one.

E2e (Playwright, production build; a test override caps size at 160 × 120 and samples at 16):
5. 3D view → Photo-real render: the dialog opens on **Exact**, starts by itself, and shows
   `Sample n of N` with n rising over three reads; no request goes to any AI provider or `/api`
   (network log), with and without a key saved.
6. **Exactness by pixels.** Fixture project (opened from a project file): a 4 × 3 m room, walls
   painted red #c0392b, green, yellow and white; a 0.9 m *opening* (no leaf) in the red wall to
   a room painted blue #2e6fd8; a charcoal sofa against the yellow wall; oak floor; noon, lamps
   off; a fixed camera. For each check point (7 × 7 px average, ≥ 6 px from any edge, positions
   computed from the camera in the test): on the red wall left and right of the opening, hue
   within 20° of red and saturation > 0.25; inside the opening, hue within 25° of blue; on the
   plain parts of the green and yellow walls, their hues (no hole where none is planned); on
   the empty floor between sofa and camera, the oak hue and saturation > 0.2 (no added piece);
   on the sofa, saturation < 0.15.
7. Stop: within 500 ms of Stop the sample count stops rising for 2 s; Carry on raises it again
   from where it stopped.
8. Download: a PNG whose width and height match the rendered size; aspect within 1% of the
   view's; file name ends `-exact-render.png`.
9. Walk on a 390 × 844 phone (touch): the camera button opens the dialog on Exact, no "Render
   from" choice; the render's camera equals the walk pose (position within 1 mm, direction
   within 0.1°); close: the walk carries on from the same pose; the picture and Stop/Download
   are within the viewport at 390 × 844, 844 × 390 and 568 × 320, with 44 px targets.
10. Orbit view: "From eye height in Living room" is chosen; picking "From this view" restarts
    (sample count back to 1–4) and renders without ceilings.
11. No WebGL2 (an init script making `getContext('webgl2')` return null): Exact is disabled
    with "Exact renders need WebGL 2, which this browser doesn't have."; AI impression shows
    as today.
12. Closing mid-render: the exact canvas is removed from the DOM, no console errors, the 3D
    view responds to an orbit drag, and reopening starts a fresh render.
13. Switching to AI impression and back keeps the exact picture and its sample count (Carry on
    continues).
14. Night (Time 21:00, a lamp-less fixture): the hint "No lamps in this plan…" shows; with a
    ceiling light added, the frame's mean luminance is at least 2× the lamp-less one.

Manual, on the reference devices (results and screenshots in the PR and HANDOVER):
15. The budgets table, measured. 16. Sample flat at 9 am, 4 pm and 9 pm, from eye height in
the living room, a bedroom (glass partition if there is one) and the kitchen: sunlit patches
fall where the sun enters, lamps light their surroundings, no light leaks through walls,
glass reads as glass. 17. ux-reviewer: desktop, phone portrait and landscape screenshots of
preparing, rendering, done, stopped and unsupported states.

## Slices (smallest first)
- **0. Spike (S, tech-lead, a dev-only page, not shipped).** `three-gpu-pathtracer@0.0.23` on
  three 0.170: sample flat from eye height with sky, sun and lamps. Check: sun through a glazed
  window lands on the floor (shadow rays through transmissive glass; if not, panes are left out
  of shadow rays or out of the scene with frames kept), wallpaper and GLB textures render,
  shader compile time, samples per second on the reference devices, SwiftShader (CI) time for
  16 samples at 160 × 120 (budget: under 60 s, or criterion 6 moves to a nightly job), bundle
  size. Go/no-go with numbers.
- **1. Exact render, Good only (M). Recommended first build.** The Exact | AI impression switch,
  opening on Exact and starting by itself; the same cameras (eye height, this view, walk);
  photo materials with slice-1 parameters; sky, sun, every lamp with Auto; auto exposure;
  progress, Stop, Carry on, time cap; denoised early samples; Download PNG; 3D view paused
  while rendering; unsupported-device fallback; phone portrait and landscape layouts.
  Criteria 1–13.
- **2. Settings and viewing (S–M).** Quality (Quick/Good/Best), Time select, Lamps On/Off,
  Brightness (live), slow-device estimate with a Quick button, full-screen viewer with pinch,
  night and dark-room hints, soft sun disk if slice 0 showed it works. Criterion 14.
- **3. Real textures (M).** Floor planks, tile grout, marble, concrete, door grain, fabric
  weave: drawn on canvases like the wallpapers (no downloads) or CC0 maps (ambientCG/Poly
  Haven) through `tools/models`, 512 px WebP, lazy. The 3D view may use them too (tech-lead).
- **4. Polish with AI (S).** As above; AI impression starts from the exact render when one
  exists.
- **5. Later (L).** WebGPU engine (0.0.28+) after the three/R3F/React upgrade; a better
  denoiser; a fallback "enhanced 3D" picture (accumulated soft shadows and AO in the normal
  renderer) for devices without WebGL2.

## Risks
1. **Pinned to a 2024 release on a deprecated path.** No upstream fixes for WebGL. Mitigation:
   the `ExactEngine` adapter; a WebGPU engine as slice 5; patch locally via `pnpm patch` if
   needed.
2. **Phone speed, heat and memory** (iOS kills tabs over ~1–1.5 GB). Mitigation: time caps,
   `textureSize` 512, 3D view paused, everything disposed on close, Quick on slow phones.
3. **Shader compile** can take 10–30 s on some mobile and Windows ANGLE drivers. Mitigation:
   honest "first time takes longest" message; `KHR_parallel_shader_compile`; compile once per
   session and keep the engine while the tab lives (dispose its scene, not its programs).
4. **Sun through glass** may not reach the floor with MIS through transmissive panes (slice 0
   checks; fallbacks listed there).
5. **"Real life" expectations.** Flat colours path-traced look clean but CG until slice 3.
   Copy says what it is; slice 3 textures follow quickly; Polish with AI for the extra step,
   with its note.
6. **Exposure** in rooms with bright windows: blown-out windows are normal in interior
   photos, but rooms must not go dark: auto exposure plus Brightness.
7. **CI**: SwiftShader may be too slow for the pixel test; the size and sample override keeps
   it small; nightly fallback.
8. **Precision bugs on some Mali/Adreno GPUs**: `CompatibilityDetector` before the first
   render; fall back to AI impression.
9. **Two WebGL contexts** (3D view and render) on low-memory phones: pause the first; if
   slice 0 shows trouble, render with the 3D view's own renderer while its loop is stopped.

## Roadmap line (README, Planned, top)
"Exact render: a photo-real picture drawn on your device from the 3D model itself (true light
through the windows, lamps, soft shadows), so nothing is added or moved; free, no key.
[spec](docs/specs/exact-render.md)"

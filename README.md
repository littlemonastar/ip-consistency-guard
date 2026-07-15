# ip-consistency-guard

An AI tool that checks whether a generated image stays **on-model** with a registered
character — using proportion-based measurement instead of a vague "does it look similar?"
judgment.

You register a character once (reference views + traits + the ratios that define it). Then,
for any new image, the tool measures it against that character and reports a consistency
score plus exactly which rules pass or fail.

## Live app

**→ https://ip-consistency-guard-production.up.railway.app**

Just sign in with GitHub and use it — no local setup needed. Your characters and check history
are private to your account. (The [development](#run-it-locally-development) section below is
only for running or self-hosting it yourself.)

## Why proportion-based

Any round eye passes a "the eye is round" check. What actually defines a character is
**proportion** — e.g. the ratio of head height to torso height, or eye-to-nose spacing. If
those ratios drift, the character reads as off even when every individual trait is present.
So the core idea is: define the ratios that matter, then measure how far an output deviates.

**Known limitation:** current vision LLMs estimate on-image distances well but are not
pixel-precise. v1 uses LLM-estimated ratios ("reference ~2:1, this output ~2.4:1"). This is
already a step above qualitative checks; precise landmark detection is a future enhancement.

## How it works

**1. Register a character**
Upload one or more **background-removed** reference views (front, and optionally
side / back / three-quarter), each labelled with its angle. Claude (vision) extracts:
- **traits** — checkable facts (eye color, outfit, body type, …)
- **proportion rules** — the defining ratios, each tagged with which views it's measurable in
- **forbidden** — things that must not appear (extra limbs, wrong color split, …)

You edit the draft, then save. The sheet is pinned at the top of the workspace.

**2. Check an output**
Upload a background-removed output image and press **Check**. If the character has 2+
labelled views, the output's **angle is classified first** (front / side / back / …) so it's
compared like-with-like. Claude then returns a strict-JSON verdict: an overall score, and a
per-item pass/fail with the measured ratio and % deviation.

**3. History**
Every check is saved. The **History** button (top of the page) lists past results with a
thumbnail, score, classified view, and timestamp; click one to re-open its full verdict, or
**Clear all** to reset.

## Screen layout

```
┌───────────────────────────────────────────────┐
│ IP Consistency Guard            [ History ]    │
├───────────────────────────────────────────────┤
│ CHARACTER SHEET (pinned)        [ New / edit ] │
│ reference thumb | traits | proportion rules    │
├───────────────────────────────────────────────┤
│ CHECK AN OUTPUT                                │
│ [ upload output image ]   [ Check ]            │
├───────────────────────────────────────────────┤
│ RESULT                                         │
│ Consistency: 90%   ·  Classified view: front   │
│ ✔ Head:torso — ref 1:1, got 1:1.1 (+10%)       │
│ ✗ Eye→nose : eye width — ref 1:1.2, got 1:1.6  │
└───────────────────────────────────────────────┘
```

## Data model

**Character sheet** (stored server-side as JSON):

```json
{
  "id": "char_...",
  "name": "YourCharacter",
  "reference_views": [
    { "id": "front", "image": "data:image/png;base64,..." },
    { "id": "side",  "image": "data:image/png;base64,..." }
  ],
  "traits": [{ "id": "eye_color", "label": "Eye color", "expected": "amber" }],
  "proportion_rules": [
    {
      "id": "head_torso",
      "label": "Head height : torso height",
      "reference_ratio": [1, 1],
      "tolerance_pct": 15,
      "measurable_in": ["front", "three_quarter", "back"]
    }
  ],
  "forbidden": [{ "id": "no_extra_limbs", "label": "No extra or missing limbs" }]
}
```

**Check verdict** (strict JSON from the checker; the server also returns `view` and
`obliqueness`):

```json
{
  "overall_score": 90,
  "traits":     [{ "id": "eye_color", "status": "pass", "note": "amber, matches" }],
  "proportions":[{ "id": "head_torso", "reference_ratio": "1:1", "measured_ratio": "1:1.1",
                   "deviation_pct": 10, "status": "pass", "note": "" }],
  "forbidden":  [{ "id": "no_extra_limbs", "status": "pass", "note": "" }]
}
```

Output is parsed defensively (structured outputs + code-fence stripping + try/catch).

## Tech stack

- **Frontend:** single-page vanilla HTML/CSS/JS. No build step.
- **Backend:** thin Node/Express server. Stores each user's sheets and check history as JSON
  files under `data/` (per user; set `DATA_DIR` to a persistent volume in production).
- **Auth:** self-hosted GitHub OAuth with signed-cookie sessions — all data is scoped to the
  signed-in user (no third-party auth service).
- **Vision / judgment:** Claude (Anthropic) for (a) trait + proportion extraction, (b) view
  classification, (c) checking an output against the sheet.
- **Image generation:** fal.ai NanoBanana — wired but **dormant** (kept for a future
  generate-then-check loop; not used by the current UI).
- Uploaded images are downscaled to ~1024px (PNG, alpha preserved) before upload.

## Run it locally (development)

Only needed to run or self-host it yourself — users just use the [live app](#live-app).

```bash
npm install
cp .env.example .env     # fill in the keys (Anthropic + a GitHub OAuth App + a session secret)
npm run dev              # http://localhost:3000
```

Each variable is documented in `.env.example`. `.env` and `data/` are gitignored.

## Status

Live and working: GitHub login, per-user data, character registration, view-aware checking,
and check history.

## Known limitations

- Ratios are LLM-estimated, not pixel-precise.
- Background removal is **manual** — reference and output images must be background-removed
  before upload.
- Storage is flat JSON files (no database yet) — fine at this stage, would move to a DB to scale.

## Scope / IP note

This tool checks visual consistency by proportion and traits. It does not reproduce or depend
on any specific third-party production method. All demos use the author's own original
characters or public-domain assets — no client assets or third-party IP.

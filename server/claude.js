import Anthropic from "@anthropic-ai/sdk";

// Vision model used for both (a) character-sheet extraction and (b) consistency
// checking. Opus 4.8 handles the proportion reasoning and supports structured
// outputs, which lets us guarantee valid JSON for the frontend.
export const MODEL = "claude-opus-4-8";

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to your .env file (see .env.example)."
    );
  }
  if (!_client) _client = new Anthropic();
  return _client;
}

// Shared with other server modules (e.g. view.js) so they reuse the same client
// + helpers instead of duplicating them.
export function getClient() {
  return client();
}

// --- helpers ---------------------------------------------------------------

// Turn a `data:image/png;base64,...` URI into a Claude image content block.
export function imageBlock(dataUri) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUri);
  if (!match) {
    throw new Error("Expected a base64 image data URI (data:image/...;base64,...).");
  }
  return {
    type: "image",
    source: { type: "base64", media_type: match[1], data: match[2] },
  };
}

// Pull the first text block out of a response and JSON-parse it defensively.
// With structured outputs this should already be clean JSON, but we still strip
// any stray code fences and wrap in try/catch so a bad response degrades to a
// clear error rather than a crash.
export function parseJsonResponse(response) {
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Model returned no text content.");
  let text = textBlock.text.trim();
  // Strip ```json ... ``` fences if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse model output as JSON: ${err.message}`);
  }
}

// --- schemas (structured outputs) -----------------------------------------

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "traits", "proportion_rules", "forbidden"],
  properties: {
    name: { type: "string" },
    traits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "expected", "measurable_in"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          expected: { type: "string" },
          // Which views this trait is visible/checkable in (e.g. a chest emblem
          // is visible from front but not back).
          measurable_in: {
            type: "array",
            items: { type: "string", enum: ["front", "three_quarter", "side", "back"] },
          },
        },
      },
    },
    proportion_rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "reference_ratio", "tolerance_pct", "measurable_in"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          reference_ratio: { type: "array", items: { type: "number" } },
          tolerance_pct: { type: "number" },
          // Which views this rule's landmarks are visible in, so the checker can
          // skip rules that can't be measured from the output's classified view.
          measurable_in: {
            type: "array",
            items: {
              type: "string",
              enum: ["front", "three_quarter", "side", "back"],
            },
          },
        },
      },
    },
    forbidden: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "measurable_in"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          // Which views this forbidden condition is checkable in.
          measurable_in: {
            type: "array",
            items: { type: "string", enum: ["front", "three_quarter", "side", "back"] },
          },
        },
      },
    },
  },
};

const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overall_score", "traits", "proportions", "forbidden"],
  properties: {
    overall_score: { type: "integer" },
    traits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "note"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["pass", "fail"] },
          note: { type: "string" },
        },
      },
    },
    proportions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "reference_ratio",
          "measured_ratio",
          "deviation_pct",
          "status",
          "note",
        ],
        properties: {
          id: { type: "string" },
          reference_ratio: { type: "string" },
          measured_ratio: { type: "string" },
          deviation_pct: { type: "number" },
          status: { type: "string", enum: ["pass", "fail"] },
          note: { type: "string" },
        },
      },
    },
    forbidden: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "note"],
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["pass", "fail"] },
          note: { type: "string" },
        },
      },
    },
  },
};

// --- (a) character-sheet extraction ---------------------------------------

const EXTRACTION_SYSTEM = `You build "character sheets" for visual consistency checking of an original character.

Given one or more reference images of the SAME character, extract:

1. traits — qualitative, checkable visual facts (eye color, body/hair color, outfit
   pattern, body type, distinctive features). Give each a short snake_case id, a
   human-readable label, the expected value, and measurable_in (see below).

2. proportion_rules — the quantitative ratios that actually DEFINE this character.
   Pick 1-3 measurement pairs between clear on-image landmarks whose ratio must hold
   for the character to read as on-model (e.g. "pom-pom top -> eye center : eye center
   -> nose"). For each, give a snake_case id, a label naming the two measured segments,
   a reference_ratio as [a, b] estimated from the reference image(s), and a
   tolerance_pct (default 15) — how much deviation is allowed before it fails.
   Prefer ratios that break obviously when the character drifts off-model.
   Also give measurable_in: the list of views this rule's two landmarks are both
   visible in (subset of "front", "three_quarter", "side", "back"). E.g. a
   nose-to-eye ratio is measurable in "front" and "three_quarter" but not "back".

3. forbidden — things that must NOT appear (e.g. extra or missing limbs). Give each an
   id, label, and measurable_in (see below).

measurable_in (on every trait, proportion_rule, and forbidden): the list of views the item
can actually be checked from, a subset of "front", "three_quarter", "side", "back". Think
about what is visible from each angle: a face detail or chest emblem shows in "front" and
"three_quarter" but NOT "back"; a tail or back marking shows in "back"; overall body
proportions show in most views. This lets the checker skip items that can't be seen from the
output's angle instead of wrongly failing them. When in doubt, include the views where it is
clearly visible.

Estimate ratios visually. You are not pixel-precise; a good estimate ("about 2:1") is
the goal. Base everything only on what you can see in the reference image(s).`;

export async function extractSheet(imageDataUris, nameHint) {
  const content = [];
  imageDataUris.slice(0, 4).forEach((uri, i) => {
    content.push({ type: "text", text: `Reference image ${i + 1}:` });
    content.push(imageBlock(uri));
  });
  content.push({
    type: "text",
    text:
      `Build the character sheet for this character.` +
      (nameHint ? ` The user suggests the name "${nameHint}".` : ""),
  });

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: EXTRACTION_SYSTEM,
    output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  return parseJsonResponse(response);
}

// --- (b) consistency checking ---------------------------------------------

const CHECK_SYSTEM = `You measure whether a GENERATED image stays on-model with a registered character,
using proportion-based measurement rather than a vague "does it look similar" judgment.

You are given: the character sheet (traits, proportion rules, forbidden elements), the
REFERENCE image(s) that define the character, and one OUTPUT image to evaluate.

For each proportion rule:
- Use the reference image(s) as the ground truth for reference_ratio (restate it as an
  "a:b" string, e.g. "2:1").
- Visually measure the same two segments in the OUTPUT image and report measured_ratio
  as an "a:b" string.
- deviation_pct = round(|measured - reference| / reference * 100), where each ratio is
  taken as the single number a/b.
- status = "fail" if deviation_pct > the rule's tolerance_pct, else "pass".
- note = one short phrase on what drifted (e.g. "eyes sit lower than reference").

For each trait: status "pass" if the OUTPUT clearly matches the expected value, else
"fail"; note gives the observed value.

For each forbidden element: status "pass" if it is absent from the OUTPUT (good), "fail"
if it appears; note explains.

overall_score: an integer 0-100 reflecting overall on-model consistency. Weight
proportion rules heavily — a character with the right traits but drifted proportions is
off-model. A perfect match is 100.

You estimate on-image distances; you are not pixel-precise. Give your best visual
estimate. Return ONLY the structured result.`;

export async function checkOutput(sheet, outputDataUri, view = null, obliqueness = null) {
  const content = [];
  const refs = Array.isArray(sheet.reference_images) ? sheet.reference_images : [];
  refs.slice(0, 4).forEach((uri, i) => {
    if (typeof uri === "string" && uri.startsWith("data:")) {
      content.push({ type: "text", text: `Reference image ${i + 1} (defines the character):` });
      content.push(imageBlock(uri));
    }
  });

  content.push({ type: "text", text: "OUTPUT image to evaluate:" });
  content.push(imageBlock(outputDataUri));

  // Classified view context (from view.js) — spatial awareness only. The set of
  // items below has ALREADY been filtered to what's checkable from this view
  // (server-side view-gating), so measure every item you are given.
  if (view) {
    let note = `The OUTPUT has been classified as a "${view}" view`;
    if (typeof obliqueness === "number") note += ` (obliqueness ${obliqueness.toFixed(2)}, 0=canonical, 1=strongly tilted)`;
    note += `. Measure it from that angle. Every item below is expected to be visible in this view.`;
    content.push({ type: "text", text: note });
  }

  // Send the sheet without the (large) embedded reference images.
  const sheetForPrompt = {
    name: sheet.name,
    traits: sheet.traits || [],
    proportion_rules: sheet.proportion_rules || [],
    forbidden: sheet.forbidden || [],
  };
  content.push({
    type: "text",
    text:
      "Character sheet to measure against:\n```json\n" +
      JSON.stringify(sheetForPrompt, null, 2) +
      "\n```\nProduce the verdict. Include one entry per trait, per proportion rule, and per forbidden element, keyed by the same ids.",
  });

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: CHECK_SYSTEM,
    output_config: { format: { type: "json_schema", schema: CHECK_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  return parseJsonResponse(response);
}

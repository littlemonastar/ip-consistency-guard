// View classification — "which angle is this output?"
//
// Given a set of registered reference views (front / three_quarter / side / back)
// and one output image, decide which reference view the output is closest to, how
// confident that is, and how oblique (tilted away from a canonical view) it is.
// The result lets the checker compare like-with-like and skip geometry that can't
// be measured from the output's angle.
//
// Backend note: this is a "coarse, qualitative" classifier and is deliberately
// pluggable. We use the existing Anthropic vision model because this character's
// silhouette is left/right symmetric — a pure silhouette-IoU backend would confuse
// front vs back. Swap `classifyViewLLM` for a DINOv2 / CLIP embedding backend later
// by pointing `classifyView` at a different implementation; the interface is fixed.

import { getClient, MODEL, imageBlock, parseJsonResponse } from "./claude.js";

const CANONICAL_VIEWS = ["front", "three_quarter", "side", "back"];

const VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["view", "confidence", "obliqueness"],
  properties: {
    // Closest reference view. Constrained to the canonical ids; the prompt tells
    // the model to only choose among the reference views actually provided.
    view: { type: "string", enum: CANONICAL_VIEWS },
    confidence: { type: "number" }, // 0-1
    obliqueness: { type: "number" }, // 0-1, 1 = strong perspective / oblique pose
  },
};

const CLASSIFY_SYSTEM = `You classify which registered reference view a generated OUTPUT image is closest to.

You are given the reference views (each labelled with its id: some of front, three_quarter,
side, back) and one OUTPUT image. Decide which reference view the OUTPUT most closely matches.

CRITICAL: this character's silhouette is roughly left/right symmetric, so the OUTLINE alone
CANNOT tell front from back. Judge by CONTENT, not just contour:
- Is the FACE visible (eyes, nose, mouth) → front / three_quarter. No face, back of head → back.
- Colour layout / two-tone split: how the colours are arranged distinguishes front vs back.
- A clear side silhouette with the face in profile → side.

Return:
- view: the id of the closest reference view. Choose ONLY from the reference ids provided.
- confidence: 0-1, how sure you are.
- obliqueness: 0-1, how far the OUTPUT is tilted/rotated away from a clean canonical view of
  that angle. 0 = squarely that view; 1 = strong perspective, three-quarter twist, or a
  dynamic pose seen at an angle.

You are doing a coarse qualitative call, not precise measurement. Return ONLY the structured result.`;

// Default (only) backend: coarse LLM classification.
async function classifyViewLLM(outputImage, referenceViews) {
  const views = Array.isArray(referenceViews) ? referenceViews : [];
  const content = [];
  views.forEach((v) => {
    if (v && typeof v.image === "string" && v.image.startsWith("data:")) {
      content.push({ type: "text", text: `Reference view "${v.id}":` });
      content.push(imageBlock(v.image));
    }
  });
  content.push({ type: "text", text: "OUTPUT image to classify:" });
  content.push(imageBlock(outputImage));

  const ids = views.map((v) => v.id).join(", ");
  content.push({
    type: "text",
    text:
      `Which reference view is the OUTPUT closest to? Choose view from these reference ids: ${ids}. ` +
      `Also return confidence (0-1) and obliqueness (0-1).`,
  });

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1500,
    thinking: { type: "adaptive" },
    system: CLASSIFY_SYSTEM,
    output_config: { format: { type: "json_schema", schema: VIEW_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  const result = parseJsonResponse(response);
  // Clamp the numeric fields defensively.
  result.confidence = clamp01(result.confidence);
  result.obliqueness = clamp01(result.obliqueness);
  return result;
}

function clamp01(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Classify an output image against a set of reference views.
 * @param {string} outputImage - data URI of the output to classify
 * @param {Array<{id: string, image: string}>} referenceViews - registered views
 * @returns {Promise<{view: string, confidence: number, obliqueness: number}>}
 */
export async function classifyView(outputImage, referenceViews) {
  if (!outputImage || typeof outputImage !== "string" || !outputImage.startsWith("data:")) {
    throw new Error("classifyView: outputImage must be an image data URI.");
  }
  if (!Array.isArray(referenceViews) || referenceViews.length === 0) {
    throw new Error("classifyView: referenceViews must be a non-empty array of {id, image}.");
  }
  return classifyViewLLM(outputImage, referenceViews);
}

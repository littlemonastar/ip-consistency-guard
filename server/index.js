import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractSheet, checkOutput } from "./claude.js";
import { generate } from "./fal.js";
import { classifyView } from "./view.js";
import { saveSheet, getSheet, listSheets, saveCheck, listChecks, clearChecks } from "./store.js";
import { mountAuthRoutes, requireAuth, currentUser } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // so req.protocol is https behind a proxy (prod)

// Base64 images travel in the JSON body, so raise the limit.
app.use(express.json({ limit: "30mb" }));

// Wrap async handlers so thrown errors become clean 500s instead of crashes.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal error" });
  });

// --- view-gating helpers ---------------------------------------------------

// An item is checkable in a view if no view was classified, or it's untagged
// (legacy sheets), or its measurable_in list includes the view.
function checkableInView(item, view) {
  if (!view) return true;
  const mi = item && item.measurable_in;
  if (!Array.isArray(mi) || mi.length === 0) return true;
  return mi.includes(view);
}

// Split a sheet's items into what to actually check vs. what to skip (and why),
// given the classified view and obliqueness.
function gateSheet(sheet, view, obliqueness) {
  const tooOblique = typeof obliqueness === "number" && obliqueness > 0.5;
  const skipped = [];
  const keep = (list, kind, isGeometry = false) =>
    (list || []).filter((item) => {
      if (isGeometry && tooOblique) {
        skipped.push({ kind, id: item.id, note: "pose too oblique to measure geometry" });
        return false;
      }
      if (!checkableInView(item, view)) {
        skipped.push({ kind, id: item.id, note: `not visible in ${view} view` });
        return false;
      }
      return true;
    });
  return {
    applicable: {
      traits: keep(sheet.traits, "traits"),
      proportion_rules: keep(sheet.proportion_rules, "proportions", true),
      forbidden: keep(sheet.forbidden, "forbidden"),
    },
    skipped,
  };
}

// Add skipped items back into the verdict as status "skip" so the UI can show
// them as "not applicable to this view" rather than silently dropping them.
function mergeSkipped(verdict, skipped) {
  for (const s of skipped) {
    if (s.kind === "proportions") {
      verdict.proportions = verdict.proportions || [];
      verdict.proportions.push({
        id: s.id,
        reference_ratio: "",
        measured_ratio: "",
        deviation_pct: 0,
        status: "skip",
        note: s.note,
      });
    } else {
      verdict[s.kind] = verdict[s.kind] || [];
      verdict[s.kind].push({ id: s.id, status: "skip", note: s.note });
    }
  }
}

// --- auth ------------------------------------------------------------------

mountAuthRoutes(app);

// Who is signed in (null if not). Public — the frontend uses it to gate the UI.
app.get(
  "/api/me",
  wrap(async (req, res) => {
    res.json({ user: currentUser(req) });
  })
);

// Everything under /api (except /api/me) requires a signed-in user; data is
// scoped to req.user.uid.
app.use("/api", requireAuth);
app.use(express.static(path.join(__dirname, "..", "public")));

// --- character sheets ------------------------------------------------------

// Extract a draft sheet from reference images. The user edits it, then saves.
app.post(
  "/api/sheet/extract",
  wrap(async (req, res) => {
    const { images, name } = req.body || {};
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "At least one reference image is required." });
    }
    const draft = await extractSheet(images, name);
    res.json({ sheet: draft });
  })
);

// Persist a (possibly edited) sheet, owned by the signed-in user.
app.post(
  "/api/sheet",
  wrap(async (req, res) => {
    const { sheet } = req.body || {};
    if (!sheet || typeof sheet !== "object") {
      return res.status(400).json({ error: "A sheet object is required." });
    }
    const saved = await saveSheet(req.user.uid, sheet);
    res.json({ sheet: saved });
  })
);

// List the signed-in user's sheets (most recent first).
app.get(
  "/api/sheets",
  wrap(async (req, res) => {
    res.json({ sheets: await listSheets(req.user.uid) });
  })
);

// --- check -----------------------------------------------------------------

// (Kept for later — fal new-scene generation is not wired into the UI right now.)
app.post(
  "/api/generate",
  wrap(async (req, res) => {
    const { inputImage, prompt } = req.body || {};
    const image = await generate(inputImage, prompt);
    res.json({ image });
  })
);

// Measure an output image against one of the user's SAVED sheets. The client
// sends only the sheet id + the output image (references load server-side → small
// payload). The sheet must belong to the signed-in user.
app.post(
  "/api/check",
  wrap(async (req, res) => {
    const { sheetId, outputImage } = req.body || {};
    if (!sheetId || !outputImage) {
      return res.status(400).json({ error: "sheetId and outputImage are required." });
    }
    const sheet = await getSheet(req.user.uid, sheetId);
    if (!sheet) {
      return res.status(404).json({ error: "Saved sheet not found — save the character first." });
    }
    // Classify the output's angle first when the sheet has 2+ labelled reference
    // views (with only one angle there's nothing to disambiguate — skip).
    let view = null;
    let obliqueness = null;
    const referenceViews = Array.isArray(sheet.reference_views) ? sheet.reference_views : [];
    const distinctIds = new Set(referenceViews.map((v) => v && v.id));
    if (referenceViews.length >= 2 && distinctIds.size >= 2) {
      const c = await classifyView(outputImage, referenceViews);
      view = c.view;
      obliqueness = c.obliqueness;
    }

    // View-gating: only check items that are actually visible from the classified
    // view; if the pose is strongly oblique, skip geometry (proportion rules) too.
    // Skipped items are reported with status "skip" rather than wrongly failed.
    const { applicable, skipped } = gateSheet(sheet, view, obliqueness);
    const verdict = await checkOutput(
      { ...sheet, ...applicable },
      outputImage,
      view,
      obliqueness
    );
    mergeSkipped(verdict, skipped);

    // Record the check in the user's history. Store id→label maps so a past
    // verdict can be rendered later without reloading its sheet.
    const labelMap = (list) => Object.fromEntries((list || []).map((x) => [x.id, x.label]));
    const check = await saveCheck(req.user.uid, {
      sheet_id: sheetId,
      sheet_name: sheet.name || "",
      overall_score: verdict.overall_score,
      view,
      obliqueness,
      output_image: outputImage,
      verdict,
      labels: {
        rules: labelMap(sheet.proportion_rules),
        traits: labelMap(sheet.traits),
        forbidden: labelMap(sheet.forbidden),
      },
    });

    res.json({ verdict, view, obliqueness, check });
  })
);

// The signed-in user's check history.
app.get(
  "/api/checks",
  wrap(async (req, res) => {
    res.json({ checks: await listChecks(req.user.uid) });
  })
);
app.post(
  "/api/checks/clear",
  wrap(async (req, res) => {
    res.json({ cleared: await clearChecks(req.user.uid) });
  })
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`ip-consistency-guard running at http://localhost:${port}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("  ⚠  ANTHROPIC_API_KEY not set");
  if (!process.env.SESSION_SECRET) console.warn("  ⚠  SESSION_SECRET not set (login disabled)");
  if (!process.env.GITHUB_CLIENT_ID) console.warn("  ⚠  GITHUB_CLIENT_ID not set (login disabled)");
  if (!process.env.FAL_KEY) console.warn("  ⚠  FAL_KEY not set (fal generation dormant)");
});

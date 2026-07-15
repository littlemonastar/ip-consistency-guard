// Manual test harness for classifyView. Requires ANTHROPIC_API_KEY in .env and
// your own background-removed images (this task is scoped to code; supply images).
//
// Usage (reference views are id=path; the image to classify is out=path):
//   node server/view.test.mjs front=ref/front.png side=ref/side.png back=ref/back.png out=ref/back.png
//
// Sanity check:  set out= to one of the reference images → it should classify as
//                that same view with high confidence, low obliqueness.
// Symmetry check: set out= to the back image → must return "back", NOT "front"
//                (proves it's using colour/face, not just the symmetric outline).

import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyView } from "./view.js";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function toDataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const media = MIME[ext] || "image/png";
  const buf = await fs.readFile(file);
  return `data:${media};base64,${buf.toString("base64")}`;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const i = a.indexOf("=");
      return [a.slice(0, i), a.slice(i + 1)];
    })
  );

  const outPath = args.out;
  if (!outPath) {
    console.error("Provide out=<path> (the image to classify) and one or more id=<path> reference views.");
    console.error("e.g. node server/view.test.mjs front=ref/front.png back=ref/back.png out=ref/back.png");
    process.exit(1);
  }

  const referenceViews = [];
  for (const [id, p] of Object.entries(args)) {
    if (id === "out") continue;
    referenceViews.push({ id, image: await toDataUri(p) });
  }
  if (referenceViews.length === 0) {
    console.error("Provide at least one reference view, e.g. front=ref/front.png");
    process.exit(1);
  }

  const output = await toDataUri(outPath);
  console.log(
    `Classifying "${outPath}" against reference views: ${referenceViews.map((v) => v.id).join(", ")}`
  );

  const result = await classifyView(output, referenceViews);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

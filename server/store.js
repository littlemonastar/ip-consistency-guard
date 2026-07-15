// Per-user JSON file store. Sheets and check history live under a per-owner
// subdirectory so each signed-in user only ever sees their own data:
//   data/sheets/<owner>/<id>.json
//   data/checks/<owner>/<id>.json
// Good enough for this stage; swap for a real DB when scaling.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Storage root. Locally defaults to <repo>/data; in production set DATA_DIR to a
// mounted persistent volume (e.g. /data on Railway/Fly) so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SHEETS_ROOT = path.join(DATA_DIR, "sheets");
const CHECKS_ROOT = path.join(DATA_DIR, "checks");

// Owner ids come from auth (`gh_<number>`); sanitise before using in a path.
function safeOwner(owner) {
  const o = String(owner || "").replace(/[^a-z0-9_]/gi, "");
  if (!o) throw new Error("An owner is required.");
  return o;
}
function sheetsDir(owner) {
  return path.join(SHEETS_ROOT, safeOwner(owner));
}
function checksDir(owner) {
  return path.join(CHECKS_ROOT, safeOwner(owner));
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function readAll(dir) {
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
    } catch {
      // Skip unreadable/corrupt files rather than failing the whole list.
    }
  }
  return out;
}

// --- sheets ----------------------------------------------------------------

export async function saveSheet(owner, sheet) {
  const dir = sheetsDir(owner);
  await fs.mkdir(dir, { recursive: true });
  const id = sheet.id || newId("char");
  const record = { ...sheet, id, owner: safeOwner(owner), updated_at: new Date().toISOString() };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function getSheet(owner, id) {
  if (!id || !/^[a-z0-9_]+$/i.test(id)) return null;
  try {
    const raw = await fs.readFile(path.join(sheetsDir(owner), `${id}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listSheets(owner) {
  const sheets = await readAll(sheetsDir(owner));
  sheets.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  return sheets;
}

// --- check history ---------------------------------------------------------

export async function saveCheck(owner, record) {
  const dir = checksDir(owner);
  await fs.mkdir(dir, { recursive: true });
  const id = newId("chk");
  const rec = { ...record, id, created_at: new Date().toISOString() };
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(rec, null, 2), "utf8");
  return rec;
}

export async function listChecks(owner) {
  const checks = await readAll(checksDir(owner));
  checks.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return checks;
}

export async function clearChecks(owner) {
  const dir = checksDir(owner);
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  await Promise.all(files.map((f) => fs.unlink(path.join(dir, f))));
  return files.length;
}

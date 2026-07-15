// IP Consistency Guard — frontend.
// Register a character from background-removed reference views + traits, then
// upload an output image and measure it against the saved character.
// The browser never sees API keys; it calls our own /api/* endpoints.

const $ = (sel) => document.querySelector(sel);

const VIEW_IDS = ["front", "three_quarter", "side", "back"];

const state = {
  user: null, // signed-in GitHub user (null = logged out)
  sheet: null, // the saved/pinned character sheet
  dirty: true, // true while editing / before the current sheet is saved
  outputImage: null, // data URI of the output being checked
};

// --- utilities -------------------------------------------------------------

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Downscale an image to a max long edge (default 1024px) to keep payloads small.
// Re-encodes as PNG so transparency (background-removed images) is preserved —
// JPEG would flatten the alpha to a solid colour. Returns the original if already
// small enough or if decoding fails.
function downscaleDataUri(dataUri, maxEdge = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      if (scale >= 1) return resolve(dataUri);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

// Read a file and downscale it in one step.
async function readImage(file) {
  return downscaleDataUri(await fileToDataUri(file));
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function ratioToString(arr) {
  if (Array.isArray(arr) && arr.length === 2) return `${arr[0]}:${arr[1]}`;
  return "";
}
function stringToRatio(str) {
  const parts = String(str).split(":").map((p) => parseFloat(p.trim()));
  if (parts.length === 2 && parts.every((n) => !Number.isNaN(n))) return parts;
  return [1, 1];
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
function slug(label, prefix, i) {
  const base = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || `${prefix}_${i}`;
}

// --- registration: reference views -----------------------------------------

function viewRow(defaultId = "front") {
  const div = document.createElement("div");
  div.className = "ref-view-row";
  const options = VIEW_IDS.map(
    (id) => `<option value="${id}"${id === defaultId ? " selected" : ""}>${id}</option>`
  ).join("");
  div.innerHTML = `
    <select class="rv-id">${options}</select>
    <input type="file" accept="image/*" class="rv-file" />
    <img class="rv-thumb" alt="" hidden />
    <button class="remove-x" title="remove">×</button>`;
  const thumb = div.querySelector(".rv-thumb");
  div.querySelector(".rv-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    div.dataset.image = await readImage(file);
    thumb.src = div.dataset.image;
    thumb.hidden = false;
  });
  div.querySelector(".remove-x").onclick = () => div.remove();
  return div;
}

$("#add-view-btn").addEventListener("click", () => {
  // Suggest the next unused angle as the default.
  const used = new Set(
    Array.from($("#ref-views").children).map((r) => r.querySelector(".rv-id").value)
  );
  const next = VIEW_IDS.find((id) => !used.has(id)) || "front";
  $("#ref-views").appendChild(viewRow(next));
});

// Collect { id, image } for every row that has an image loaded.
function collectRefViews() {
  return Array.from($("#ref-views").children)
    .filter((r) => r.dataset.image)
    .map((r) => ({ id: r.querySelector(".rv-id").value, image: r.dataset.image }));
}

// --- registration: extract + edit ------------------------------------------

$("#extract-btn").addEventListener("click", async () => {
  const views = collectRefViews();
  if (views.length === 0) return toast("Add at least one reference view (e.g. front).");
  const btn = $("#extract-btn");
  btn.disabled = true;
  btn.textContent = "Extracting…";
  try {
    const { sheet } = await api("/api/sheet/extract", {
      images: views.map((v) => v.image),
      name: $("#char-name").value.trim() || undefined,
    });
    if ($("#char-name").value.trim()) sheet.name = $("#char-name").value.trim();
    renderDraftEditor(sheet);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Extract traits with Claude";
  }
});

function traitRow(t = { id: "", label: "", expected: "", measurable_in: [] }) {
  const div = document.createElement("div");
  div.className = "edit-line";
  div.dataset.id = t.id || "";
  div.dataset.measurableIn = JSON.stringify(t.measurable_in || []);
  div.innerHTML = `
    <input class="grow label" placeholder="label (e.g. Eye color)" value="${escapeAttr(t.label)}" />
    <input class="grow expected" placeholder="expected (e.g. purple)" value="${escapeAttr(t.expected)}" />
    <button class="remove-x" title="remove">×</button>`;
  div.querySelector(".remove-x").onclick = () => div.remove();
  return div;
}
function ruleRow(r = { id: "", label: "", reference_ratio: [1, 1], tolerance_pct: 15, measurable_in: [] }) {
  const div = document.createElement("div");
  div.className = "edit-line";
  div.dataset.id = r.id || "";
  // Preserve measurable_in (from extraction) even though it isn't edited in the UI.
  div.dataset.measurableIn = JSON.stringify(r.measurable_in || []);
  div.innerHTML = `
    <input class="grow label" placeholder="label (e.g. pom→eye : eye→nose)" value="${escapeAttr(r.label)}" />
    <input class="ratio ratioval" placeholder="2:1" value="${escapeAttr(ratioToString(r.reference_ratio))}" />
    <input class="tol tolval" type="number" placeholder="tol %" value="${r.tolerance_pct ?? 15}" />
    <button class="remove-x" title="remove">×</button>`;
  div.querySelector(".remove-x").onclick = () => div.remove();
  return div;
}
function forbiddenRow(f = { id: "", label: "", measurable_in: [] }) {
  const div = document.createElement("div");
  div.className = "edit-line";
  div.dataset.id = f.id || "";
  div.dataset.measurableIn = JSON.stringify(f.measurable_in || []);
  div.innerHTML = `
    <input class="grow label" placeholder="label (e.g. No extra limbs)" value="${escapeAttr(f.label)}" />
    <button class="remove-x" title="remove">×</button>`;
  div.querySelector(".remove-x").onclick = () => div.remove();
  return div;
}

function renderDraftEditor(sheet) {
  $("#draft-editor").hidden = false;
  if (sheet.name) $("#char-name").value = sheet.name;
  const traits = $("#edit-traits");
  const rules = $("#edit-rules");
  const forbidden = $("#edit-forbidden");
  traits.innerHTML = "";
  rules.innerHTML = "";
  forbidden.innerHTML = "";
  (sheet.traits || []).forEach((t) => traits.appendChild(traitRow(t)));
  (sheet.proportion_rules || []).forEach((r) => rules.appendChild(ruleRow(r)));
  (sheet.forbidden || []).forEach((f) => forbidden.appendChild(forbiddenRow(f)));
}

document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("#draft-editor").hidden = false;
    if (btn.dataset.add === "trait") $("#edit-traits").appendChild(traitRow());
    if (btn.dataset.add === "rule") $("#edit-rules").appendChild(ruleRow());
    if (btn.dataset.add === "forbidden") $("#edit-forbidden").appendChild(forbiddenRow());
  });
});

function collectSheet() {
  const views = collectRefViews();
  const parseMi = (row) => {
    try {
      return JSON.parse(row.dataset.measurableIn || "[]");
    } catch {
      return [];
    }
  };
  const traits = Array.from($("#edit-traits").children).map((row, i) => {
    const label = row.querySelector(".label").value.trim();
    return {
      id: row.dataset.id || slug(label, "trait", i),
      label,
      expected: row.querySelector(".expected").value.trim(),
      measurable_in: parseMi(row),
    };
  });
  const proportion_rules = Array.from($("#edit-rules").children).map((row, i) => {
    const label = row.querySelector(".label").value.trim();
    let measurable_in = [];
    try {
      measurable_in = JSON.parse(row.dataset.measurableIn || "[]");
    } catch {}
    return {
      id: row.dataset.id || slug(label, "rule", i),
      label,
      reference_ratio: stringToRatio(row.querySelector(".ratioval").value),
      tolerance_pct: parseFloat(row.querySelector(".tolval").value) || 15,
      measurable_in,
    };
  });
  const forbidden = Array.from($("#edit-forbidden").children).map((row, i) => {
    const label = row.querySelector(".label").value.trim();
    return { id: row.dataset.id || slug(label, "forbidden", i), label, measurable_in: parseMi(row) };
  });

  return {
    name: $("#char-name").value.trim() || "Unnamed character",
    reference_views: views, // [{id, image}] — enables view-aware checking
    reference_images: views.map((v) => v.image),
    traits: traits.filter((t) => t.label),
    proportion_rules: proportion_rules.filter((r) => r.label),
    forbidden: forbidden.filter((f) => f.label),
  };
}

$("#save-sheet-btn").addEventListener("click", async () => {
  const draft = collectSheet();
  if (draft.reference_images.length === 0)
    return toast("Add at least one reference view.");
  if (draft.proportion_rules.length === 0)
    return toast("Add at least one proportion rule.");
  const btn = $("#save-sheet-btn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const { sheet } = await api("/api/sheet", { sheet: draft });
    pinSheet(sheet);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save character sheet";
  }
});

// --- pinned sheet view -----------------------------------------------------

function pinSheet(sheet) {
  state.sheet = sheet;
  state.dirty = false; // freshly saved (or loaded) → checkable
  setCheckEnabled(canCheck());
  $("#sheet-editor").hidden = true;
  $("#sheet-view").hidden = false;
  $("#new-sheet-btn").hidden = false;

  const ref = (sheet.reference_images || [])[0];
  if (ref) $("#sheet-thumb-img").src = ref;
  $("#sheet-name").textContent = sheet.name || "Unnamed character";

  const traits = $("#sheet-traits");
  const rules = $("#sheet-rules");
  const forbidden = $("#sheet-forbidden");
  traits.innerHTML = "";
  rules.innerHTML = "";
  forbidden.innerHTML = "";
  (sheet.traits || []).forEach((t) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="k">${t.label}:</span> ${t.expected || "—"}`;
    traits.appendChild(li);
  });
  (sheet.proportion_rules || []).forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `${r.label} <span class="k">= ${ratioToString(r.reference_ratio)} (±${r.tolerance_pct}%)</span>`;
    rules.appendChild(li);
  });
  (sheet.forbidden || []).forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f.label;
    forbidden.appendChild(li);
  });
}

$("#new-sheet-btn").addEventListener("click", () => {
  // Editing invalidates the saved state until re-saved → block checking.
  state.dirty = true;
  setCheckEnabled(canCheck());
  $("#sheet-view").hidden = true;
  $("#sheet-editor").hidden = false;
  $("#new-sheet-btn").hidden = true;
});

// --- check an output -------------------------------------------------------

$("#output-dropzone").addEventListener("click", () => $("#output-file").click());
$("#output-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  state.outputImage = await readImage(file);
  const img = $("#output-preview");
  img.src = state.outputImage;
  img.hidden = false;
  $("#output-dropzone").querySelector(".dropzone-hint").hidden = true;
});

$("#check-btn").addEventListener("click", async () => {
  // Gate: only a saved, unedited sheet can be checked against.
  if (!state.sheet || !state.sheet.id || state.dirty) {
    return toast("Save the character sheet first.");
  }
  if (!state.outputImage) return toast("Upload an output image.");
  const btn = $("#check-btn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  $("#result").className = "result-empty";
  $("#result").textContent = "Measuring against the character sheet…";
  try {
    // Send only the saved sheet's id + the output image — references live server-side.
    const { verdict, view, obliqueness } = await api("/api/check", {
      sheetId: state.sheet.id,
      outputImage: state.outputImage,
    });
    renderVerdict(verdict, view, obliqueness);
  } catch (err) {
    $("#result").className = "result-empty";
    $("#result").textContent = "";
    toast("Check failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Check";
    setCheckEnabled(canCheck());
  }
});

// Enable checking only when a saved sheet is pinned and not being edited.
function canCheck() {
  return !!(state.sheet && state.sheet.id && !state.dirty);
}
function setCheckEnabled(enabled) {
  $("#check-btn").disabled = !enabled;
  $("#output-file").disabled = !enabled;
  $("#output-dropzone").classList.toggle("disabled", !enabled);
  $("#check-hint").hidden = enabled;
}

// --- result rendering ------------------------------------------------------

// id→label maps for the currently pinned sheet (used to render a live verdict).
function labelMapsFromSheet() {
  const s = state.sheet || {};
  const m = (list) => Object.fromEntries((list || []).map((x) => [x.id, x.label]));
  return { rules: m(s.proportion_rules), traits: m(s.traits), forbidden: m(s.forbidden) };
}

function checkRow({ statusClass, icon, label, note, metric }) {
  const div = document.createElement("div");
  div.className = `check ${statusClass}`;
  div.innerHTML = `
    <span class="icon">${icon}</span>
    <div>
      <div class="label">${label}</div>
      ${note ? `<div class="note">${note}</div>` : ""}
    </div>
    ${metric ? `<span class="metric">${metric}</span>` : ""}`;
  return div;
}

function group(title, rows) {
  const g = document.createElement("div");
  g.className = "result-group";
  const h = document.createElement("h4");
  h.textContent = title;
  g.appendChild(h);
  const list = document.createElement("div");
  list.className = "result-list";
  rows.forEach((r) => list.appendChild(r));
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent = "—";
    list.appendChild(empty);
  }
  g.appendChild(list);
  return g;
}

function renderVerdict(verdict, view, obliqueness, labels) {
  const L = labels || labelMapsFromSheet();
  const root = $("#result");
  root.className = "";
  root.innerHTML = "";

  const score = Math.max(0, Math.min(100, Number(verdict.overall_score) || 0));
  const bar = document.createElement("div");
  bar.className = "score-bar";
  bar.innerHTML = `
    <span class="score-num">${score}%</span>
    <div class="score-track"><div class="score-fill" style="width:${score}%"></div></div>`;
  root.appendChild(bar);

  // View classification (only present when the sheet has ≥2 labelled views).
  if (view) {
    const v = document.createElement("div");
    v.className = "view-tag";
    const ob = typeof obliqueness === "number" ? ` · obliqueness ${obliqueness.toFixed(2)}` : "";
    v.textContent = `Classified view: ${view}${ob}`;
    root.appendChild(v);
  }

  root.appendChild(
    group("Proportion rules", (verdict.proportions || []).map((p) => {
      const sv = statusView(p.status);
      return checkRow({
        statusClass: sv.cls,
        icon: sv.icon,
        label: (L.rules && L.rules[p.id]) || p.id,
        note: p.note,
        metric:
          p.status === "skip"
            ? ""
            : `ref ${p.reference_ratio} → ${p.measured_ratio} (${p.deviation_pct >= 0 ? "+" : ""}${p.deviation_pct}%)`,
      });
    }))
  );

  root.appendChild(
    group("Traits", (verdict.traits || []).map((t) => {
      const sv = statusView(t.status);
      return checkRow({
        statusClass: sv.cls,
        icon: sv.icon,
        label: (L.traits && L.traits[t.id]) || t.id,
        note: t.note,
      });
    }))
  );

  if ((verdict.forbidden || []).length) {
    root.appendChild(
      group("Forbidden", verdict.forbidden.map((f) => {
        const sv = statusView(f.status);
        return checkRow({
          statusClass: sv.cls,
          icon: sv.icon,
          label: (L.forbidden && L.forbidden[f.id]) || f.id,
          note: f.note,
        });
      }))
    );
  }
}

// Map a verdict status to a CSS class + icon. "skip" = not checkable from this view.
function statusView(s) {
  if (s === "pass") return { cls: "pass", icon: "✔" };
  if (s === "skip") return { cls: "skip", icon: "–" };
  return { cls: "fail", icon: "✕" };
}

// --- check history ---------------------------------------------------------

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || "";
  }
}

function renderHistory(checks) {
  const list = $("#history-list");
  list.innerHTML = "";
  if (!checks || checks.length === 0) {
    list.innerHTML = `<p class="hint">No checks yet.</p>`;
    return;
  }
  checks.forEach((c) => {
    const score = Math.max(0, Math.min(100, Number(c.overall_score) || 0));
    const row = document.createElement("button");
    row.className = "history-row";
    const viewTag = c.view ? ` · ${c.view}` : "";
    row.innerHTML = `
      <img class="history-thumb" src="${c.output_image}" alt="" />
      <div class="history-meta">
        <div class="history-name">${c.sheet_name || "—"} <span class="history-score">${score}%</span></div>
        <div class="history-sub">${fmtTime(c.created_at)}${viewTag}</div>
      </div>`;
    row.addEventListener("click", () => {
      // Re-render this past verdict in the Result panel using its stored labels.
      renderVerdict(c.verdict, c.view, c.obliqueness, c.labels);
      $("#history-modal").hidden = true;
    });
    list.appendChild(row);
  });
}

async function openHistory() {
  try {
    const { checks } = await api2("/api/checks");
    renderHistory(checks);
    $("#history-modal").hidden = false;
  } catch (err) {
    toast(err.message);
  }
}

// GET helper (api() is POST-only).
async function api2(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

$("#history-btn").addEventListener("click", openHistory);
$("#close-history-btn").addEventListener("click", () => ($("#history-modal").hidden = true));
$("#clear-history-btn").addEventListener("click", async () => {
  try {
    await api("/api/checks/clear", {});
    renderHistory([]);
  } catch (err) {
    toast(err.message);
  }
});
// Click the dim backdrop (outside the box) to close.
$("#history-modal").addEventListener("click", (e) => {
  if (e.target.id === "history-modal") $("#history-modal").hidden = true;
});

// --- auth / startup --------------------------------------------------------

function renderAuthArea(user) {
  const el = $("#auth-area");
  if (user) {
    el.innerHTML = `
      ${user.avatar ? `<img class="avatar" src="${user.avatar}" alt="" />` : ""}
      <span class="auth-login">@${user.login || "you"}</span>
      <button id="logout-btn" class="btn ghost sm">Logout</button>`;
    $("#logout-btn").addEventListener("click", async () => {
      try {
        await api("/auth/logout", {});
      } catch {}
      location.reload();
    });
  } else {
    el.innerHTML = "";
  }
}

let appInited = false;
function initApp() {
  if (appInited) return;
  appInited = true;
  $("#ref-views").appendChild(viewRow("front"));
  setCheckEnabled(false); // nothing saved yet
}

(async function init() {
  let user = null;
  try {
    ({ user } = await api2("/api/me"));
  } catch {}
  state.user = user;
  renderAuthArea(user);

  const topbar = document.querySelector(".topbar");
  if (user) {
    $("#landing").hidden = true;
    topbar.hidden = false;
    $("#app").hidden = false;
    $("#history-btn").hidden = false;
    initApp();
    try {
      const { sheets } = await api2("/api/sheets");
      if (sheets && sheets.length) pinSheet(sheets[0]);
    } catch {
      // No saved sheets yet — stay in editor mode.
    }
  } else {
    $("#landing").hidden = false;
    topbar.hidden = true;
    $("#app").hidden = true;
    $("#history-btn").hidden = true;
  }
})();

/* =========================================================
   Speelfinance — Asset Management System
   Cloud-backed: data lives in Cloud Firestore so anyone with the
   link can view it live, and only signed-in admins can edit it.
   Mirrors the logic of the original Excel workbook:
     - Total Stock (auto)      = SUM of Stock Refill Log qty per category
     - Assigned / In Use (auto)= COUNT of assignments with status "Assigned"
     - Available (auto)        = Total - Assigned - Repair - Faulty - Lost - Scrap
     - Stock Alert              = "Low Stock" when Available <= Threshold
   ========================================================= */

let DB = null;
let currentPage = localStorage.getItem("assetTracker_lastPage") || "dashboard";
let fbApp = null, fdb = null, fauth = null;
const FIRESTORE_COLLECTION = "assetTracker";
const FIRESTORE_DOC = "data"; // legacy default office doc id (kept for backward compatibility)
const OFFICES_DOC_ID = "_offices"; // single doc holding the list of every office { id, name, city }
const DEFAULT_OFFICE_ID = FIRESTORE_DOC;

/* ---------------- Multi-office state ---------------- */
// Every office's data lives in its own Firestore document
// (assetTracker/{officeId}), completely separate from every other office —
// nothing is shared or synced between them.
let OFFICES = [];            // [{id, name, city}]
let currentOfficeId = null;  // id of the office currently open
const LAST_OFFICE_KEY = "assetTracker_lastOfficeId";
const LAST_PAGE_KEY = "assetTracker_lastPage";

/* ---------------- Firebase bootstrap ---------------- */
function firebaseConfigured() {
  return typeof firebaseConfig !== "undefined"
    && firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY"
    && firebaseConfig.projectId && firebaseConfig.projectId !== "YOUR_PROJECT_ID";
}
function initFirebase() {
  fbApp = firebase.initializeApp(firebaseConfig);
  fdb = firebase.firestore();
  fauth = firebase.auth();
}
function docRef() {
  return fdb.collection(FIRESTORE_COLLECTION).doc(currentOfficeId || DEFAULT_OFFICE_ID);
}
function officesDocRef() {
  return fdb.collection(FIRESTORE_COLLECTION).doc(OFFICES_DOC_ID);
}
function logsCollRef() {
  return docRef().collection("logs");
}

/* ---------------- Activity log (per-office audit trail) ---------------- */
// Records who did what, and when, scoped to whichever office is currently open —
// so if something looks wrong, you can trace it back to a person and a time.
function logAction(action, details) {
  if (!fdb || !currentOfficeId || !fauth || !fauth.currentUser) return;
  logsCollRef().add({
    ts: new Date().toISOString(),
    email: fauth.currentUser.email || "unknown",
    action,
    details: details || "",
  }).catch(err => console.error("Activity log write failed:", err));
}

/* ---------------- Office directory (list of offices) ---------------- */
function slugify(str) {
  return String(str).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "office";
}
function uniqueOfficeId(base) {
  let id = base, n = 2;
  const taken = new Set(OFFICES.map(o => o.id));
  while (taken.has(id) || id === OFFICES_DOC_ID) { id = `${base}-${n++}`; }
  return id;
}
async function loadOfficesList() {
  const snap = await officesDocRef().get();
  if (snap.exists && Array.isArray(snap.data().offices) && snap.data().offices.length) {
    OFFICES = snap.data().offices;
  } else {
    // First run — seed the directory with the original office so existing data isn't orphaned.
    OFFICES = [{ id: DEFAULT_OFFICE_ID, name: "Mount Road", city: "Mumbai" }];
    await officesDocRef().set({ offices: OFFICES });
  }
}
async function saveOfficesList() {
  await officesDocRef().set({ offices: OFFICES });
}
function emptyOfficeDB() {
  // Blank starting data for a brand-new office — keeps the generic dropdown
  // option lists (status/condition/floor/department) but no actual records.
  const lists = JSON.parse(JSON.stringify(SEED_DATA.lists || {}));
  return { employees: [], categories: [], lists, assignments: [], refills: [], inventory: [], stockManual: {} };
}
async function createOffice(name, city) {
  const id = uniqueOfficeId(slugify(name));
  OFFICES.push({ id, name: name.trim(), city: (city || "").trim() });
  await saveOfficesList();
  await fdb.collection(FIRESTORE_COLLECTION).doc(id).set(emptyOfficeDB());
  if (fauth && fauth.currentUser) {
    fdb.collection(FIRESTORE_COLLECTION).doc(id).collection("logs").add({
      ts: new Date().toISOString(),
      email: fauth.currentUser.email || "unknown",
      action: "Created office",
      details: `"${name.trim()}"${city ? " — " + city.trim() : ""}`,
    }).catch(err => console.error("Activity log write failed:", err));
  }
  return id;
}
async function deleteOffice(id) {
  OFFICES = OFFICES.filter(o => o.id !== id);
  await saveOfficesList();
  await fdb.collection(FIRESTORE_COLLECTION).doc(id).delete().catch(() => {});
}
async function renameOffice(id, name, city) {
  const o = OFFICES.find(o => o.id === id);
  if (!o) return;
  o.name = name.trim();
  o.city = (city || "").trim();
  await saveOfficesList();
}

/* ---------------- Role management (Admin vs Viewer) ---------------- */
// Signed in = can view (read-only) by default. Whether someone can also
// EDIT depends on their role, stored server-side in Firestore at
// roles/{their email} with a field role: "admin" or "viewer". This is
// looked up fresh after every sign-in. Actual write protection is enforced
// server-side by Firestore Security Rules (see firestore.rules) — not just
// this UI, so a Viewer genuinely cannot write even by inspecting the page.
let currentUserRole = null; // "admin" | "viewer" | null (not signed in / not yet known)

async function fetchUserRole() {
  if (!fauth || !fauth.currentUser) { currentUserRole = null; return; }
  try {
    const snap = await fdb.collection("roles").doc(fauth.currentUser.email).get();
    currentUserRole = (snap.exists && snap.data().role === "admin") ? "admin" : "viewer";
  } catch (err) {
    console.error("Couldn't look up role, defaulting to Viewer:", err);
    currentUserRole = "viewer";
  }
}

function isAdmin() {
  return !!(fauth && fauth.currentUser) && currentUserRole === "admin";
}
function paintRoleUI() {
  const badge = document.getElementById("roleBadge");
  const btn = document.getElementById("roleSwitchBtn");
  const emailLbl = document.getElementById("roleEmailLabel");
  if (!badge || !btn) return;
  const signedIn = !!(fauth && fauth.currentUser);
  const admin = isAdmin();
  badge.textContent = !signedIn ? "Signed out" : (admin ? "Admin" : "Viewer");
  badge.className = "role-badge " + (admin ? "admin" : "viewer");
  btn.textContent = "Sign Out";
  btn.style.display = signedIn ? "" : "none";
  if (emailLbl) emailLbl.textContent = signedIn ? (fauth.currentUser.email || "") : "";
}
document.getElementById("roleSwitchBtn").addEventListener("click", () => {
  if (!fauth || !fauth.currentUser) return;
  fauth.signOut();
  toast("Signed out");
});

function viewerNotice() {
  if (isAdmin()) return "";
  return `<div class="viewer-note">👁️ You're signed in as a <strong>Viewer</strong> — read-only. Ask an Admin to grant you edit access from Settings → Team Access.</div>`;
}

/* ---------------- Persistence (Cloud Firestore) ---------------- */
function seedFromSource() {
  const d = JSON.parse(JSON.stringify(SEED_DATA));
  return {
    employees: d.employees.map(e => ({ ...e, uid: uid() })),
    categories: d.categories.map(c => ({ ...c, uid: uid() })),
    lists: d.lists,
    assignments: d.assignments.map(a => ({ ...a, uid: uid() })),
    refills: d.refills.map(r => ({ ...r, uid: uid() })),
    inventory: [],
    stockManual: d.stockManual,
  };
}

async function loadInitialData() {
  const snap = await docRef().get();
  if (snap.exists) {
    DB = snap.data();
  } else {
    // First time this Firestore project is used — seed it with the original sheet data.
    // (Safe to write here because loadInitialData is only ever called after sign-in.)
    DB = seedFromSource();
    await docRef().set(DB);
  }
  if (!DB.inventory) DB.inventory = [];
}

function saveDB() {
  if (!fdb) return;
  docRef().set(DB).catch(err => {
    console.error(err);
    toast("Couldn't save to the cloud — check your connection or admin sign-in", "err");
  });
}

let unsubscribeSnapshot = null;
function attachRealtimeListener() {
  unsubscribeSnapshot = docRef().onSnapshot(snap => {
    if (!snap.exists) return;
    DB = snap.data();
    if (!DB.inventory) DB.inventory = [];
    goto(currentPage); // keep every open browser (signed-in users) in sync live
  }, err => console.error("Firestore listener error:", err));
}
function detachRealtimeListener() {
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
}

function uid() {
  return "id_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

// Assignment rows get an auto-captured `createdAt` timestamp when added, used
// (a) to order the list by real time — newest on top — rather than just by
// the user-entered Date field, and (b) to show a time alongside the date.
function fmtTimeOnly(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (isNaN(dt)) return "";
  return dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}
function fmtAssignDateCell(a) {
  const dateStr = fmtDate(a.date);
  const t = fmtTimeOnly(a.createdAt);
  return t ? `${dateStr} <span class="muted" style="font-size:11px;">${t}</span>` : dateStr;
}
function assignSortKey(a) {
  // Records created before this feature don't have createdAt — fall back to
  // the Date field (treated as midnight) so old and new rows still sort together.
  return a.createdAt || (a.date ? a.date + "T00:00:00" : "");
}
function sortAssignmentsNewestFirst(list) {
  return [...list].sort((a, b) => assignSortKey(b).localeCompare(assignSortKey(a)));
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg, kind = "ok") {
  const el = document.getElementById("toast");
  el.textContent = (kind === "ok" ? "✓ " : kind === "err" ? "✕ " : "ℹ ") + msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ---------------- Modal ---------------- */
function openModal(title, bodyHtml, onMount) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalOverlay").classList.add("open");
  if (onMount) onMount();
}
function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  document.getElementById("modalBody").innerHTML = "";
  document.getElementById("modal").classList.remove("modal-wide");
}
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

function requireAdminOrWarn() {
  if (isAdmin()) return true;
  toast("Only Admins can do this — you're signed in as a Viewer", "err");
  return false;
}

/* ---------------- Generic bulk-delete confirm ---------------- */
function confirmBulkDelete(count, label, onConfirm) {
  openModal(`Delete ${count} ${label}?`, `
    <p class="muted" style="margin-top:0">This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBulk">Cancel</button>
      <button class="btn btn-danger" id="confirmBulk">Delete ${count}</button>
    </div>`, () => {
    document.getElementById("cancelBulk").onclick = closeModal;
    document.getElementById("confirmBulk").onclick = () => { onConfirm(); closeModal(); };
  });
}

/* Renders the "N selected · Delete Selected · Delete All" strip used on every list page */
function bulkToolbarHtml(selectedSize, totalSize) {
  if (!isAdmin()) return "";
  return `
    <div class="bulk-actions">
      <span class="bulk-count">${selectedSize} selected</span>
      <button class="btn btn-danger btn-sm" id="deleteSelectedBtn" ${selectedSize === 0 ? "disabled" : ""}>🗑 Delete Selected</button>
      <button class="btn btn-secondary btn-sm" id="deleteAllBtn" ${totalSize === 0 ? "disabled" : ""}>Delete All</button>
    </div>
  `;
}

/* ---------------- Computed: Stock Summary ---------------- */
function computeStockSummary() {
  return DB.categories.map(cat => {
    const name = cat.name;
    const total = DB.refills
      .filter(r => r.category === name)
      .reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const assigned = DB.assignments
      .filter(a => a.assetName === name && a.status === "Assigned").length;
    const manual = DB.stockManual[name] || { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5 };
    const available = total - assigned - manual.underRepair - manual.faulty - manual.lost - manual.scrap;
    const low = available <= manual.threshold;
    return {
      category: name, total, assigned,
      underRepair: manual.underRepair, faulty: manual.faulty,
      lost: manual.lost, scrap: manual.scrap,
      threshold: manual.threshold, available, low,
    };
  });
}

function computeDashboard() {
  const rows = computeStockSummary();
  return {
    categories: DB.categories.length,
    total: rows.reduce((s, r) => s + r.total, 0),
    available: rows.reduce((s, r) => s + r.available, 0),
    assigned: rows.reduce((s, r) => s + r.assigned, 0),
    underRepair: rows.reduce((s, r) => s + r.underRepair, 0),
    faulty: rows.reduce((s, r) => s + r.faulty, 0),
    lost: rows.reduce((s, r) => s + r.lost, 0),
    scrap: rows.reduce((s, r) => s + r.scrap, 0),
    lowStockCount: rows.filter(r => r.low).length,
    rows,
  };
}

function statusBadge(status) {
  const map = {
    "Assigned": "badge-blue", "Available": "badge-green", "Returned": "badge-green",
    "Under Repair": "badge-amber", "Overdue": "badge-red",
    "Faulty": "badge-red", "Lost": "badge-grey", "Scrap": "badge-grey",
    "OK": "badge-green", "⚠ Low Stock": "badge-amber",
  };
  const cls = map[status] || "badge-grey";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

/* =========================================================
   ROUTER
   ========================================================= */
const PAGES = {
  dashboard: { title: "Dashboard", render: renderDashboard },
  assignment: { title: "Asset Assignment", render: renderAssignment },
  inventory: { title: "Master Inventory", render: renderInventory },
  employees: { title: "Employees", render: renderEmployees },
  empHistory: { title: "Employee History", render: renderEmployeeHistory },
  stock: { title: "Stock Summary", render: renderStock },
  refill: { title: "Stock Refill Log", render: renderRefill },
  categories: { title: "Asset Categories", render: renderCategories },
  activityLog: { title: "Activity Log", render: renderActivityLog },
  settings: { title: "Settings", render: renderSettings },
};

function goto(page) {
  if (!PAGES[page]) page = "dashboard"; // guard against a stale/invalid saved page
  currentPage = page;
  localStorage.setItem(LAST_PAGE_KEY, page);
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  document.getElementById("pageTitle").textContent = PAGES[page].title;
  document.getElementById("content").innerHTML = "";
  PAGES[page].render();
  document.getElementById("sidebar").classList.remove("open");
  window.scrollTo(0, 0);
}

document.getElementById("nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (btn) goto(btn.dataset.page);
});
document.getElementById("hamburger").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
});
const RESET_CONFIRM_PASSWORD = "reset123"; // change this to whatever you like — required to actually run a reset

document.getElementById("resetDataBtn").addEventListener("click", () => {
  if (!requireAdminOrWarn()) return;
  const isDefaultOffice = currentOfficeId === DEFAULT_OFFICE_ID;
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "this office";
  openModal("Reset this office's data?", `
    <p class="muted" style="margin-top:0">This resets the dashboard, assignments, employees and logs for
    <strong>${escapeHtml(officeName)}</strong> ${isDefaultOffice ? "back to the original uploaded sheet" : "to a blank slate"} —
    for everyone viewing this office, since data is shared live via Firebase. Other offices are not affected.
    Anything anyone has added or edited for this office will be lost.</p>
    <div class="field"><label>Type the confirmation password to continue</label>
      <input type="password" id="resetConfirmPw" placeholder="Confirmation password" autocomplete="off">
    </div>
    <p id="resetPwError" style="display:none; color:var(--red); font-weight:600; font-size:12.5px; margin-top:-6px;">Incorrect password.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelReset">Cancel</button>
      <button class="btn btn-danger" id="confirmReset">Yes, reset this office's data</button>
    </div>
  `, () => {
    const pwInp = document.getElementById("resetConfirmPw");
    pwInp.focus();
    document.getElementById("cancelReset").onclick = closeModal;
    const attempt = () => {
      if (pwInp.value !== RESET_CONFIRM_PASSWORD) {
        document.getElementById("resetPwError").style.display = "block";
        pwInp.focus();
        return;
      }
      DB = isDefaultOffice ? seedFromSource() : emptyOfficeDB();
      saveDB();
      logAction("Reset office data", `Reset all data for "${officeName}"`);
      closeModal();
      toast("Data reset for this office");
      goto(currentPage);
    };
    document.getElementById("confirmReset").onclick = attempt;
    pwInp.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  });
});

/* =========================================================
   DASHBOARD — INSIGHTS ENGINE
   Everything below computeDashboard() derives extra, read-only
   analytics purely from data already in DB — no new storage,
   no schema changes. Safe to recompute on every render.
   ========================================================= */
const DASH_PALETTE = ["var(--primary)", "var(--teal)", "var(--amber)", "var(--purple)", "var(--blue)", "var(--red)", "var(--grey)", "#2fbf8f"];

function computeDashboardInsights() {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const s = computeDashboard();

  /* Fleet allocation — where every unit of stock currently sits */
  const fleetSegments = [
    { label: "Assigned", value: s.assigned, color: "var(--blue)" },
    { label: "Available", value: s.available, color: "var(--teal)" },
    { label: "Under Repair", value: s.underRepair, color: "var(--amber)" },
    { label: "Faulty", value: s.faulty, color: "var(--red)" },
    { label: "Lost", value: s.lost, color: "var(--grey)" },
    { label: "Scrap", value: s.scrap, color: "var(--purple)" },
  ].filter(seg => seg.value > 0);

  /* Assignment status split (Assigned / Returned / Overdue / custom) */
  const statusColors = { Assigned: "var(--blue)", Returned: "var(--teal)", Overdue: "var(--red)" };
  const statusCounts = {};
  DB.assignments.forEach(a => { const k = a.status || "Unknown"; statusCounts[k] = (statusCounts[k] || 0) + 1; });
  const statusSegments = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({ label, value, color: statusColors[label] || DASH_PALETTE[i % DASH_PALETTE.length] }));

  /* Stock split by category (Total Stock, from Stock Summary logic) */
  const stockRows = computeStockSummary();
  const categorySegments = [...stockRows]
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map((r, i) => ({ label: r.category, value: r.total, color: DASH_PALETTE[i % DASH_PALETTE.length] }));

  /* Department leaderboard — currently-held (not Returned) assets per dept */
  const deptCounts = {};
  DB.assignments.forEach(a => {
    if ((a.status || "").toLowerCase() === "returned") return;
    const d = a.department || "Unassigned";
    deptCounts[d] = (deptCounts[d] || 0) + 1;
  });
  const deptLeaderboard = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, value]) => ({ label, value }));

  /* Top asset holders — people currently holding the most assets */
  const holderMap = {};
  DB.assignments.forEach(a => {
    if ((a.status || "").toLowerCase() === "returned") return;
    const key = a.employeeName || "Unknown";
    if (!holderMap[key]) holderMap[key] = { name: key, dept: a.department || "—", count: 0 };
    holderMap[key].count++;
  });
  const topHolders = Object.values(holderMap).sort((a, b) => b.count - a.count).slice(0, 5);

  /* Headcount + activity context */
  const employeesCount = DB.employees.length;
  const departmentsCount = new Set(DB.employees.map(e => e.department).filter(Boolean)).size;
  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
  const newThisWeek = DB.assignments.filter(a => a.date && new Date(a.date) >= weekAgo).length;

  // Coverage: what share of the workforce is currently holding at least one asset
  const holdersCount = Object.keys(holderMap).length;
  const coverageRate = employeesCount > 0 ? Math.round((holdersCount / employeesCount) * 100) : 0;

  // Turnover: what share of everything ever assigned has already been returned
  const returnedCount = DB.assignments.filter(a => (a.status || "").toLowerCase() === "returned").length;
  const turnoverRate = DB.assignments.length > 0 ? Math.round((returnedCount / DB.assignments.length) * 100) : 0;

  const utilizationRate = s.total > 0 ? Math.round((s.assigned / s.total) * 100) : 0;

  return {
    fleetSegments, statusSegments, categorySegments, deptLeaderboard, topHolders,
    employeesCount, departmentsCount, newThisWeek, coverageRate, turnoverRate, utilizationRate,
  };
}

/* ---- Tiny inline chart builders (no external libraries) ---- */
function insightBarList(items, opts = {}) {
  if (!items.length) return `<p class="muted" style="margin:4px 0 0;">${opts.empty || "Nothing to show yet."}</p>`;
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div class="ibar-list">${items.map((i, idx) => `
    <div class="ibar-row">
      <div class="ibar-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</div>
      <div class="ibar-track"><div class="ibar-fill" style="width:${Math.max(4, (i.value / max) * 100)}%; background:${i.color || DASH_PALETTE[idx % DASH_PALETTE.length]}"></div></div>
      <div class="ibar-value">${i.value}</div>
    </div>`).join("")}</div>`;
}

function donutChart(segments, opts = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) return `<p class="muted" style="margin:4px 0 0;">${opts.empty || "No data yet."}</p>`;
  let acc = 0;
  const stops = segments.map(seg => {
    const start = (acc / total) * 360; acc += seg.value; const end = (acc / total) * 360;
    return `${seg.color} ${start}deg ${end}deg`;
  }).join(", ");
  return `
    <div class="donut-wrap">
      <div class="donut" style="background: conic-gradient(${stops});">
        <div class="donut-hole"><div class="donut-total">${total}</div><div class="donut-sub">${escapeHtml(opts.centerLabel || "Total")}</div></div>
      </div>
      <div class="donut-legend">
        ${segments.map(seg => `
          <div class="legend-item">
            <span class="legend-dot" style="background:${seg.color}"></span>
            <span class="legend-label">${escapeHtml(seg.label)}</span>
            <span class="legend-pct">${Math.round((seg.value / total) * 100)}%</span>
            <strong>${seg.value}</strong>
          </div>`).join("")}
      </div>
    </div>`;
}

function renderDashboard() {
  const s = computeDashboard();
  const ins = computeDashboardInsights();
  const content = document.getElementById("content");
  const admin = isAdmin();

  // Cards link to wherever that number actually lives, so the dashboard
  // works as a jumping-off point rather than a dead-end summary.
  const cards = [
    { label: "Asset Categories", value: s.categories, icon: "🏷️", cls: "icon-indigo", foot: "Tracked categories", goto: "categories" },
    { label: "Total Inventory", value: s.total, icon: "📦", cls: "icon-blue", foot: "Units added via refills", goto: "stock" },
    { label: "Available", value: s.available, icon: "🟢", cls: "icon-teal", foot: "Ready to assign", goto: "stock" },
    { label: "Assigned", value: s.assigned, icon: "🔵", cls: "icon-purple", foot: "Currently in use", goto: "assignment", presetFilter: "Assigned" },
    { label: "Under Repair", value: s.underRepair, icon: "🟡", cls: "icon-amber", foot: "Being serviced", goto: "stock" },
    { label: "Faulty", value: s.faulty, icon: "🔴", cls: "icon-red", foot: "Needs attention", goto: "stock" },
    { label: "Lost", value: s.lost, icon: "✖", cls: "icon-grey", foot: "Unaccounted", goto: "stock" },
    { label: "Scrap", value: s.scrap, icon: "⚫", cls: "icon-grey", foot: "Decommissioned", goto: "stock" },
  ];

  // Second, smaller strip of derived metrics — ratios the raw counts above don't show on their own.
  const miniCards = [
    { label: "Utilization", value: `${ins.utilizationRate}%`, icon: "📈", cls: "icon-indigo", accent: "var(--primary)", foot: "Assigned ÷ total stock", goto: "stock" },
    { label: "Workforce Coverage", value: `${ins.coverageRate}%`, icon: "🧑‍💼", cls: "icon-purple", accent: "var(--purple)", foot: `${ins.employeesCount} employees, ${ins.departmentsCount} depts`, goto: "employees" },
    { label: "New This Week", value: ins.newThisWeek, icon: "🆕", cls: "icon-teal", accent: "var(--teal)", foot: "Assignments logged", goto: "assignment" },
    { label: "Turnover Rate", value: `${ins.turnoverRate}%`, icon: "🔁", cls: "icon-amber", accent: "var(--amber)", foot: "Returned ÷ all assignments", goto: "assignment" },
  ];

  const recentAssignments = sortAssignmentsNewestFirst(DB.assignments).slice(0, 6);
  const lowStockRows = s.rows.filter(r => r.low);
  const isFreshOffice = s.categories === 0;

  content.innerHTML = `
    ${viewerNotice()}
    ${isFreshOffice ? `
      <div class="viewer-note" style="align-items:flex-start;">
        <span style="font-size:16px;line-height:1.4;">👋</span>
        <div>
          <strong>This office doesn't have any asset categories yet.</strong>
          <div style="margin-top:2px;">${admin
            ? `Start on <a href="#" onclick="goto('categories');return false;" style="color:inherit;text-decoration:underline;">Asset Categories</a>, then log your starting stock in the <a href="#" onclick="goto('refill');return false;" style="color:inherit;text-decoration:underline;">Stock Refill Log</a> — the numbers below will fill in from there.`
            : `Ask an Admin to add categories and log starting stock — the numbers below will fill in from there.`}</div>
        </div>
      </div>
    ` : ""}

    <div class="stat-grid">
      ${cards.map(c => `
        <div class="stat-card" role="button" tabindex="0" title="View in ${c.goto === "assignment" ? "Asset Assignment" : c.goto === "categories" ? "Asset Categories" : "Stock Summary"}"
          style="cursor:pointer"
          onclick="${c.presetFilter ? `assignFilter.status='${c.presetFilter}';` : ""}goto('${c.goto}')"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}">
          <div class="stat-top">
            <div class="stat-icon ${c.cls}">${c.icon}</div>
            <div class="stat-label">${c.label}</div>
          </div>
          <div class="stat-value">${c.value}</div>
          <div class="stat-foot">${c.foot}</div>
        </div>
      `).join("")}
    </div>

    <div class="section-eyebrow">Performance Ratios</div>
    <div class="mini-stat-grid">
      ${miniCards.map(c => `
        <div class="mini-stat-card" role="button" tabindex="0" style="--accent:${c.accent}" onclick="goto('${c.goto}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}">
          <div class="mini-stat-icon ${c.cls}">${c.icon}</div>
          <div>
            <div class="mini-stat-value">${c.value}</div>
            <div class="mini-stat-label">${c.label}</div>
            <div class="mini-stat-foot">${c.foot}</div>
          </div>
        </div>
      `).join("")}
    </div>

    <div class="section-eyebrow">Fleet Breakdown</div>
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div><h2>Fleet Allocation</h2><div class="sub">Every unit of stock, by where it currently sits</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('stock')">Stock summary →</button>
        </div>
        ${donutChart(ins.fleetSegments, { centerLabel: "Total Stock", empty: "Log a refill to see your fleet split here." })}
      </div>

      <div class="card">
        <div class="card-header">
          <div><h2>Assignment Status</h2><div class="sub">Across all logged assignments</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('assignment')">View all →</button>
        </div>
        ${donutChart(ins.statusSegments, { centerLabel: "Assignments", empty: "No assignments logged yet." })}
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div><h2>Stock by Category</h2><div class="sub">Total units logged, largest first</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('stock')">Stock summary →</button>
        </div>
        ${insightBarList(ins.categorySegments, { empty: "Log a refill to see category totals here." })}
      </div>

      <div class="card">
        <div class="card-header">
          <div><h2>Department Leaderboard</h2><div class="sub">Assets currently held, by department</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('assignment')">Assignments →</button>
        </div>
        ${insightBarList(ins.deptLeaderboard, { color: "var(--purple)", empty: "No active assignments to break down yet." })}
      </div>
    </div>

    <div class="section-eyebrow">Activity &amp; Alerts</div>
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div><h2>Recent Assignments</h2><div class="sub">Latest activity from the assignment log${admin ? " — click a row to edit" : ""}</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('assignment')">View all →</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Asset</th><th>Employee</th><th>Dept</th><th>Status</th></tr></thead>
            <tbody>
              ${recentAssignments.length ? recentAssignments.map(a => `
                <tr ${admin ? `style="cursor:pointer" title="Click to edit" onclick="openAssignForm('${a.uid}')"` : ""}>
                  <td>${fmtAssignDateCell(a)}</td>
                  <td>${escapeHtml(a.assetName)}</td>
                  <td>${escapeHtml(a.employeeName)}</td>
                  <td>${escapeHtml(a.department || "—")}</td>
                  <td>${statusBadge(a.status)}</td>
                </tr>`).join("") : `<tr class="empty-row"><td colspan="5">No assignments yet</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div><h2>Top Asset Holders</h2><div class="sub">Most assets currently held, per person</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('empHistory')">Employee history →</button>
        </div>
        ${ins.topHolders.length ? `
          <div class="holder-list">
            ${ins.topHolders.map((h, i) => `
              <div class="holder-row">
                <div class="holder-rank">${i + 1}</div>
                <div class="holder-info">
                  <div class="holder-name">${escapeHtml(h.name)}</div>
                  <div class="muted" style="font-size:12px;">${escapeHtml(h.dept)}</div>
                </div>
                <div class="holder-count">${h.count} asset${h.count === 1 ? "" : "s"}</div>
              </div>
            `).join("")}
          </div>
        ` : `<p class="muted">No one is currently holding an asset.</p>`}
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div><h2>Low Stock Alerts</h2><div class="sub">Available ≤ threshold, across every tracked category</div></div>
        <button class="btn btn-secondary btn-sm" onclick="goto('stock')">Stock summary →</button>
      </div>
      ${lowStockRows.length ? `
        <div class="alert-grid">
          ${lowStockRows.map(r => `
            <div class="alert-chip" title="View in Stock Summary" onclick="goto('stock')">
              <div class="alert-chip-top">
                <span class="alert-chip-name">${escapeHtml(r.category)}</span>
                ${statusBadge("⚠ Low Stock")}
              </div>
              <div class="alert-chip-meta">Available <strong>${r.available}</strong> · Threshold <strong>${r.threshold}</strong></div>
            </div>
          `).join("")}
        </div>
      ` : `<p class="muted">All categories are healthily stocked. ✅</p>`}
    </div>

    <p class="footer-note"><span class="live-dot" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span>Speelfinance · Asset Management Tracker — live, synced in real time</p>
  `;
}

/* =========================================================
   ASSET ASSIGNMENT
   ========================================================= */
let assignFilter = { q: "", status: "", dept: "" };
let assignSelected = new Set();

function renderAssignment() {
  assignSelected = new Set();
  const content = document.getElementById("content");
  const depts = DB.lists.department || [];
  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Asset Assignment</h2><div class="sub" id="assignCountSub">${DB.assignments.length} records</div></div>
        ${isAdmin() ? `<button class="btn btn-primary" id="addAssignBtn">+ New Assignment</button>` : ""}
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="assignSearch" placeholder="Search employee, asset, assigned by..." value="${escapeHtml(assignFilter.q)}" /></div>
        <select class="filter-select" id="assignStatusFilter">
          <option value="">All statuses</option>
          ${(DB.lists.assignmentStatus || []).map(s => `<option value="${escapeHtml(s)}" ${assignFilter.status === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
        </select>
        <select class="filter-select" id="assignDeptFilter">
          <option value="">All departments</option>
          ${depts.map(d => `<option value="${escapeHtml(d)}" ${assignFilter.dept === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}
        </select>
        <button class="btn btn-secondary btn-sm" id="assignClearFiltersBtn" style="display:none">Clear filters</button>
        <div id="assignBulkBar"></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? `<th class="ck-col"><input type="checkbox" class="select-ck" id="assignSelectAll" aria-label="Select all assignments"></th>` : ""}
          <th>Date</th><th>Asset</th><th>Employee</th><th>Dept</th><th>Assigned By</th>
          <th>Return Date</th><th>Status</th><th>Remarks</th>${isAdmin() ? "<th></th>" : ""}
        </tr></thead>
        <tbody id="assignTbody"></tbody>
      </table></div>
    </div>
  `;

  if (isAdmin()) document.getElementById("addAssignBtn").onclick = () => openAssignForm();
  document.getElementById("assignSearch").oninput = (e) => { assignFilter.q = e.target.value.toLowerCase(); paintAssignTable(); };
  document.getElementById("assignStatusFilter").onchange = (e) => { assignFilter.status = e.target.value; paintAssignTable(); };
  document.getElementById("assignDeptFilter").onchange = (e) => { assignFilter.dept = e.target.value; paintAssignTable(); };
  document.getElementById("assignClearFiltersBtn").onclick = () => {
    assignFilter = { q: "", status: "", dept: "" };
    document.getElementById("assignSearch").value = "";
    document.getElementById("assignStatusFilter").value = "";
    document.getElementById("assignDeptFilter").value = "";
    paintAssignTable();
  };

  paintAssignTable();
}

function getFilteredAssignments() {
  let rows = sortAssignmentsNewestFirst(DB.assignments);
  if (assignFilter.q) {
    rows = rows.filter(a => [a.employeeName, a.assetName, a.assignedBy, a.remarks].join(" ").toLowerCase().includes(assignFilter.q));
  }
  if (assignFilter.status) rows = rows.filter(a => a.status === assignFilter.status);
  if (assignFilter.dept) rows = rows.filter(a => a.department === assignFilter.dept);
  return rows;
}

function paintAssignTable() {
  const tbody = document.getElementById("assignTbody");
  if (!tbody) return;
  const rows = getFilteredAssignments();
  const admin = isAdmin();
  const filterActive = !!(assignFilter.q || assignFilter.status || assignFilter.dept);

  const countSub = document.getElementById("assignCountSub");
  if (countSub) {
    countSub.textContent = filterActive
      ? `${rows.length} of ${DB.assignments.length} records (filtered)`
      : `${DB.assignments.length} records`;
  }
  const clearBtn = document.getElementById("assignClearFiltersBtn");
  if (clearBtn) clearBtn.style.display = filterActive ? "" : "none";

  tbody.innerHTML = rows.length ? rows.map(a => `
    <tr>
      ${admin ? `<td class="ck-col"><input type="checkbox" class="select-ck row-ck" data-uid="${a.uid}" aria-label="Select assignment for ${escapeHtml(a.employeeName)}" ${assignSelected.has(a.uid) ? "checked" : ""}></td>` : ""}
      <td>${fmtAssignDateCell(a)}</td>
      <td>${escapeHtml(a.assetName)}</td>
      <td>${escapeHtml(a.employeeName)}</td>
      <td>${escapeHtml(a.department || "—")}</td>
      <td>${escapeHtml(a.assignedBy || "—")}</td>
      <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${escapeHtml(a.remarks || "—")}</td>
      ${admin ? `<td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" title="Edit" aria-label="Edit assignment for ${escapeHtml(a.employeeName)}" onclick="openAssignForm('${a.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" title="Delete" aria-label="Delete assignment for ${escapeHtml(a.employeeName)}" onclick="deleteAssignment('${a.uid}')">🗑️</button>
        </div>
      </td>` : ""}
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="10">${filterActive ? `No records match your search/filters. <a href="#" id="assignEmptyClear" style="color:var(--primary);font-weight:600;">Clear filters</a>` : "No assignments yet"}</td></tr>`;

  document.getElementById("assignBulkBar").innerHTML = bulkToolbarHtml(assignSelected.size, rows.length);
  const emptyClear = document.getElementById("assignEmptyClear");
  if (emptyClear) emptyClear.onclick = (e) => { e.preventDefault(); document.getElementById("assignClearFiltersBtn").click(); };
  wireAssignBulk(rows);
}

function wireAssignBulk(rows) {
  if (!isAdmin()) return;
  const selectAll = document.getElementById("assignSelectAll");
  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => assignSelected.has(r.uid));
    selectAll.onchange = (e) => {
      rows.forEach(r => e.target.checked ? assignSelected.add(r.uid) : assignSelected.delete(r.uid));
      paintAssignTable();
    };
  }
  document.querySelectorAll("#assignTbody .row-ck").forEach(ck => {
    ck.onchange = () => {
      ck.checked ? assignSelected.add(ck.dataset.uid) : assignSelected.delete(ck.dataset.uid);
      document.getElementById("assignBulkBar").innerHTML = bulkToolbarHtml(assignSelected.size, rows.length);
      wireAssignBulk(rows);
    };
  });
  const delSel = document.getElementById("deleteSelectedBtn");
  if (delSel) delSel.onclick = () => {
    if (!requireAdminOrWarn() || assignSelected.size === 0) return;
    confirmBulkDelete(assignSelected.size, "assignments", () => {
      const n = assignSelected.size;
      DB.assignments = DB.assignments.filter(a => !assignSelected.has(a.uid));
      assignSelected = new Set();
      saveDB(); logAction("Bulk deleted assignments", `Deleted ${n} selected assignment record(s)`); toast("Selected assignments deleted"); paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) {
    delAll.title = "Deletes only the assignments currently shown by your search/filters — not the whole log";
    delAll.onclick = () => {
      if (!requireAdminOrWarn()) return;
      confirmBulkDelete(rows.length, "assignments (matching your current search/filters)", () => {
        const idsToDelete = new Set(rows.map(r => r.uid));
        const n = idsToDelete.size;
        DB.assignments = DB.assignments.filter(a => !idsToDelete.has(a.uid));
        assignSelected = new Set();
        saveDB(); logAction("Bulk deleted assignments", `Deleted ${n} assignment record(s) matching current filters`); toast("All matching assignments deleted"); paintAssignTable();
        if (currentPage === "dashboard") renderDashboard();
      });
    };
  }
}

function openAssignForm(uidVal) {
  if (!requireAdminOrWarn()) return;
  const editing = uidVal ? DB.assignments.find(a => a.uid === uidVal) : null;
  const cats = DB.categories.map(c => c.name);
  const depts = DB.lists.department || [];
  const statuses = DB.lists.assignmentStatus || ["Assigned", "Returned", "Overdue"];

  const assetFieldHtml = editing
    ? `<div class="field"><label>Asset</label>
        <select id="f_asset">${cats.map(c => `<option ${editing.assetName === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
      </div>`
    : `<div class="field">
        <label>Assets <span class="muted" style="font-weight:500;">(tick one or more — one entry gets logged for each, so you don't have to retype the employee)</span></label>
        <div class="asset-multiselect" id="assetMultiSelect">
          <div class="asset-multiselect-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="assetSelectAll">Select All</button>
            <button type="button" class="btn btn-secondary btn-sm" id="assetSelectNone">Clear</button>
          </div>
          ${cats.map(c => `
            <label class="asset-check-row">
              <input type="checkbox" class="f_asset_multi" value="${escapeHtml(c)}">
              <span>${escapeHtml(c)}</span>
            </label>
          `).join("")}
        </div>
      </div>`;

  openModal(editing ? "Edit Assignment" : "New Assignment", `
    ${editing ? `
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" id="f_date" value="${editing.date || ""}"></div>
      ${assetFieldHtml}
    </div>` : `
    <div class="field"><label>Date</label><input type="date" id="f_date" value="${todayISO()}"></div>
    ${assetFieldHtml}
    `}
    <div class="field-row">
      <div class="field"><label>Employee Name</label>
        <input type="text" id="f_emp" list="empList" value="${escapeHtml(editing ? editing.employeeName : "")}" placeholder="Type or pick a name — ID & department auto-fill">
        <datalist id="empList">${DB.employees.map(e => `<option value="${escapeHtml(e.name)}">`).join("")}</datalist>
      </div>
      <div class="field"><label>Employee ID</label><input type="text" id="f_empid" value="${escapeHtml(editing ? editing.employeeId || "" : "")}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Department</label>
        <select id="f_dept"><option value="">—</option>${depts.map(d => `<option ${editing && editing.department === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Assigned By</label><input type="text" id="f_by" value="${escapeHtml(editing ? editing.assignedBy || "" : "")}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Status</label>
        <select id="f_status">${statuses.map(s => `<option ${(editing ? editing.status === s : s === "Assigned") ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Return Date</label><input type="date" id="f_return" value="${editing ? editing.returnDate || "" : ""}"></div>
    </div>
    <div class="field"><label>Remarks</label><textarea id="f_remarks" rows="2">${escapeHtml(editing ? editing.remarks || "" : "")}</textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">${editing ? "Save Changes" : "Add Assignment"}</button>
    </div>
  `, () => {
    // Auto-fill Employee ID + Department when a known employee name is entered/selected.
    // Only touches fields the user hasn't already typed into themselves, so it can't
    // silently overwrite a manual correction while someone is mid-edit.
    const empIdInput = document.getElementById("f_empid");
    const deptSel = document.getElementById("f_dept");
    let empIdTouched = !!empIdInput.value.trim();
    let deptTouched = editing ? !!deptSel.value : false;
    empIdInput.addEventListener("input", () => { empIdTouched = true; });
    deptSel.addEventListener("change", () => { deptTouched = true; });

    const empInput = document.getElementById("f_emp");
    const autofillFromName = () => {
      const typed = empInput.value.trim().toLowerCase();
      if (!typed) return;
      const match = DB.employees.find(e => (e.name || "").trim().toLowerCase() === typed);
      if (!match) return;
      if (!empIdTouched && match.id) empIdInput.value = match.id;
      if (!deptTouched && match.department && [...deptSel.options].some(o => o.value === match.department)) {
        deptSel.value = match.department;
      }
    };
    empInput.addEventListener("input", autofillFromName);
    empInput.addEventListener("change", autofillFromName);
    if (!editing) autofillFromName();

    if (!editing) {
      document.getElementById("assetSelectAll").onclick = () => {
        document.querySelectorAll(".f_asset_multi").forEach(cb => cb.checked = true);
      };
      document.getElementById("assetSelectNone").onclick = () => {
        document.querySelectorAll(".f_asset_multi").forEach(cb => cb.checked = false);
      };
    }

    document.getElementById("cancelBtn").onclick = closeModal;
    document.getElementById("saveBtn").onclick = () => {
      const empName = document.getElementById("f_emp").value.trim();
      if (!empName) { toast("Employee name is required", "err"); return; }
      if (!document.getElementById("f_date").value) { toast("Date is required", "err"); return; }

      const common = {
        date: document.getElementById("f_date").value,
        employeeName: empName,
        employeeId: document.getElementById("f_empid").value.trim(),
        department: document.getElementById("f_dept").value,
        assignedBy: document.getElementById("f_by").value.trim(),
        status: document.getElementById("f_status").value,
        returnDate: document.getElementById("f_return").value,
        remarks: document.getElementById("f_remarks").value.trim(),
      };

      if (editing) {
        const rec = { ...common, assetName: document.getElementById("f_asset").value };
        Object.assign(editing, rec);
        logAction("Edited assignment", `${rec.assetName} → ${empName}`);
        toast("Assignment updated");
      } else {
        const selectedAssets = [...document.querySelectorAll(".f_asset_multi:checked")].map(cb => cb.value);
        if (!selectedAssets.length) { toast("Select at least one asset", "err"); return; }
        selectedAssets.forEach(assetName => {
          DB.assignments.push({ uid: uid(), id: DB.assignments.length + 1, createdAt: nowISO(), ...common, assetName });
        });
        logAction("Added assignment(s)", `${selectedAssets.join(", ")} → ${empName}`);
        toast(selectedAssets.length > 1
          ? `${selectedAssets.length} assignments added for ${empName}`
          : "Assignment added");
      }
      saveDB();
      closeModal();
      paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    };
  });
}

function deleteAssignment(uidVal) {
  if (!requireAdminOrWarn()) return;
  const rec = DB.assignments.find(a => a.uid === uidVal);
  const desc = rec ? `<strong>${escapeHtml(rec.assetName)}</strong> assigned to <strong>${escapeHtml(rec.employeeName)}</strong>` : "this assignment";
  openModal("Delete assignment?", `
    <p class="muted" style="margin-top:0">Delete ${desc}? This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.assignments = DB.assignments.filter(a => a.uid !== uidVal);
      assignSelected.delete(uidVal);
      saveDB(); logAction("Deleted assignment", rec ? `${rec.assetName} — ${rec.employeeName}` : uidVal); closeModal(); toast("Assignment deleted"); paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    };
  });
}

/* =========================================================
   MASTER INVENTORY
   ========================================================= */
let invFilter = { q: "" };
let invSelected = new Set();

function renderInventory() {
  invSelected = new Set();
  const content = document.getElementById("content");
  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Master Inventory</h2><div class="sub">${DB.inventory.length} individual assets tracked by Asset ID</div></div>
        ${isAdmin() ? `<button class="btn btn-primary" id="addInvBtn">+ Add Asset</button>` : ""}
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="invSearch" placeholder="Search asset ID, brand, serial, assignee..." /></div>
        <div id="invBulkBar"></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? `<th class="ck-col"><input type="checkbox" class="select-ck" id="invSelectAll"></th>` : ""}
          <th>Asset ID</th><th>Asset Name</th><th>Brand</th><th>Model</th><th>Serial</th>
          <th>Purchase Date</th><th>Status</th><th>Assigned To</th><th>Floor</th><th>Condition</th>${isAdmin() ? "<th></th>" : ""}
        </tr></thead>
        <tbody id="invTbody"></tbody>
      </table></div>
    </div>
  `;
  if (isAdmin()) document.getElementById("addInvBtn").onclick = () => openInvForm();
  document.getElementById("invSearch").oninput = (e) => { invFilter.q = e.target.value.toLowerCase(); paintInvTable(); };
  paintInvTable();
}

function getFilteredInventory() {
  // Newest added first — DB.inventory is appended to (push) as assets are
  // added, so reversing gives most-recently-added items at the top.
  let rows = [...DB.inventory].reverse();
  if (invFilter.q) rows = rows.filter(r => Object.values(r).join(" ").toLowerCase().includes(invFilter.q));
  return rows;
}

function paintInvTable() {
  const tbody = document.getElementById("invTbody");
  if (!tbody) return;
  const rows = getFilteredInventory();
  const admin = isAdmin();

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      ${admin ? `<td class="ck-col"><input type="checkbox" class="select-ck row-ck" data-uid="${r.uid}" ${invSelected.has(r.uid) ? "checked" : ""}></td>` : ""}
      <td><strong>${escapeHtml(r.assetId)}</strong></td>
      <td>${escapeHtml(r.assetName)}</td>
      <td>${escapeHtml(r.brand || "—")}</td>
      <td>${escapeHtml(r.model || "—")}</td>
      <td>${escapeHtml(r.serial || "—")}</td>
      <td>${r.purchaseDate ? fmtDate(r.purchaseDate) : "—"}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${escapeHtml(r.assignedTo || "—")}</td>
      <td>${escapeHtml(r.floor || "—")}</td>
      <td>${escapeHtml(r.condition || "—")}</td>
      ${admin ? `<td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openInvForm('${r.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteInv('${r.uid}')">🗑️</button>
        </div>
      </td>` : ""}
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="11">No assets yet — click "Add Asset" to register individual items (PCs, phones, etc.) beyond the category-level stock counts.</td></tr>`;

  document.getElementById("invBulkBar").innerHTML = bulkToolbarHtml(invSelected.size, rows.length);
  wireInvBulk(rows);
}

function wireInvBulk(rows) {
  if (!isAdmin()) return;
  const selectAll = document.getElementById("invSelectAll");
  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => invSelected.has(r.uid));
    selectAll.onchange = (e) => {
      rows.forEach(r => e.target.checked ? invSelected.add(r.uid) : invSelected.delete(r.uid));
      paintInvTable();
    };
  }
  document.querySelectorAll("#invTbody .row-ck").forEach(ck => {
    ck.onchange = () => {
      ck.checked ? invSelected.add(ck.dataset.uid) : invSelected.delete(ck.dataset.uid);
      document.getElementById("invBulkBar").innerHTML = bulkToolbarHtml(invSelected.size, rows.length);
      wireInvBulk(rows);
    };
  });
  const delSel = document.getElementById("deleteSelectedBtn");
  if (delSel) delSel.onclick = () => {
    if (!requireAdminOrWarn() || invSelected.size === 0) return;
    confirmBulkDelete(invSelected.size, "assets", () => {
      const n = invSelected.size;
      DB.inventory = DB.inventory.filter(r => !invSelected.has(r.uid));
      invSelected = new Set();
      saveDB(); logAction("Bulk deleted inventory assets", `Deleted ${n} selected asset(s)`); toast("Selected assets deleted"); paintInvTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "assets (matching current search)", () => {
      const idsToDelete = new Set(rows.map(r => r.uid));
      const n = idsToDelete.size;
      DB.inventory = DB.inventory.filter(r => !idsToDelete.has(r.uid));
      invSelected = new Set();
      saveDB(); logAction("Bulk deleted inventory assets", `Deleted ${n} asset(s) matching current filters`); toast("All matching assets deleted"); paintInvTable();
    });
  };
}

function openInvForm(uidVal) {
  if (!requireAdminOrWarn()) return;
  const editing = uidVal ? DB.inventory.find(r => r.uid === uidVal) : null;
  const cats = DB.categories.map(c => c.name);
  const statuses = DB.lists.status || [];
  const floors = DB.lists.floor || [];
  const conditions = DB.lists.condition || [];
  const depts = DB.lists.department || [];

  openModal(editing ? "Edit Asset" : "Add Asset", `
    <div class="field-row">
      <div class="field"><label>Asset ID</label><input type="text" id="f_id" value="${escapeHtml(editing ? editing.assetId : "AST-" + (DB.inventory.length + 1).toString().padStart(4, "0"))}"></div>
      <div class="field"><label>Asset Name / Category</label>
        <select id="f_name">${cats.map(c => `<option ${editing && editing.assetName === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Brand</label><input type="text" id="f_brand" value="${escapeHtml(editing ? editing.brand || "" : "")}"></div>
      <div class="field"><label>Model</label><input type="text" id="f_model" value="${escapeHtml(editing ? editing.model || "" : "")}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Serial Number</label><input type="text" id="f_serial" value="${escapeHtml(editing ? editing.serial || "" : "")}"></div>
      <div class="field"><label>Purchase Date</label><input type="date" id="f_pdate" value="${editing ? editing.purchaseDate || "" : ""}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Purchase Cost (₹)</label><input type="number" id="f_cost" value="${editing ? editing.purchaseCost || "" : ""}"></div>
      <div class="field"><label>Vendor</label><input type="text" id="f_vendor" value="${escapeHtml(editing ? editing.vendor || "" : "")}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Warranty Expiry</label><input type="date" id="f_warranty" value="${editing ? editing.warrantyExpiry || "" : ""}"></div>
      <div class="field"><label>Current Status</label>
        <select id="f_status">${statuses.map(s => `<option ${(editing ? editing.status === s : s === "Available") ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Assigned To</label><input type="text" id="f_assignedTo" value="${escapeHtml(editing ? editing.assignedTo || "" : "")}"></div>
      <div class="field"><label>Department</label>
        <select id="f_dept"><option value="">—</option>${depts.map(d => `<option ${editing && editing.department === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Floor</label>
        <select id="f_floor"><option value="">—</option>${floors.map(f => `<option ${editing && editing.floor === f ? "selected" : ""}>${escapeHtml(f)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Condition</label>
        <select id="f_cond"><option value="">—</option>${conditions.map(c => `<option ${editing && editing.condition === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field"><label>Location / Remarks</label><textarea id="f_remarks" rows="2">${escapeHtml(editing ? editing.remarks || "" : "")}</textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">${editing ? "Save Changes" : "Add Asset"}</button>
    </div>
  `, () => {
    document.getElementById("cancelBtn").onclick = closeModal;
    document.getElementById("saveBtn").onclick = () => {
      const assetId = document.getElementById("f_id").value.trim();
      if (!assetId) { toast("Asset ID is required", "err"); return; }
      const rec = {
        assetId,
        assetName: document.getElementById("f_name").value,
        brand: document.getElementById("f_brand").value.trim(),
        model: document.getElementById("f_model").value.trim(),
        serial: document.getElementById("f_serial").value.trim(),
        purchaseDate: document.getElementById("f_pdate").value,
        purchaseCost: document.getElementById("f_cost").value,
        vendor: document.getElementById("f_vendor").value.trim(),
        warrantyExpiry: document.getElementById("f_warranty").value,
        status: document.getElementById("f_status").value,
        assignedTo: document.getElementById("f_assignedTo").value.trim(),
        department: document.getElementById("f_dept").value,
        floor: document.getElementById("f_floor").value,
        condition: document.getElementById("f_cond").value,
        remarks: document.getElementById("f_remarks").value.trim(),
      };
      if (editing) { Object.assign(editing, rec); logAction("Edited inventory asset", `${rec.assetId} — ${rec.assetName}`); toast("Asset updated"); }
      else { DB.inventory.push({ uid: uid(), ...rec }); logAction("Added inventory asset", `${rec.assetId} — ${rec.assetName}`); toast("Asset added"); }
      saveDB(); closeModal(); paintInvTable();
    };
  });
}

function deleteInv(uidVal) {
  if (!requireAdminOrWarn()) return;
  const rec = DB.inventory.find(r => r.uid === uidVal);
  openModal("Delete asset?", `
    <p class="muted" style="margin-top:0">This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.inventory = DB.inventory.filter(r => r.uid !== uidVal);
      invSelected.delete(uidVal);
      saveDB(); logAction("Deleted inventory asset", rec ? `${rec.assetId} — ${rec.assetName}` : uidVal); closeModal(); toast("Asset deleted"); paintInvTable();
    };
  });
}

/* =========================================================
   EMPLOYEES
   ========================================================= */
let empFilter = { q: "", dept: "" };
let empSelected = new Set();

function renderEmployees() {
  empSelected = new Set();
  const content = document.getElementById("content");
  const depts = [...new Set(DB.employees.map(e => e.department).filter(Boolean))].sort();
  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Employees</h2><div class="sub">${DB.employees.length} employees</div></div>
        <div style="display:flex; gap:8px;">
          ${isAdmin() ? `<button class="btn btn-secondary" id="uploadEmpBtn">⬆ Upload CSV / Excel</button>` : ""}
          ${isAdmin() ? `<button class="btn btn-primary" id="addEmpBtn">+ Add Employee</button>` : ""}
        </div>
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="empSearch" placeholder="Search name or ID..." /></div>
        <select class="filter-select" id="empDeptFilter">
          <option value="">All departments</option>
          ${depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")}
        </select>
        <div id="empBulkBar"></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? `<th class="ck-col"><input type="checkbox" class="select-ck" id="empSelectAll"></th>` : ""}
          <th>Employee ID</th><th>Name</th><th>Department</th><th>Email</th><th>Phone</th>${isAdmin() ? "<th></th>" : ""}
        </tr></thead>
        <tbody id="empTbody"></tbody>
      </table></div>
    </div>
  `;
  if (isAdmin()) {
    document.getElementById("addEmpBtn").onclick = () => openEmpForm();
    document.getElementById("uploadEmpBtn").onclick = () => document.getElementById("employeeFileInput").click();
  }
  document.getElementById("empSearch").oninput = (e) => { empFilter.q = e.target.value.toLowerCase(); paintEmpTable(); };
  document.getElementById("empDeptFilter").onchange = (e) => { empFilter.dept = e.target.value; paintEmpTable(); };
  paintEmpTable();
}

function getFilteredEmployees() {
  let rows = [...DB.employees];
  if (empFilter.q) rows = rows.filter(e => `${e.id} ${e.name}`.toLowerCase().includes(empFilter.q));
  if (empFilter.dept) rows = rows.filter(e => e.department === empFilter.dept);
  return rows;
}

function paintEmpTable() {
  const tbody = document.getElementById("empTbody");
  if (!tbody) return;
  const rows = getFilteredEmployees();
  const admin = isAdmin();

  tbody.innerHTML = rows.length ? rows.map(e => `
    <tr>
      ${admin ? `<td class="ck-col"><input type="checkbox" class="select-ck row-ck" data-uid="${e.uid}" ${empSelected.has(e.uid) ? "checked" : ""}></td>` : ""}
      <td>${escapeHtml(e.id || "—")}</td>
      <td>${escapeHtml(e.name)}</td>
      <td>${escapeHtml(e.department || "—")}</td>
      <td>${escapeHtml(e.email || "—")}</td>
      <td>${escapeHtml(e.phone || "—")}</td>
      ${admin ? `<td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openEmpForm('${e.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteEmp('${e.uid}')">🗑️</button>
        </div>
      </td>` : ""}
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="6">No employees found</td></tr>`;

  document.getElementById("empBulkBar").innerHTML = bulkToolbarHtml(empSelected.size, rows.length);
  wireEmpBulk(rows);
}

function wireEmpBulk(rows) {
  if (!isAdmin()) return;
  const selectAll = document.getElementById("empSelectAll");
  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => empSelected.has(r.uid));
    selectAll.onchange = (e) => {
      rows.forEach(r => e.target.checked ? empSelected.add(r.uid) : empSelected.delete(r.uid));
      paintEmpTable();
    };
  }
  document.querySelectorAll("#empTbody .row-ck").forEach(ck => {
    ck.onchange = () => {
      ck.checked ? empSelected.add(ck.dataset.uid) : empSelected.delete(ck.dataset.uid);
      document.getElementById("empBulkBar").innerHTML = bulkToolbarHtml(empSelected.size, rows.length);
      wireEmpBulk(rows);
    };
  });
  const delSel = document.getElementById("deleteSelectedBtn");
  if (delSel) delSel.onclick = () => {
    if (!requireAdminOrWarn() || empSelected.size === 0) return;
    confirmBulkDelete(empSelected.size, "employees", () => {
      const n = empSelected.size;
      DB.employees = DB.employees.filter(e => !empSelected.has(e.uid));
      empSelected = new Set();
      saveDB(); logAction("Bulk deleted employees", `Deleted ${n} selected employee(s)`); toast("Selected employees deleted"); paintEmpTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "employees (matching current search)", () => {
      const idsToDelete = new Set(rows.map(r => r.uid));
      const n = idsToDelete.size;
      DB.employees = DB.employees.filter(e => !idsToDelete.has(e.uid));
      empSelected = new Set();
      saveDB(); logAction("Bulk deleted employees", `Deleted ${n} employee(s) matching current filters`); toast("All matching employees deleted"); paintEmpTable();
    });
  };
}

function openEmpForm(uidVal) {
  if (!requireAdminOrWarn()) return;
  const editing = uidVal ? DB.employees.find(e => e.uid === uidVal) : null;
  const depts = DB.lists.department || [];
  openModal(editing ? "Edit Employee" : "Add Employee", `
    <div class="field-row">
      <div class="field"><label>Employee ID</label><input type="text" id="f_id" value="${escapeHtml(editing ? editing.id || "" : "")}"></div>
      <div class="field"><label>Name</label><input type="text" id="f_name" value="${escapeHtml(editing ? editing.name : "")}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Department</label>
        <select id="f_dept"><option value="">—</option>${depts.map(d => `<option ${editing && editing.department === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Phone</label><input type="text" id="f_phone" value="${escapeHtml(editing ? editing.phone || "" : "")}"></div>
    </div>
    <div class="field"><label>Email</label><input type="email" id="f_email" value="${escapeHtml(editing ? editing.email || "" : "")}"></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">${editing ? "Save Changes" : "Add Employee"}</button>
    </div>
  `, () => {
    document.getElementById("cancelBtn").onclick = closeModal;
    document.getElementById("saveBtn").onclick = () => {
      const name = document.getElementById("f_name").value.trim();
      if (!name) { toast("Name is required", "err"); return; }
      const rec = {
        id: document.getElementById("f_id").value.trim(),
        name,
        department: document.getElementById("f_dept").value,
        phone: document.getElementById("f_phone").value.trim(),
        email: document.getElementById("f_email").value.trim(),
      };
      if (editing) { Object.assign(editing, rec); logAction("Edited employee", `${rec.name}${rec.id ? " (" + rec.id + ")" : ""}`); toast("Employee updated"); }
      else { DB.employees.push({ uid: uid(), ...rec }); logAction("Added employee", `${rec.name}${rec.id ? " (" + rec.id + ")" : ""}`); toast("Employee added"); }
      saveDB(); closeModal(); paintEmpTable();
    };
  });
}

function deleteEmp(uidVal) {
  if (!requireAdminOrWarn()) return;
  const rec = DB.employees.find(e => e.uid === uidVal);
  openModal("Remove employee?", `
    <p class="muted" style="margin-top:0">This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Remove</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.employees = DB.employees.filter(e => e.uid !== uidVal);
      empSelected.delete(uidVal);
      saveDB(); logAction("Removed employee", rec ? rec.name : uidVal); closeModal(); toast("Employee removed"); paintEmpTable();
    };
  });
}

/* ---------------- Employee bulk import (CSV / XLSX / XLS) ---------------- */
const EMP_HEADER_ALIASES = {
  id: ["employee id", "emp id", "id", "empid", "employeeid"],
  name: ["employee name", "name", "full name", "emp name"],
  department: ["department", "dept", "team"],
  email: ["email", "email address", "e-mail"],
  phone: ["phone", "mobile", "contact", "phone number", "mobile number"],
};

function mapRowToEmployee(row) {
  // row is an object with arbitrary header keys (from SheetJS sheet_to_json)
  const normalized = {};
  Object.keys(row).forEach(k => { normalized[k.trim().toLowerCase()] = row[k]; });
  const out = {};
  Object.keys(EMP_HEADER_ALIASES).forEach(field => {
    for (const alias of EMP_HEADER_ALIASES[field]) {
      if (normalized[alias] !== undefined && normalized[alias] !== null && String(normalized[alias]).trim() !== "") {
        out[field] = String(normalized[alias]).trim();
        break;
      }
    }
  });
  return out;
}

document.getElementById("employeeFileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // reset so the same file can be re-selected later
  if (!file) return;
  if (!requireAdminOrWarn()) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const wb = XLSX.read(evt.target.result, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      importEmployeeRows(rows);
    } catch (err) {
      toast("Couldn't read that file — please check the format", "err");
    }
  };
  reader.readAsArrayBuffer(file);
});

function importEmployeeRows(rawRows) {
  if (!rawRows.length) { toast("No rows found in that file", "err"); return; }
  const mapped = rawRows.map(mapRowToEmployee).filter(r => r.name);
  const skipped = rawRows.length - mapped.length;

  let added = 0, updated = 0;
  mapped.forEach(rec => {
    let existing = null;
    if (rec.id) existing = DB.employees.find(e => e.id && e.id.toLowerCase() === rec.id.toLowerCase());
    if (!existing) existing = DB.employees.find(e => e.name.toLowerCase() === rec.name.toLowerCase() && (!rec.department || e.department === rec.department));
    if (existing) {
      Object.assign(existing, {
        id: rec.id || existing.id,
        name: rec.name || existing.name,
        department: rec.department || existing.department,
        email: rec.email || existing.email,
        phone: rec.phone || existing.phone,
      });
      updated++;
    } else {
      DB.employees.push({ uid: uid(), id: rec.id || "", name: rec.name, department: rec.department || "", email: rec.email || "", phone: rec.phone || "" });
      added++;
    }
  });

  saveDB();
  logAction("Imported employees", `${added} added, ${updated} updated, ${skipped} skipped (from uploaded file)`);
  openModal("Import complete", `
    <p style="margin-top:0">✅ <strong>${added}</strong> new employee${added === 1 ? "" : "s"} added.</p>
    ${updated ? `<p>♻️ <strong>${updated}</strong> existing employee${updated === 1 ? "" : "s"} updated (matched by ID or name).</p>` : ""}
    ${skipped ? `<p>⚠️ <strong>${skipped}</strong> row${skipped === 1 ? "" : "s"} skipped (missing a name).</p>` : ""}
    <div class="upload-hint">
      Expected columns (any order, case-insensitive): <code>Employee ID</code>, <code>Employee Name</code>,
      <code>Department</code>, <code>Email</code>, <code>Phone</code>. Extra columns are ignored.
    </div>
    <div class="form-actions"><button class="btn btn-primary" id="closeImport">Done</button></div>
  `, () => { document.getElementById("closeImport").onclick = () => { closeModal(); goto("employees"); }; });
}

/* =========================================================
   EMPLOYEE HISTORY  (per-employee asset usage record)
   ========================================================= */
let empHistFilter = { q: "", dept: "" };

// All assignment records that belong to a given employee — matched by
// Employee ID first (most reliable), falling back to a case-insensitive
// name match so records entered before an ID existed still show up.
function getAssignmentsForEmployee(emp) {
  const nameKey = (emp.name || "").trim().toLowerCase();
  const idKey = (emp.id || "").trim().toLowerCase();
  return DB.assignments
    .filter(a => {
      const aId = (a.employeeId || "").trim().toLowerCase();
      const aName = (a.employeeName || "").trim().toLowerCase();
      if (idKey && aId) return aId === idKey;
      return aName === nameKey;
    })
    .sort((a, b) => assignSortKey(b).localeCompare(assignSortKey(a)));
}

// "Currently assigned" = anything not yet marked Returned (covers
// "Assigned" and "Overdue", and any custom status the sheet may add).
function currentlyHeldCount(records) {
  return records.filter(a => (a.status || "").toLowerCase() !== "returned").length;
}

function renderEmployeeHistory() {
  const content = document.getElementById("content");
  const depts = [...new Set(DB.employees.map(e => e.department).filter(Boolean))].sort();

  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Employee History</h2><div class="sub">Complete asset-usage record for every employee — items ever issued and what's currently with them</div></div>
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="empHistSearch" placeholder="Search name or ID..." /></div>
        <select class="filter-select" id="empHistDeptFilter">
          <option value="">All departments</option>
          ${depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")}
        </select>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Employee ID</th><th>Name</th><th>Department</th>
          <th>Total Assets Issued</th><th>Currently Assigned</th><th>Returned</th><th></th>
        </tr></thead>
        <tbody id="empHistTbody"></tbody>
      </table></div>
    </div>
  `;

  document.getElementById("empHistSearch").oninput = (e) => { empHistFilter.q = e.target.value.toLowerCase(); paintEmpHistTable(); };
  document.getElementById("empHistDeptFilter").onchange = (e) => { empHistFilter.dept = e.target.value; paintEmpHistTable(); };

  paintEmpHistTable();
}

function paintEmpHistTable() {
  const tbody = document.getElementById("empHistTbody");
  if (!tbody) return;

  let rows = [...DB.employees];
  if (empHistFilter.q) rows = rows.filter(e => `${e.id} ${e.name}`.toLowerCase().includes(empHistFilter.q));
  if (empHistFilter.dept) rows = rows.filter(e => e.department === empHistFilter.dept);

  const withCounts = rows.map(e => {
    const records = getAssignmentsForEmployee(e);
    const current = currentlyHeldCount(records);
    return { emp: e, records, total: records.length, current, returned: records.length - current };
  }).sort((a, b) => b.total - a.total);

  tbody.innerHTML = withCounts.length ? withCounts.map(({ emp, total, current, returned }) => `
    <tr>
      <td>${escapeHtml(emp.id || "—")}</td>
      <td>${escapeHtml(emp.name)}</td>
      <td>${escapeHtml(emp.department || "—")}</td>
      <td>${total}</td>
      <td>${current > 0 ? `<span class="badge badge-blue">${current}</span>` : `<span class="badge badge-grey">0</span>`}</td>
      <td>${returned}</td>
      <td><button class="btn btn-secondary btn-sm" onclick="openEmpHistoryModal('${emp.uid}')">View Record</button></td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="7">No employees found</td></tr>`;
}

function openEmpHistoryModal(empUid) {
  const emp = DB.employees.find(e => e.uid === empUid);
  if (!emp) return;
  const records = getAssignmentsForEmployee(emp);
  const current = currentlyHeldCount(records);

  openModal(`${emp.name} — Full Record`, `
    <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:16px;">
      <div class="muted">Employee ID: <strong>${escapeHtml(emp.id || "—")}</strong></div>
      <div class="muted">Department: <strong>${escapeHtml(emp.department || "—")}</strong></div>
      <div class="muted">Total Assets Issued: <strong>${records.length}</strong></div>
      <div class="muted">Currently Assigned: <strong>${current}</strong></div>
    </div>
    <div class="table-wrap">
      <table style="min-width:640px">
        <thead><tr><th>Date</th><th>Asset</th><th>Status</th><th>Assigned By</th><th>Return Date</th><th>Remarks</th></tr></thead>
        <tbody>
          ${records.length ? records.map(a => `
            <tr>
              <td>${fmtAssignDateCell(a)}</td>
              <td>${escapeHtml(a.assetName)}</td>
              <td>${statusBadge(a.status)}</td>
              <td>${escapeHtml(a.assignedBy || "—")}</td>
              <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}</td>
              <td>${escapeHtml(a.remarks || "—")}</td>
            </tr>`).join("") : `<tr class="empty-row"><td colspan="6">No assets have been issued to this employee yet</td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="closeEmpHist">Close</button>
    </div>
  `, () => {
    document.getElementById("modal").classList.add("modal-wide");
    document.getElementById("closeEmpHist").onclick = closeModal;
  });
}

/* =========================================================
   STOCK SUMMARY
   ========================================================= */
function renderStock() {
  const content = document.getElementById("content");
  const rows = computeStockSummary();
  const admin = isAdmin();
  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Stock Summary</h2><div class="sub">Auto-calculated from Asset Assignment + Stock Refill Log. Repair / Faulty / Lost / Scrap and Threshold are editable${admin ? "" : " (Admin only)"}.</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Category</th><th>Total Stock</th><th>Assigned</th><th>Under Repair</th><th>Faulty</th>
          <th>Lost</th><th>Scrap</th><th>Available</th><th>Threshold</th><th>Alert</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><strong>${escapeHtml(r.category)}</strong></td>
              <td>${r.total}</td>
              <td>${r.assigned}</td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="underRepair" value="${r.underRepair}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="faulty" value="${r.faulty}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="lost" value="${r.lost}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="scrap" value="${r.scrap}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><strong style="color:${r.available <= 0 ? 'var(--red)' : 'var(--text)'}">${r.available}</strong></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="threshold" value="${r.threshold}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td>${statusBadge(r.low ? "⚠ Low Stock" : "OK")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table></div>
    </div>
  `;
  if (admin) {
    document.querySelectorAll(".stock-edit").forEach(inp => {
      inp.onchange = () => {
        const cat = inp.dataset.cat, field = inp.dataset.field;
        if (!DB.stockManual[cat]) DB.stockManual[cat] = { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5 };
        DB.stockManual[cat][field] = Number(inp.value) || 0;
        saveDB();
        logAction("Edited stock summary", `${cat} — ${field} set to ${DB.stockManual[cat][field]}`);
        renderStock();
      };
    });
  }
}

/* =========================================================
   STOCK REFILL LOG
   ========================================================= */
let refillSelected = new Set();

function renderRefill() {
  refillSelected = new Set();
  const content = document.getElementById("content");
  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Stock Refill Log</h2><div class="sub">Every entry here increases "Total Stock" on the Stock Summary page</div></div>
        ${isAdmin() ? `<button class="btn btn-primary" id="addRefillBtn">+ Log Refill</button>` : ""}
      </div>
      <div class="toolbar"><div id="refillBulkBar" style="margin-left:auto"></div></div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? `<th class="ck-col"><input type="checkbox" class="select-ck" id="refillSelectAll"></th>` : ""}
          <th>Date</th><th>Category</th><th>Quantity Added</th><th>Added By</th><th>Source / Remarks</th>${isAdmin() ? "<th></th>" : ""}
        </tr></thead>
        <tbody id="refillTbody"></tbody>
      </table></div>
    </div>
  `;
  if (isAdmin()) document.getElementById("addRefillBtn").onclick = () => openRefillForm();
  paintRefillTable();
}

function paintRefillTable() {
  const tbody = document.getElementById("refillTbody");
  if (!tbody) return;
  const rows = [...DB.refills].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const admin = isAdmin();

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      ${admin ? `<td class="ck-col"><input type="checkbox" class="select-ck row-ck" data-uid="${r.uid}" ${refillSelected.has(r.uid) ? "checked" : ""}></td>` : ""}
      <td>${fmtDate(r.date)}</td>
      <td>${escapeHtml(r.category)}</td>
      <td><strong>+${r.quantity}</strong></td>
      <td>${escapeHtml(r.addedBy || "—")}</td>
      <td>${escapeHtml(r.source || "—")}</td>
      ${admin ? `<td>
        <div class="row-actions">
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteRefill('${r.uid}')">🗑️</button>
        </div>
      </td>` : ""}
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="6">No refill entries yet</td></tr>`;

  document.getElementById("refillBulkBar").innerHTML = bulkToolbarHtml(refillSelected.size, rows.length);
  wireRefillBulk(rows);
}

function wireRefillBulk(rows) {
  if (!isAdmin()) return;
  const selectAll = document.getElementById("refillSelectAll");
  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => refillSelected.has(r.uid));
    selectAll.onchange = (e) => {
      rows.forEach(r => e.target.checked ? refillSelected.add(r.uid) : refillSelected.delete(r.uid));
      paintRefillTable();
    };
  }
  document.querySelectorAll("#refillTbody .row-ck").forEach(ck => {
    ck.onchange = () => {
      ck.checked ? refillSelected.add(ck.dataset.uid) : refillSelected.delete(ck.dataset.uid);
      document.getElementById("refillBulkBar").innerHTML = bulkToolbarHtml(refillSelected.size, rows.length);
      wireRefillBulk(rows);
    };
  });
  const delSel = document.getElementById("deleteSelectedBtn");
  if (delSel) delSel.onclick = () => {
    if (!requireAdminOrWarn() || refillSelected.size === 0) return;
    confirmBulkDelete(refillSelected.size, "refill entries", () => {
      const n = refillSelected.size;
      DB.refills = DB.refills.filter(r => !refillSelected.has(r.uid));
      refillSelected = new Set();
      saveDB(); logAction("Bulk deleted refill entries", `Deleted ${n} selected entr${n === 1 ? "y" : "ies"}`); toast("Selected entries deleted"); paintRefillTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "refill entries", () => {
      const n = DB.refills.length;
      DB.refills = [];
      refillSelected = new Set();
      saveDB(); logAction("Bulk deleted refill entries", `Deleted all ${n} refill log entries`); toast("All refill entries deleted"); paintRefillTable();
    });
  };
}

function openRefillForm() {
  if (!requireAdminOrWarn()) return;
  const cats = DB.categories.map(c => c.name);
  openModal("Log Stock Refill", `
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" id="f_date" value="${todayISO()}"></div>
      <div class="field"><label>Category</label><select id="f_cat">${cats.map(c => `<option>${escapeHtml(c)}</option>`).join("")}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Quantity Added</label><input type="number" min="1" id="f_qty" value="1"></div>
      <div class="field"><label>Added By</label><input type="text" id="f_by"></div>
    </div>
    <div class="field"><label>Source / Remarks</label><input type="text" id="f_source"></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Add Entry</button>
    </div>
  `, () => {
    document.getElementById("cancelBtn").onclick = closeModal;
    document.getElementById("saveBtn").onclick = () => {
      const qty = Number(document.getElementById("f_qty").value);
      if (!qty || qty <= 0) { toast("Enter a valid quantity", "err"); return; }
      const category = document.getElementById("f_cat").value;
      DB.refills.push({
        uid: uid(), id: DB.refills.length + 1,
        date: document.getElementById("f_date").value,
        category,
        quantity: qty,
        addedBy: document.getElementById("f_by").value.trim(),
        source: document.getElementById("f_source").value.trim(),
      });
      saveDB(); logAction("Logged stock refill", `+${qty} ${category}`); closeModal(); toast("Refill logged"); paintRefillTable();
    };
  });
}

function deleteRefill(uidVal) {
  if (!requireAdminOrWarn()) return;
  const rec = DB.refills.find(r => r.uid === uidVal);
  openModal("Delete refill entry?", `
    <p class="muted" style="margin-top:0">This will reduce Total Stock for that category.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.refills = DB.refills.filter(r => r.uid !== uidVal);
      refillSelected.delete(uidVal);
      saveDB(); logAction("Deleted refill entry", rec ? `-${rec.quantity} ${rec.category}` : uidVal); closeModal(); toast("Refill entry deleted"); paintRefillTable();
    };
  });
}

/* =========================================================
   ASSET CATEGORIES
   ========================================================= */
let catSelected = new Set();

function renderCategories() {
  catSelected = new Set();
  const content = document.getElementById("content");
  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Asset Categories</h2><div class="sub">Categories power dropdowns across Assignment, Inventory and Stock Summary</div></div>
        ${isAdmin() ? `<button class="btn btn-primary" id="addCatBtn">+ Add Category</button>` : ""}
      </div>
      <div class="toolbar"><div id="catBulkBar" style="margin-left:auto"></div></div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? `<th class="ck-col"><input type="checkbox" class="select-ck" id="catSelectAll"></th>` : ""}
          <th>Category</th><th>Description / Notes</th>${isAdmin() ? "<th></th>" : ""}
        </tr></thead>
        <tbody id="catTbody"></tbody>
      </table></div>
    </div>
  `;
  if (isAdmin()) document.getElementById("addCatBtn").onclick = () => openCatForm();
  paintCatTable();
}

function paintCatTable() {
  const tbody = document.getElementById("catTbody");
  if (!tbody) return;
  const rows = DB.categories;
  const admin = isAdmin();

  tbody.innerHTML = rows.length ? rows.map(c => `
    <tr>
      ${admin ? `<td class="ck-col"><input type="checkbox" class="select-ck row-ck" data-uid="${c.uid}" ${catSelected.has(c.uid) ? "checked" : ""}></td>` : ""}
      <td><strong>${escapeHtml(c.name)}</strong></td>
      <td>${escapeHtml(c.notes || "—")}</td>
      ${admin ? `<td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openCatForm('${c.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCat('${c.uid}')">🗑️</button>
        </div>
      </td>` : ""}
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="3">No categories yet</td></tr>`;

  document.getElementById("catBulkBar").innerHTML = bulkToolbarHtml(catSelected.size, rows.length);
  wireCatBulk(rows);
}

function wireCatBulk(rows) {
  if (!isAdmin()) return;
  const selectAll = document.getElementById("catSelectAll");
  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => catSelected.has(r.uid));
    selectAll.onchange = (e) => {
      rows.forEach(r => e.target.checked ? catSelected.add(r.uid) : catSelected.delete(r.uid));
      paintCatTable();
    };
  }
  document.querySelectorAll("#catTbody .row-ck").forEach(ck => {
    ck.onchange = () => {
      ck.checked ? catSelected.add(ck.dataset.uid) : catSelected.delete(ck.dataset.uid);
      document.getElementById("catBulkBar").innerHTML = bulkToolbarHtml(catSelected.size, rows.length);
      wireCatBulk(rows);
    };
  });
  const delSel = document.getElementById("deleteSelectedBtn");
  if (delSel) delSel.onclick = () => {
    if (!requireAdminOrWarn() || catSelected.size === 0) return;
    confirmBulkDelete(catSelected.size, "categories", () => {
      const n = catSelected.size;
      DB.categories = DB.categories.filter(c => !catSelected.has(c.uid));
      catSelected = new Set();
      saveDB(); logAction("Bulk deleted categories", `Deleted ${n} selected categor${n === 1 ? "y" : "ies"}`); toast("Selected categories deleted"); paintCatTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "categories", () => {
      const n = DB.categories.length;
      DB.categories = [];
      catSelected = new Set();
      saveDB(); logAction("Bulk deleted categories", `Deleted all ${n} categories`); toast("All categories deleted"); paintCatTable();
    });
  };
}

function openCatForm(uidVal) {
  if (!requireAdminOrWarn()) return;
  const editing = uidVal ? DB.categories.find(c => c.uid === uidVal) : null;
  openModal(editing ? "Edit Category" : "Add Category", `
    <div class="field"><label>Category Name</label><input type="text" id="f_name" value="${escapeHtml(editing ? editing.name : "")}"></div>
    <div class="field"><label>Description / Notes</label><textarea id="f_notes" rows="2">${escapeHtml(editing ? editing.notes || "" : "")}</textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">${editing ? "Save Changes" : "Add Category"}</button>
    </div>
  `, () => {
    document.getElementById("cancelBtn").onclick = closeModal;
    document.getElementById("saveBtn").onclick = () => {
      const name = document.getElementById("f_name").value.trim();
      if (!name) { toast("Category name is required", "err"); return; }
      if (editing) {
        const oldName = editing.name;
        editing.name = name;
        editing.notes = document.getElementById("f_notes").value.trim();
        if (oldName !== name) {
          DB.assignments.forEach(a => { if (a.assetName === oldName) a.assetName = name; });
          DB.refills.forEach(r => { if (r.category === oldName) r.category = name; });
          if (DB.stockManual[oldName]) { DB.stockManual[name] = DB.stockManual[oldName]; delete DB.stockManual[oldName]; }
        }
        logAction("Edited category", oldName !== name ? `Renamed "${oldName}" → "${name}"` : name);
        toast("Category updated");
      } else {
        DB.categories.push({ uid: uid(), name, notes: document.getElementById("f_notes").value.trim() });
        DB.stockManual[name] = { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5 };
        logAction("Added category", name);
        toast("Category added");
      }
      saveDB(); closeModal(); paintCatTable();
    };
  });
}

function deleteCat(uidVal) {
  if (!requireAdminOrWarn()) return;
  const rec = DB.categories.find(c => c.uid === uidVal);
  openModal("Delete category?", `
    <p class="muted" style="margin-top:0">Existing assignments and refill entries referencing it will keep their history but stop appearing in dropdowns.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.categories = DB.categories.filter(c => c.uid !== uidVal);
      catSelected.delete(uidVal);
      saveDB(); logAction("Deleted category", rec ? rec.name : uidVal); closeModal(); toast("Category deleted"); paintCatTable();
    };
  });
}

/* =========================================================
   ACTIVITY LOG — per-office audit trail (who did what, when)
   ========================================================= */
let activityLogCache = [];
let activityLogFilter = { q: "", user: "" };

function renderActivityLog() {
  const content = document.getElementById("content");
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "this office";
  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h2>Activity Log</h2><div class="sub">Every add, edit, delete and import in <strong>${escapeHtml(officeName)}</strong> — most recent first. Other offices keep their own separate log.</div></div>
        <button class="btn btn-secondary btn-sm" id="logRefreshBtn">↻ Refresh</button>
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="logSearch" placeholder="Search action or details..." /></div>
        <select class="filter-select" id="logUserFilter"><option value="">All users</option></select>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
        <tbody id="logTbody"><tr class="empty-row"><td colspan="4">Loading…</td></tr></tbody>
      </table></div>
    </div>
  `;
  document.getElementById("logSearch").oninput = (e) => { activityLogFilter.q = e.target.value.toLowerCase(); paintLogTable(); };
  document.getElementById("logUserFilter").onchange = (e) => { activityLogFilter.user = e.target.value; paintLogTable(); };
  document.getElementById("logRefreshBtn").onclick = loadActivityLog;
  loadActivityLog();
}

async function loadActivityLog() {
  if (!fdb || !currentOfficeId) return;
  const tbody = document.getElementById("logTbody");
  if (tbody) tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Loading…</td></tr>`;
  try {
    const snap = await logsCollRef().orderBy("ts", "desc").limit(500).get();
    activityLogCache = [];
    snap.forEach(doc => activityLogCache.push(doc.data()));

    const userSel = document.getElementById("logUserFilter");
    if (userSel) {
      const users = [...new Set(activityLogCache.map(l => l.email).filter(Boolean))].sort();
      userSel.innerHTML = `<option value="">All users</option>${users.map(u => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("")}`;
      userSel.value = activityLogFilter.user;
    }
    paintLogTable();
  } catch (err) {
    console.error(err);
    if (tbody) tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Couldn't load the activity log — check your Firestore Rules cover the "logs" subcollection.</td></tr>`;
  }
}

function paintLogTable() {
  const tbody = document.getElementById("logTbody");
  if (!tbody) return;
  let rows = [...activityLogCache];
  if (activityLogFilter.user) rows = rows.filter(l => l.email === activityLogFilter.user);
  if (activityLogFilter.q) {
    rows = rows.filter(l => `${l.action || ""} ${l.details || ""}`.toLowerCase().includes(activityLogFilter.q));
  }
  tbody.innerHTML = rows.length ? rows.map(l => `
    <tr>
      <td style="white-space:nowrap;">${fmtDateTime(l.ts)}</td>
      <td>${escapeHtml(l.email || "—")}</td>
      <td><strong>${escapeHtml(l.action || "—")}</strong></td>
      <td>${escapeHtml(l.details || "—")}</td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="4">No activity recorded yet for this office.</td></tr>`;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (isNaN(dt)) return iso;
  return dt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* =========================================================
   SETTINGS — manage dropdown lists
   ========================================================= */
function renderSettings() {
  const content = document.getElementById("content");
  const admin = isAdmin();
  const listDefs = [
    { key: "department", label: "Departments" },
    { key: "floor", label: "Floors" },
    { key: "condition", label: "Asset Conditions" },
    { key: "status", label: "Asset Statuses" },
    { key: "assignmentStatus", label: "Assignment Statuses" },
  ];

  content.innerHTML = `
    ${viewerNotice()}
    <div class="card" style="margin-bottom:18px">
      <div class="card-header"><div><h2>Dropdown Lists</h2><div class="sub">These values populate the selectors throughout the app${admin ? "" : " (Admin only to edit)"}</div></div></div>
      <div class="grid-2" id="listsGrid" style="grid-template-columns:1fr 1fr"></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="card-header">
        <div><h2>Team Access</h2><div class="sub">Who can sign in, and whether they can edit or just view — applies across every office</div></div>
        ${admin ? `<button class="btn btn-primary btn-sm" id="addRoleBtn">+ Add Person</button>` : ""}
      </div>
      ${admin ? `<div class="table-wrap"><table>
        <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody id="rolesTbody"><tr class="empty-row"><td colspan="3">Loading…</td></tr></tbody>
      </table></div>` : `<p class="muted" style="margin-top:0">Only Admins can view or manage the team access list.</p>`}
    </div>

    <div class="card">
      <div class="card-header"><div><h2>Access</h2><div class="sub">How roles work</div></div></div>
      <p class="muted" style="margin-top:0"><strong>Viewer</strong>: signs in, can browse and search everything, no edits. <strong>Admin</strong>: everything a Viewer can do, plus add / edit / delete / bulk-delete / import / reset. Manage who has which role above, in Team Access.</p>
      <p class="muted">Everything is stored in your Cloud Firestore database and synced live to everyone in the same office. Use <strong>Reset Data</strong> in the sidebar to restore the original sheet contents for everyone at any time.</p>
    </div>
  `;

  const grid = document.getElementById("listsGrid");
  grid.innerHTML = listDefs.map(ld => `
    <div>
      <div class="section-title" style="margin-top:0">${ld.label}</div>
      <div id="chips_${ld.key}"></div>
      ${admin ? `
      <div class="list-editor">
        <input type="text" id="add_${ld.key}" placeholder="Add new ${ld.label.toLowerCase().slice(0,-1)}...">
        <button class="btn btn-secondary btn-sm" data-key="${ld.key}">Add</button>
      </div>` : ""}
    </div>
  `).join("");

  listDefs.forEach(ld => paintChips(ld.key));

  if (admin) {
    grid.querySelectorAll("button[data-key]").forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.key;
        const input = document.getElementById(`add_${key}`);
        const val = input.value.trim();
        if (!val) return;
        if (!DB.lists[key]) DB.lists[key] = [];
        if (DB.lists[key].includes(val)) { toast("Already exists", "err"); return; }
        DB.lists[key].push(val);
        saveDB(); logAction("Added list option", `${key}: "${val}"`); input.value = ""; paintChips(key); toast("Added");
      };
    });

    document.getElementById("addRoleBtn").onclick = () => openRoleForm();
    loadRolesList();
  }
}

/* ---------------- Team Access (Admin/Viewer role management) ---------------- */
async function loadRolesList() {
  const tbody = document.getElementById("rolesTbody");
  if (!tbody) return;
  try {
    const snap = await fdb.collection("roles").get();
    const rows = [];
    snap.forEach(doc => rows.push({ email: doc.id, ...doc.data() }));
    rows.sort((a, b) => (a.email || "").localeCompare(b.email || ""));
    tbody.innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td>${escapeHtml(r.email)}${fauth.currentUser && fauth.currentUser.email === r.email ? ` <span class="muted" style="font-size:11.5px;">(you)</span>` : ""}</td>
        <td><span class="badge ${r.role === "admin" ? "badge-blue" : "badge-grey"}">${r.role === "admin" ? "Admin" : "Viewer"}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-secondary btn-sm btn-icon" title="Change role" onclick="openRoleForm('${escapeHtml(r.email)}','${r.role}')">✏️</button>
            <button class="btn btn-danger btn-sm btn-icon" title="Remove access" onclick="removeRole('${escapeHtml(r.email)}')">🗑️</button>
          </div>
        </td>
      </tr>
    `).join("") : `<tr class="empty-row"><td colspan="3">Nobody's been granted access yet — add someone above (must match a Firebase Authentication login exactly).</td></tr>`;
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load the team list.</td></tr>`;
  }
}

function openRoleForm(existingEmail, existingRole) {
  if (!requireAdminOrWarn()) return;
  const editing = !!existingEmail;
  openModal(editing ? "Change Role" : "Add Person", `
    ${editing ? "" : `<p class="muted" style="margin-top:0">The email must exactly match a login already created in Firebase → Authentication → Users.</p>`}
    <div class="field"><label>Email</label><input type="email" id="f_roleEmail" value="${escapeHtml(existingEmail || "")}" ${editing ? "disabled" : ""} placeholder="person@company.com"></div>
    <div class="field"><label>Role</label>
      <select id="f_role">
        <option value="viewer" ${existingRole === "viewer" ? "selected" : ""}>Viewer — view only</option>
        <option value="admin" ${existingRole === "admin" ? "selected" : ""}>Admin — can edit everything</option>
      </select>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelRole">Cancel</button>
      <button class="btn btn-primary" id="saveRole">${editing ? "Save" : "Grant Access"}</button>
    </div>
  `, () => {
    const emailInp = document.getElementById("f_roleEmail");
    document.getElementById("cancelRole").onclick = closeModal;
    document.getElementById("saveRole").onclick = async () => {
      const email = emailInp.value.trim().toLowerCase();
      const role = document.getElementById("f_role").value;
      if (!email) { toast("Enter an email", "err"); return; }
      try {
        await fdb.collection("roles").doc(email).set({ role, updatedAt: new Date().toISOString() }, { merge: true });
        logAction(editing ? "Changed role" : "Granted access", `${email} → ${role === "admin" ? "Admin" : "Viewer"}`);
        closeModal();
        toast(editing ? "Role updated" : "Access granted");
        loadRolesList();
      } catch (err) {
        console.error(err);
        toast("Couldn't save — check your Firestore Rules", "err");
      }
    };
  });
}

function removeRole(email) {
  if (!requireAdminOrWarn()) return;
  if (fauth.currentUser && fauth.currentUser.email === email) {
    toast("You can't remove your own access from here", "err");
    return;
  }
  openModal("Remove access?", `
    <p class="muted" style="margin-top:0"><strong>${escapeHtml(email)}</strong> will no longer be able to sign in and view or edit any office's data.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelRoleDel">Cancel</button>
      <button class="btn btn-danger" id="confirmRoleDel">Remove</button>
    </div>`, () => {
    document.getElementById("cancelRoleDel").onclick = closeModal;
    document.getElementById("confirmRoleDel").onclick = async () => {
      try {
        await fdb.collection("roles").doc(email).delete();
        logAction("Removed access", email);
        closeModal();
        toast("Access removed");
        loadRolesList();
      } catch (err) {
        console.error(err);
        toast("Couldn't remove — check your Firestore Rules", "err");
      }
    };
  });
}

function paintChips(key) {
  const el = document.getElementById(`chips_${key}`);
  if (!el) return;
  const items = DB.lists[key] || [];
  const admin = isAdmin();
  el.innerHTML = items.length ? items.map(v => `
    <span class="tag-chip">${escapeHtml(v)} ${admin ? `<span style="cursor:pointer;color:var(--red)" onclick="removeListItem('${key}','${encodeURIComponent(v)}')">✕</span>` : ""}</span>
  `).join("") : `<p class="muted" style="font-size:12.5px">No values yet</p>`;
}

function removeListItem(key, encodedVal) {
  if (!requireAdminOrWarn()) return;
  const val = decodeURIComponent(encodedVal);
  DB.lists[key] = (DB.lists[key] || []).filter(v => v !== val);
  saveDB();
  logAction("Removed list option", `${key}: "${val}"`);
  paintChips(key);
  toast("Removed");
}

/* =========================================================
   INIT
   ========================================================= */
function showLoadingScreen() {
  const el = document.getElementById("loadingScreen");
  if (el) el.classList.add("show");
}
function hideLoadingScreen() {
  const el = document.getElementById("loadingScreen");
  if (el) el.classList.remove("show");
}
function hideAllGateScreens() {
  document.getElementById("firebaseSetupScreen")?.classList.remove("show");
  document.getElementById("signInGateScreen")?.classList.remove("show");
  document.getElementById("officeSelectScreen")?.classList.remove("show");
  const shell = document.querySelector(".app-shell");
  if (shell) shell.style.display = "";
}
function showFirebaseSetupScreen(isError) {
  const shell = document.querySelector(".app-shell");
  if (shell) shell.style.display = "none";
  document.getElementById("signInGateScreen")?.classList.remove("show");
  document.getElementById("officeSelectScreen")?.classList.remove("show");
  const el = document.getElementById("firebaseSetupScreen");
  if (el) {
    el.classList.add("show");
    const note = document.getElementById("setupErrorNote");
    if (note) note.style.display = isError ? "block" : "none";
  }
}
function showSignInGate(errorMsg) {
  const shell = document.querySelector(".app-shell");
  if (shell) shell.style.display = "none";
  document.getElementById("firebaseSetupScreen")?.classList.remove("show");
  document.getElementById("officeSelectScreen")?.classList.remove("show");
  const el = document.getElementById("signInGateScreen");
  if (el) el.classList.add("show");
  const note = document.getElementById("gateErrorNote");
  if (note) {
    if (errorMsg) { note.textContent = errorMsg; note.style.display = "block"; }
    else { note.style.display = "none"; }
  }
}

/* ---------------- Office select screen ---------------- */
function renderOfficeCards() {
  const grid = document.getElementById("officeGrid");
  if (!grid) return;
  const admin = isAdmin();
  if (!OFFICES.length) {
    grid.innerHTML = `<div class="office-empty-note">No offices yet${admin ? " — add one to get started." : ". Ask an Admin to create one."}</div>`;
    return;
  }
  grid.innerHTML = OFFICES.map(o => `
    <div class="office-card" data-id="${escapeHtml(o.id)}">
      ${admin ? `<div class="office-card-actions">
        <button class="office-card-edit" data-id="${escapeHtml(o.id)}" title="Rename office">✎</button>
        ${OFFICES.length > 1 ? `<button class="office-card-del" data-id="${escapeHtml(o.id)}" title="Delete office">✕</button>` : ""}
      </div>` : ""}
      <div class="office-card-icon">🏢</div>
      <div class="office-card-name">${escapeHtml(o.name)}</div>
      <div class="office-card-city">${escapeHtml(o.city || "—")}</div>
    </div>
  `).join("");
  const addBtn = document.getElementById("addOfficeBtn");
  if (addBtn) addBtn.style.display = admin ? "" : "none";
}
async function openOffice(officeId) {
  currentOfficeId = officeId;
  localStorage.setItem(LAST_OFFICE_KEY, officeId);
  hideAllGateScreens();
  showLoadingScreen();
  try {
    await loadInitialData();
    attachRealtimeListener();
    dataBootstrapped = true;
  } catch (err) {
    console.error(err);
    hideLoadingScreen();
    showFirebaseSetupScreen(true);
    return;
  }
  hideLoadingScreen();
  paintOfficeUI();
  logAction("Opened office", `Signed in and opened this office's data`);
  goto(currentPage);
}
async function showOfficeSelectScreen() {
  detachRealtimeListener();
  DB = null;
  dataBootstrapped = false;
  currentOfficeId = null;
  localStorage.removeItem(LAST_OFFICE_KEY);
  const shell = document.querySelector(".app-shell");
  if (shell) shell.style.display = "none";
  document.getElementById("firebaseSetupScreen")?.classList.remove("show");
  document.getElementById("signInGateScreen")?.classList.remove("show");
  showLoadingScreen();
  try {
    await loadOfficesList();
  } catch (err) {
    console.error(err);
    hideLoadingScreen();
    showFirebaseSetupScreen(true);
    return;
  }
  hideLoadingScreen();
  renderOfficeCards();
  document.getElementById("officeSelectScreen")?.classList.add("show");
}
function paintOfficeUI() {
  const badge = document.getElementById("officeBadge");
  if (!badge) return;
  const o = OFFICES.find(o => o.id === currentOfficeId);
  badge.textContent = o ? `${o.name}${o.city ? " · " + o.city : ""}` : "—";
}
document.getElementById("officeGrid").addEventListener("click", (e) => {
  const editBtn = e.target.closest(".office-card-edit");
  if (editBtn) {
    e.stopPropagation();
    if (!requireAdminOrWarn()) return;
    const office = OFFICES.find(o => o.id === editBtn.dataset.id);
    if (!office) return;
    openModal("Rename Office", `
      <div class="field"><label>Office Name</label><input type="text" id="f_editOfficeName" value="${escapeHtml(office.name)}"></div>
      <div class="field"><label>City</label><input type="text" id="f_editOfficeCity" value="${escapeHtml(office.city || "")}"></div>
      <div class="form-actions">
        <button class="btn btn-secondary" id="cancelEditOffice">Cancel</button>
        <button class="btn btn-primary" id="confirmEditOffice">Save</button>
      </div>
    `, () => {
      const nameInp = document.getElementById("f_editOfficeName");
      const cityInp = document.getElementById("f_editOfficeCity");
      nameInp.focus();
      nameInp.select();
      const attempt = async () => {
        const name = nameInp.value.trim();
        const city = cityInp.value.trim();
        if (!name) { toast("Enter an office name", "err"); return; }
        await renameOffice(office.id, name, city);
        closeModal();
        toast("Office updated");
        renderOfficeCards();
        if (office.id === currentOfficeId) paintOfficeUI();
      };
      document.getElementById("cancelEditOffice").onclick = closeModal;
      document.getElementById("confirmEditOffice").onclick = attempt;
      [nameInp, cityInp].forEach(inp => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); }));
    });
    return;
  }
  const delBtn = e.target.closest(".office-card-del");
  if (delBtn) {
    e.stopPropagation();
    if (!requireAdminOrWarn()) return;
    const office = OFFICES.find(o => o.id === delBtn.dataset.id);
    openModal(`Delete "${office ? office.name : "this office"}"?`, `
      <p class="muted" style="margin-top:0">This permanently deletes <strong>all data</strong> for this office
      (employees, assignments, stock, everything). This can't be undone.</p>
      <div class="form-actions">
        <button class="btn btn-secondary" id="cancelDelOffice">Cancel</button>
        <button class="btn btn-danger" id="confirmDelOffice">Delete Office</button>
      </div>
    `, () => {
      document.getElementById("cancelDelOffice").onclick = closeModal;
      document.getElementById("confirmDelOffice").onclick = async () => {
        await deleteOffice(delBtn.dataset.id);
        closeModal();
        toast("Office deleted");
        renderOfficeCards();
      };
    });
    return;
  }
  const card = e.target.closest(".office-card");
  if (card) openOffice(card.dataset.id);
});
document.getElementById("addOfficeBtn").addEventListener("click", () => {
  if (!requireAdminOrWarn()) return;
  openModal("Add New Office", `
    <div class="field"><label>Office Name</label><input type="text" id="f_officeName" placeholder="e.g. Andheri Branch"></div>
    <div class="field"><label>City</label><input type="text" id="f_officeCity" placeholder="e.g. Mumbai"></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelOffice">Cancel</button>
      <button class="btn btn-primary" id="confirmOffice">Add Office</button>
    </div>
  `, () => {
    const nameInp = document.getElementById("f_officeName");
    const cityInp = document.getElementById("f_officeCity");
    nameInp.focus();
    const attempt = async () => {
      const name = nameInp.value.trim();
      const city = cityInp.value.trim();
      if (!name) { toast("Enter an office name", "err"); return; }
      const id = await createOffice(name, city);
      closeModal();
      toast(`"${name}" added`);
      renderOfficeCards();
    };
    document.getElementById("cancelOffice").onclick = closeModal;
    document.getElementById("confirmOffice").onclick = attempt;
    [nameInp, cityInp].forEach(inp => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); }));
  });
});
document.getElementById("switchOfficeBtn").addEventListener("click", () => {
  showOfficeSelectScreen();
});

function attemptGateSignIn() {
  if (!fauth) return;
  const emailInp = document.getElementById("gate_email");
  const pwInp = document.getElementById("gate_pw");
  const email = emailInp.value.trim();
  const pw = pwInp.value;
  if (!email || !pw) { showSignInGate("Enter your email and password."); return; }
  fauth.signInWithEmailAndPassword(email, pw).catch(err => {
    showSignInGate(err.message.replace(/^Firebase:\s*/, ""));
  });
  // On success, the onAuthStateChanged listener below handles loading data + showing the app.
}
document.getElementById("gateSignInBtn").addEventListener("click", attemptGateSignIn);
["gate_email", "gate_pw"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") attemptGateSignIn(); });
});

let dataBootstrapped = false; // whether we've successfully loaded Firestore data at least once this session

async function init() {
  if (!firebaseConfigured()) {
    showFirebaseSetupScreen(false);
    return;
  }
  try {
    initFirebase();
  } catch (err) {
    console.error(err);
    showFirebaseSetupScreen(true);
    return;
  }
  showLoadingScreen();

  // This app requires sign-in to view OR edit anything (private data). This single
  // listener is the source of truth for every state change: signed out -> gate,
  // signed in -> load data once, then keep the app in sync.
  fauth.onAuthStateChanged(async (user) => {
    if (!user) {
      currentUserRole = null;
      paintRoleUI();
      detachRealtimeListener();
      DB = null;
      dataBootstrapped = false;
      currentOfficeId = null;
      hideLoadingScreen();
      showSignInGate();
      return;
    }

    await fetchUserRole();
    paintRoleUI();

    // Signed in but no office chosen yet this session — try to resume the
    // last office used on this device (so refreshing stays put); only fall
    // back to the picker if there's no saved office or it no longer exists.
    if (!currentOfficeId) {
      showLoadingScreen();
      try {
        await loadOfficesList();
      } catch (err) {
        console.error(err);
        hideLoadingScreen();
        showFirebaseSetupScreen(true);
        return;
      }
      const savedOfficeId = localStorage.getItem(LAST_OFFICE_KEY);
      if (savedOfficeId && OFFICES.some(o => o.id === savedOfficeId)) {
        await openOffice(savedOfficeId);
        return;
      }
      hideLoadingScreen();
      renderOfficeCards();
      document.getElementById("officeSelectScreen")?.classList.add("show");
      return;
    }

    hideAllGateScreens();
    if (!dataBootstrapped) {
      showLoadingScreen();
      try {
        await loadInitialData();
        attachRealtimeListener();
        dataBootstrapped = true;
      } catch (err) {
        console.error(err);
        hideLoadingScreen();
        showFirebaseSetupScreen(true);
        return;
      }
    }
    hideLoadingScreen();
    paintOfficeUI();
    goto(currentPage);
  });
}
document.addEventListener("DOMContentLoaded", init);

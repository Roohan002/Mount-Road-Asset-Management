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

/* ---------------- Per-record collections (concurrency-safe) ---------------- */
// Employees, Assignments, Inventory, Refill Log entries and Categories each
// live as their OWN Firestore document inside the office, instead of one
// shared blob. Two admins editing DIFFERENT records at the same time can
// no longer overwrite each other's work — only two edits to the exact same
// record at the exact same instant fall back to last-write-wins, same as
// any normal database. Dropdown Lists and Stock Summary's manual fields
// (repair/faulty/lost/scrap/threshold) still live together in the small
// office "meta" document — they change far less often, by fewer people,
// so the collision risk there is much lower.
function employeesColl() { return docRef().collection("employees"); }
function assignmentsColl() { return docRef().collection("assignments"); }
function inventoryColl() { return docRef().collection("inventory"); }
function refillsColl() { return docRef().collection("refills"); }
function categoriesColl() { return docRef().collection("categories"); }
function collFor(kind) {
  return { employees: employeesColl, assignments: assignmentsColl, inventory: inventoryColl, refills: refillsColl, categories: categoriesColl }[kind]();
}

function saveRecord(kind, record) {
  if (!fdb || !record || !record.uid) return;
  collFor(kind).doc(record.uid).set(record).catch(err => {
    console.error(err);
    toast("Couldn't save to the cloud — check your connection or admin access", "err");
  });
}
function deleteRecord(kind, uidVal) {
  if (!fdb || !uidVal) return;
  collFor(kind).doc(uidVal).delete().catch(err => {
    console.error(err);
    toast("Couldn't delete — check your connection or admin access", "err");
  });
}
// Bulk save/delete in one go, chunked under Firestore's 500-writes-per-batch cap.
async function batchWrite(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = fdb.batch();
    ops.slice(i, i + 400).forEach(op => {
      const ref = collFor(op.kind).doc(op.type === "delete" ? op.uid : op.record.uid);
      if (op.type === "delete") batch.delete(ref);
      else batch.set(ref, op.record);
    });
    await batch.commit();
  }
}
// The small office document — just settings that change rarely and are edited
// by whoever's in Settings at the time (Dropdown Lists + Stock Summary manual counts).
function saveMeta() {
  if (!fdb) return;
  docRef().set({ lists: DB.lists, stockManual: DB.stockManual }, { merge: true }).catch(err => {
    console.error(err);
    toast("Couldn't save to the cloud — check your connection or admin access", "err");
  });
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
async function resetOfficeData(toOriginalSheet) {
  const deleteOps = [];
  ["employees", "categories", "assignments", "refills", "inventory"].forEach(kind => {
    (DB[kind] || []).forEach(r => deleteOps.push({ kind, type: "delete", uid: r.uid }));
  });
  if (deleteOps.length) await batchWrite(deleteOps);

  if (toOriginalSheet) {
    const seed = seedFromSource();
    await docRef().set({ lists: seed.lists, stockManual: seed.stockManual });
    await batchWrite([
      ...seed.employees.map(r => ({ kind: "employees", type: "set", record: r })),
      ...seed.categories.map(r => ({ kind: "categories", type: "set", record: r })),
      ...seed.assignments.map(r => ({ kind: "assignments", type: "set", record: r })),
      ...seed.refills.map(r => ({ kind: "refills", type: "set", record: r })),
    ]);
  } else {
    const empty = emptyOfficeDB();
    await docRef().set({ lists: empty.lists, stockManual: empty.stockManual });
  }
  await loadInitialData();
}
async function createOffice(name, city) {
  const id = uniqueOfficeId(slugify(name));
  OFFICES.push({ id, name: name.trim(), city: (city || "").trim() });
  await saveOfficesList();
  const empty = emptyOfficeDB();
  await fdb.collection(FIRESTORE_COLLECTION).doc(id).set({ lists: empty.lists, stockManual: empty.stockManual });
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
  // Firestore doesn't cascade-delete subcollections when a document is deleted,
  // so clear each one out first or the records would be orphaned but still stored.
  const ref = fdb.collection(FIRESTORE_COLLECTION).doc(id);
  for (const sub of ["employees", "categories", "assignments", "refills", "inventory", "logs"]) {
    try {
      const snap = await ref.collection(sub).get();
      const ids = [];
      snap.forEach(d => ids.push(d.id));
      for (let i = 0; i < ids.length; i += 400) {
        const batch = fdb.batch();
        ids.slice(i, i + 400).forEach(docId => batch.delete(ref.collection(sub).doc(docId)));
        await batch.commit();
      }
    } catch (err) { console.error(`Couldn't clear ${sub} while deleting office:`, err); }
  }
  await ref.delete().catch(() => {});
}
async function renameOffice(id, name, city) {
  const o = OFFICES.find(o => o.id === id);
  if (!o) return;
  o.name = name.trim();
  o.city = (city || "").trim();
  await saveOfficesList();
}

/* ---------------- Role management (Admin vs Viewer) ---------------- */
// Signed in = can view (read-only) by default. Two levels of edit access:
//   - Super Admin: roles/{their email} = {role:"admin"} — can edit every
//     office, plus manage the office directory and grant per-office access.
//   - Office Admin: assetTracker/{officeId}/access/{their email} = {role:"admin"}
//     — can edit ONLY that specific office.
// Both are looked up fresh after sign-in / after opening an office. Actual
// write protection is enforced server-side by Firestore Security Rules (see
// firestore.rules) — not just this UI, so a Viewer genuinely cannot write
// even by inspecting the page.
let isSuperAdminUser = false;   // global, from roles/{email}
let currentOfficeRole = null;   // "admin" | "viewer" | null — from this office's access/{email}
let officeRoleMap = {};         // officeId -> "admin"|"viewer", for badges on the office picker

async function fetchGlobalRole() {
  if (!fauth || !fauth.currentUser) { isSuperAdminUser = false; return; }
  try {
    const snap = await fdb.collection("roles").doc(fauth.currentUser.email).get();
    isSuperAdminUser = !!(snap.exists && snap.data().role === "admin");
  } catch (err) {
    console.error("Couldn't look up global role, defaulting to non-admin:", err);
    isSuperAdminUser = false;
  }
}

async function fetchOfficeRole() {
  currentOfficeRole = null;
  if (!fauth || !fauth.currentUser || !currentOfficeId) return;
  if (isSuperAdminUser) { currentOfficeRole = "admin"; return; }
  try {
    const snap = await docRef().collection("access").doc(fauth.currentUser.email).get();
    currentOfficeRole = snap.exists ? (snap.data().role === "admin" ? "admin" : "viewer") : "viewer";
  } catch (err) {
    console.error("Couldn't look up office role, defaulting to Viewer:", err);
    currentOfficeRole = "viewer";
  }
}

// Every office is still visible to everyone signed in (view access stays simple and
// open, so nobody loses the ability to browse an office they could see before).
// This just figures out which offices each person can EDIT, so the office picker
// can badge each one "Admin" or "Viewer" and the app can enforce it once opened.
async function fetchAccessibleOffices() {
  officeRoleMap = {};
  if (isSuperAdminUser || !fauth || !fauth.currentUser) return;
  try {
    const snap = await fdb.collectionGroup("access").where("email", "==", fauth.currentUser.email).get();
    snap.forEach(doc => {
      const officeId = doc.ref.parent.parent.id;
      officeRoleMap[officeId] = doc.data().role === "admin" ? "admin" : "viewer";
    });
  } catch (err) {
    console.error("Couldn't look up accessible offices:", err);
  }
}

function isAdmin() {
  return !!(fauth && fauth.currentUser) && (isSuperAdminUser || currentOfficeRole === "admin");
}
function isSuperAdmin() {
  return !!(fauth && fauth.currentUser) && isSuperAdminUser;
}
function paintRoleUI() {
  const badge = document.getElementById("roleBadge");
  const btn = document.getElementById("roleSwitchBtn");
  const emailLbl = document.getElementById("roleEmailLabel");
  if (!badge || !btn) return;
  const signedIn = !!(fauth && fauth.currentUser);
  const admin = isAdmin();
  badge.textContent = !signedIn ? "Signed out" : (isSuperAdminUser ? "Super Admin" : (admin ? "Admin" : "Viewer"));
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
  return `<div class="viewer-note">👁️ You're signed in as a <strong>Viewer</strong> for this office — read-only. Ask an Admin to grant you edit access.</div>`;
}

/* ---------------- Persistence (Cloud Firestore) ---------------- */
function seedFromSource() {
  const d = JSON.parse(JSON.stringify(SEED_DATA));
  return {
    employees: (d.employees || []).map(e => ({ ...e, uid: uid() })),
    categories: (d.categories || []).map(c => ({ ...c, uid: uid() })),
    lists: d.lists || {},
    assignments: (d.assignments || []).map(a => ({ ...a, uid: uid() })),
    refills: (d.refills || []).map(r => ({ ...r, uid: uid() })),
    inventory: [],
    stockManual: d.stockManual || {},
  };
}

async function loadInitialData() {
  const metaSnap = await docRef().get();
  const meta = metaSnap.exists ? metaSnap.data() : null;

  // One-time migration: older offices stored everything as one big blob
  // (employees/assignments/etc as arrays directly on this document — the
  // exact pattern that made concurrent edits unsafe). If we find that shape,
  // split it into individual per-record documents once, then remove the old
  // array fields so this path is never taken again for this office.
  if (meta && Array.isArray(meta.employees)) {
    if (isAdmin()) {
      await migrateLegacyBlobToRecords(meta);
      return loadInitialData();
    }
    // Not an admin for this office — can't write the conversion. Load the
    // legacy shape directly (read access is open to anyone signed in) so
    // Viewers still see the office fine. An Admin opening it later will
    // complete the one-time conversion automatically.
    DB = {
      lists: meta.lists || JSON.parse(JSON.stringify(SEED_DATA.lists || {})),
      stockManual: meta.stockManual || {},
      employees: meta.employees || [], categories: meta.categories || [],
      assignments: meta.assignments || [], refills: meta.refills || [], inventory: meta.inventory || [],
    };
    return;
  }

  if (!meta) {
    if (currentOfficeId === DEFAULT_OFFICE_ID) {
      // Original single-office data, from before Firestore was even used —
      // seed with the original uploaded sheet contents, one document per record.
      const seed = seedFromSource();
      await docRef().set({ lists: seed.lists, stockManual: seed.stockManual });
      await batchWrite([
        ...seed.employees.map(r => ({ kind: "employees", type: "set", record: r })),
        ...seed.categories.map(r => ({ kind: "categories", type: "set", record: r })),
        ...seed.assignments.map(r => ({ kind: "assignments", type: "set", record: r })),
        ...seed.refills.map(r => ({ kind: "refills", type: "set", record: r })),
      ]);
    } else {
      const empty = emptyOfficeDB();
      await docRef().set({ lists: empty.lists, stockManual: empty.stockManual });
    }
    return loadInitialData();
  }

  DB = {
    lists: meta.lists || JSON.parse(JSON.stringify(SEED_DATA.lists || {})),
    stockManual: meta.stockManual || {},
    employees: [], categories: [], assignments: [], refills: [], inventory: [],
  };
  const [empSnap, catSnap, asgSnap, refSnap, invSnap] = await Promise.all([
    employeesColl().get(), categoriesColl().get(), assignmentsColl().get(), refillsColl().get(), inventoryColl().get(),
  ]);
  empSnap.forEach(d => DB.employees.push(d.data()));
  catSnap.forEach(d => DB.categories.push(d.data()));
  asgSnap.forEach(d => DB.assignments.push(d.data()));
  refSnap.forEach(d => DB.refills.push(d.data()));
  invSnap.forEach(d => DB.inventory.push(d.data()));
}

async function migrateLegacyBlobToRecords(meta) {
  const ops = [];
  (meta.employees || []).forEach(r => ops.push({ kind: "employees", type: "set", record: { ...r, uid: r.uid || uid() } }));
  (meta.categories || []).forEach(r => ops.push({ kind: "categories", type: "set", record: { ...r, uid: r.uid || uid() } }));
  (meta.assignments || []).forEach(r => ops.push({ kind: "assignments", type: "set", record: { ...r, uid: r.uid || uid() } }));
  (meta.refills || []).forEach(r => ops.push({ kind: "refills", type: "set", record: { ...r, uid: r.uid || uid() } }));
  (meta.inventory || []).forEach(r => ops.push({ kind: "inventory", type: "set", record: { ...r, uid: r.uid || uid() } }));
  if (ops.length) await batchWrite(ops);
  await docRef().set({
    lists: meta.lists || {},
    stockManual: meta.stockManual || {},
    employees: firebase.firestore.FieldValue.delete(),
    categories: firebase.firestore.FieldValue.delete(),
    assignments: firebase.firestore.FieldValue.delete(),
    refills: firebase.firestore.FieldValue.delete(),
    inventory: firebase.firestore.FieldValue.delete(),
  }, { merge: true });
}

let unsubscribeFns = [];
function attachRealtimeListener() {
  const colls = { employees: employeesColl, categories: categoriesColl, assignments: assignmentsColl, refills: refillsColl, inventory: inventoryColl };
  Object.entries(colls).forEach(([key, fn]) => {
    unsubscribeFns.push(fn().onSnapshot(snap => {
      const list = [];
      snap.forEach(d => list.push(d.data()));
      DB[key] = list;
      goto(currentPage); // keep every open browser (signed-in users) in sync live
    }, err => console.error(`Firestore listener error (${key}):`, err)));
  });
  unsubscribeFns.push(docRef().onSnapshot(snap => {
    if (!snap.exists) return;
    const data = snap.data();
    if (data.lists) DB.lists = data.lists;
    if (data.stockManual) DB.stockManual = data.stockManual;
    goto(currentPage);
  }, err => console.error("Firestore listener error (meta):", err)));
}
function detachRealtimeListener() {
  unsubscribeFns.forEach(fn => fn());
  unsubscribeFns = [];
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
function requireSuperAdminOrWarn() {
  if (isSuperAdmin()) return true;
  toast("Only Super Admins can do this", "err");
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

/* ---------------- Asset Tag Numbers (per-unit tracking for bulk items) ---------------- */
// Every unit handed out (e.g. each of 10 headphones given to a team) gets its own
// sequential tag like "HEA-0007" so it stays traceable even though the category
// itself is a bulk/non-serialized item. The running counter is per-category and
// lives in DB.stockManual (same small "meta" doc as repair/faulty/lost/scrap), so
// it persists across sessions and never reuses a number.
function categoryTagPrefix(name) {
  const clean = String(name || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return (clean.slice(0, 3) || "AST").padEnd(3, "X");
}
function nextAssetTagNo(categoryName) {
  if (!DB.stockManual[categoryName]) {
    DB.stockManual[categoryName] = { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5, tagSeq: 0 };
  }
  if (!DB.stockManual[categoryName].tagSeq) DB.stockManual[categoryName].tagSeq = 0;
  DB.stockManual[categoryName].tagSeq += 1;
  const seq = String(DB.stockManual[categoryName].tagSeq).padStart(4, "0");
  return `${categoryTagPrefix(categoryName)}-${seq}`;
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
  reports: { title: "Reports", render: renderReports },
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
    const attempt = async () => {
      if (pwInp.value !== RESET_CONFIRM_PASSWORD) {
        document.getElementById("resetPwError").style.display = "block";
        pwInp.focus();
        return;
      }
      document.getElementById("confirmReset").disabled = true;
      try {
        await resetOfficeData(isDefaultOffice);
        logAction("Reset office data", `Reset all data for "${officeName}"`);
        closeModal();
        toast("Data reset for this office");
        goto(currentPage);
      } catch (err) {
        console.error(err);
        toast("Reset failed — check your connection and try again", "err");
        document.getElementById("confirmReset").disabled = false;
      }
    };
    document.getElementById("confirmReset").onclick = attempt;
    pwInp.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  });
});

/* =========================================================
   DASHBOARD CHART HELPERS (pure SVG, no libraries)
   ========================================================= */
const CHART_PALETTE = ["#4c5ef8", "#0fb9a7", "#e2a13b", "#e2513b", "#3b8ee2", "#8a5cf6", "#f2578a", "#22b07d", "#f7a94b", "#5b6172"];
function chartColor(i) { return CHART_PALETTE[i % CHART_PALETTE.length]; }

// Donut chart: data = [{label, value, color}]. Draws each slice as an arc of a
// thick-stroked circle, rotated to its cumulative start angle — no chart library needed.
function svgDonutChart(data, opts = {}) {
  const size = opts.size || 168, stroke = opts.stroke || 22;
  const cx = size / 2, cy = size / 2, r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}"/>
    </svg>`;
  }
  let acc = 0;
  const segs = data.map(d => {
    const frac = d.value / total;
    const dash = Math.max(frac * circ - 1.5, 0.001);
    const rotate = -90 + (acc / total) * 360;
    acc += d.value;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="${stroke}"
      stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-linecap="round"
      transform="rotate(${rotate.toFixed(2)} ${cx} ${cy})"><title>${escapeHtml(d.label)}: ${d.value}</title></circle>`;
  }).join("");
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    ${segs}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="21" font-weight="800" fill="var(--text)">${total}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="var(--text-faint)">${escapeHtml(opts.centerLabel || "Total")}</text>
  </svg>`;
}

function chartLegend(data) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return `<div class="chart-legend">
    ${data.map(d => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${d.color}"></span>
        <span class="legend-label" title="${escapeHtml(d.label)}">${escapeHtml(d.label)}</span>
        <span class="legend-value">${d.value} · ${Math.round(d.value / total * 100)}%</span>
      </div>
    `).join("")}
  </div>`;
}

function categoryStockBreakdown() {
  return computeStockSummary()
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((r, i) => ({ label: r.category, value: r.total, color: chartColor(i) }));
}

function departmentAssignedBreakdown() {
  const map = {};
  DB.assignments.filter(a => a.status === "Assigned").forEach(a => {
    const dept = a.department || "Unassigned";
    map[dept] = (map[dept] || 0) + 1;
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value, color: chartColor(i) }));
}

// Asset Lifecycle Flow: a small Sankey-style diagram — one "Total Stock" node on the
// left flowing out to every status bucket on the right, with line thickness scaled to
// each bucket's share. Shows at a glance where every unit in stock currently sits.
function svgLifecycleFlow(s) {
  const nodesAll = [
    { label: "Assigned", value: s.assigned, color: "#8a5cf6" },
    { label: "Available", value: s.available, color: "#0fb9a7" },
    { label: "Under Repair", value: s.underRepair, color: "#e2a13b" },
    { label: "Faulty", value: s.faulty, color: "#e2513b" },
    { label: "Lost", value: s.lost, color: "#7c8393" },
    { label: "Scrap", value: s.scrap, color: "#4c5ef8" },
  ];
  const nodes = nodesAll.filter(n => n.value > 0);
  if (!s.total || !nodes.length) {
    return `<div class="chart-empty">No stock movement yet — add stock via the Stock Refill Log and log an assignment to see the flow.</div>`;
  }
  const nodeH = 38, gap = 15;
  const height = nodes.length * (nodeH + gap) - gap + 16;
  const width = 640;
  const srcW = 138, srcH = 56, srcX = 12, srcY = height / 2 - srcH / 2;
  const destX = width - 196, destW = 184;
  const maxV = Math.max(...nodes.map(n => n.value), 1);

  let y = 8;
  const rows = nodes.map(n => {
    const cy = y + nodeH / 2;
    const strokeW = Math.max(3, Math.round((n.value / maxV) * 20));
    const srcCy = srcY + srcH / 2;
    const midX = (srcX + srcW + destX) / 2;
    const path = `M ${srcX + srcW} ${srcCy} C ${midX} ${srcCy}, ${midX} ${cy}, ${destX} ${cy}`;
    const pct = Math.round((n.value / s.total) * 100);
    const row = `
      <path d="${path}" fill="none" stroke="${n.color}" stroke-width="${strokeW}" stroke-opacity="0.32" stroke-linecap="round"/>
      <rect x="${destX}" y="${y}" width="${destW}" height="${nodeH}" rx="10" fill="${n.color}" fill-opacity="0.1" stroke="${n.color}" stroke-width="1.4"/>
      <text x="${destX + 14}" y="${y + 16}" font-size="11.5" font-weight="700" fill="var(--text)">${escapeHtml(n.label)}</text>
      <text x="${destX + 14}" y="${y + 31}" font-size="10.5" fill="var(--text-faint)">${n.value} units · ${pct}%</text>
    `;
    y += nodeH + gap;
    return row;
  }).join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    <rect x="${srcX}" y="${srcY}" width="${srcW}" height="${srcH}" rx="12" fill="var(--primary)" fill-opacity="0.12" stroke="var(--primary)" stroke-width="1.6"/>
    <text x="${srcX + srcW / 2}" y="${srcY + 24}" text-anchor="middle" font-size="14" font-weight="800" fill="var(--primary-dark)">${s.total}</text>
    <text x="${srcX + srcW / 2}" y="${srcY + 40}" text-anchor="middle" font-size="10.5" fill="var(--text-faint)">Total Stock</text>
    ${rows}
  </svg>`;
}

// Last 14 days of assignment activity (by Date field), as a smoothed area/line chart.
function last14DaysActivity() {
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, label: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) });
  }
  return days.map(d => ({ ...d, count: DB.assignments.filter(a => a.date === d.iso).length }));
}
function svgTrendChart(points) {
  const w = 620, h = 168, padL = 16, padR = 16, padT = 16, padB = 26;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const total = points.reduce((s, p) => s + p.count, 0);
  const maxV = Math.max(1, ...points.map(p => p.count));
  const stepX = chartW / (points.length - 1 || 1);
  const coords = points.map((p, i) => ({
    ...p,
    x: padL + i * stepX,
    y: padT + chartH - (p.count / maxV) * chartH,
  }));
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(padT + chartH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padT + chartH).toFixed(1)} Z`;
  const dots = coords.map(c => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="#4c5ef8">${c.count ? `<title>${c.label}: ${c.count}</title>` : ""}</circle>`).join("");
  const labels = coords.map((c, i) => (i % 3 === 0 || i === coords.length - 1)
    ? `<text x="${c.x.toFixed(1)}" y="${h - 8}" text-anchor="middle" font-size="9.5" fill="var(--text-faint)">${c.label}</text>` : "").join("");
  const svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <defs>
      <linearGradient id="trendFillGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4c5ef8" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#4c5ef8" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="${padL}" y1="${(padT + chartH).toFixed(1)}" x2="${w - padR}" y2="${(padT + chartH).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
    <path d="${areaPath}" fill="url(#trendFillGrad)"/>
    <path d="${linePath}" fill="none" stroke="#4c5ef8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${labels}
  </svg>`;
  return total ? svg : svg + `<div class="chart-caption">No assignments logged in the last 14 days</div>`;
}

// Horizontal bar comparison: Assigned vs Available for the largest-stock categories.
function svgCategoryBarCompare(rows) {
  const top = [...rows].filter(r => r.total > 0).sort((a, b) => b.total - a.total).slice(0, 6);
  if (!top.length) return `<div class="chart-empty">No stock yet — add categories and log a refill to see this chart.</div>`;
  const rowH = 34, gap = 10, labelW = 118, width = 560, chartW = width - labelW - 44;
  const height = top.length * (rowH + gap) - gap + 6;
  const maxV = Math.max(...top.map(r => Math.max(r.assigned, r.available)), 1);
  let y = 4;
  const rowsHtml = top.map(r => {
    const aW = (r.assigned / maxV) * chartW;
    const avW = (r.available / maxV) * chartW;
    const label = r.category.length > 15 ? r.category.slice(0, 14) + "…" : r.category;
    const row = `
      <text x="0" y="${y + 9}" font-size="11.3" font-weight="600" fill="var(--text)">${escapeHtml(label)}</text>
      <rect x="${labelW}" y="${y}" width="${Math.max(aW, r.assigned ? 3 : 0)}" height="10" rx="4" fill="#8a5cf6"/>
      <text x="${labelW + Math.max(aW, 8) + 6}" y="${y + 9}" font-size="10" fill="var(--text-faint)">${r.assigned}</text>
      <rect x="${labelW}" y="${y + 14}" width="${Math.max(avW, r.available ? 3 : 0)}" height="10" rx="4" fill="#0fb9a7"/>
      <text x="${labelW + Math.max(avW, 8) + 6}" y="${y + 23}" font-size="10" fill="var(--text-faint)">${r.available}</text>
    `;
    y += rowH + gap;
    return row;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${rowsHtml}</svg>
    <div class="chart-legend" style="flex-direction:row; gap:16px; margin-top:6px;">
      <div class="legend-item"><span class="legend-dot" style="background:#8a5cf6"></span><span class="legend-label">Assigned</span></div>
      <div class="legend-item"><span class="legend-dot" style="background:#0fb9a7"></span><span class="legend-label">Available</span></div>
    </div>`;
}

/* =========================================================
   DASHBOARD
   ========================================================= */
function renderDashboard() {
  const s = computeDashboard();
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

  const recentAssignments = sortAssignmentsNewestFirst(DB.assignments).slice(0, 6);
  const lowStockRows = s.rows.filter(r => r.low);
  const isFreshOffice = s.categories === 0;
  const catData = categoryStockBreakdown();
  const deptData = departmentAssignedBreakdown();

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

    <div class="dash-stack">
      <div class="grid-2-even">
        <div class="card">
          <div class="card-header">
            <div><h2>Stock Distribution</h2><div class="sub">Share of total stock by category</div></div>
            <button class="btn btn-secondary btn-sm" onclick="goto('stock')">Stock summary →</button>
          </div>
          ${catData.length ? `<div class="chart-flex">${svgDonutChart(catData, { centerLabel: "Units" })}${chartLegend(catData)}</div>`
            : `<div class="chart-empty">No stock yet — add categories and log a refill to see this chart.</div>`}
        </div>
        <div class="card">
          <div class="card-header">
            <div><h2>Assignments by Department</h2><div class="sub">Currently assigned units, by department</div></div>
            <button class="btn btn-secondary btn-sm" onclick="goto('assignment')">View all →</button>
          </div>
          ${deptData.length ? `<div class="chart-flex">${svgDonutChart(deptData, { centerLabel: "Assigned" })}${chartLegend(deptData)}</div>`
            : `<div class="chart-empty">No active assignments yet.</div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div><h2>Asset Lifecycle Flow</h2><div class="sub">Where every unit currently in stock sits right now</div></div>
        </div>
        ${svgLifecycleFlow(s)}
      </div>

      <div class="grid-2-even">
        <div class="card">
          <div class="card-header">
            <div><h2>Assignment Activity</h2><div class="sub">Units handed out per day — last 14 days</div></div>
          </div>
          ${svgTrendChart(last14DaysActivity())}
        </div>
        <div class="card">
          <div class="card-header">
            <div><h2>Top Categories</h2><div class="sub">Assigned vs available, largest stock first</div></div>
            <button class="btn btn-secondary btn-sm" onclick="goto('stock')">Stock summary →</button>
          </div>
          ${svgCategoryBarCompare(s.rows)}
        </div>
      </div>

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
          <div><h2>Low Stock Alerts</h2><div class="sub">Available ≤ threshold</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('stock')">Stock summary →</button>
        </div>
        ${lowStockRows.length ? lowStockRows.map(r => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer" title="View in Stock Summary" onclick="goto('stock')">
            <div>
              <div style="font-weight:600">${escapeHtml(r.category)}</div>
              <div class="muted" style="font-size:12px">Available: ${r.available} · Threshold: ${r.threshold}</div>
            </div>
            ${statusBadge("⚠ Low Stock")}
          </div>
        `).join("") : `<p class="muted">All categories are healthily stocked. ✅</p>`}
      </div>
    </div>
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
          <th>Date</th><th>Asset</th><th>Asset Tag</th><th>Employee</th><th>Dept</th><th>Assigned By</th>
          <th>Return Date</th><th>Status</th><th>Remarks</th><th></th>
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
      <td>${a.assetTagNo ? `<span class="badge badge-grey">${escapeHtml(a.assetTagNo)}</span>` : "—"}</td>
      <td>${escapeHtml(a.employeeName)}</td>
      <td>${escapeHtml(a.department || "—")}</td>
      <td>${escapeHtml(a.assignedBy || "—")}</td>
      <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${escapeHtml(a.remarks || "—")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" title="Handover Slip (PDF)" aria-label="Generate handover slip for ${escapeHtml(a.employeeName)}" onclick="openHandoverSlip('${a.uid}')">📄</button>
          ${admin ? `
          <button class="btn btn-secondary btn-sm btn-icon" title="Edit" aria-label="Edit assignment for ${escapeHtml(a.employeeName)}" onclick="openAssignForm('${a.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" title="Delete" aria-label="Delete assignment for ${escapeHtml(a.employeeName)}" onclick="deleteAssignment('${a.uid}')">🗑️</button>
          ` : ""}
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="${admin ? 11 : 10}">${filterActive ? `No records match your search/filters. <a href="#" id="assignEmptyClear" style="color:var(--primary);font-weight:600;">Clear filters</a>` : "No assignments yet"}</td></tr>`;

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
      const idsToDelete = [...assignSelected];
      const n = idsToDelete.length;
      DB.assignments = DB.assignments.filter(a => !assignSelected.has(a.uid));
      assignSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "assignments", type: "delete", uid: u })));
      logAction("Bulk deleted assignments", `Deleted ${n} selected assignment record(s)`); toast("Selected assignments deleted"); paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) {
    delAll.title = "Deletes only the assignments currently shown by your search/filters — not the whole log";
    delAll.onclick = () => {
      if (!requireAdminOrWarn()) return;
      confirmBulkDelete(rows.length, "assignments (matching your current search/filters)", () => {
        const idsToDelete = rows.map(r => r.uid);
        const idSet = new Set(idsToDelete);
        const n = idsToDelete.length;
        DB.assignments = DB.assignments.filter(a => !idSet.has(a.uid));
        assignSelected = new Set();
        batchWrite(idsToDelete.map(u => ({ kind: "assignments", type: "delete", uid: u })));
        logAction("Bulk deleted assignments", `Deleted ${n} assignment record(s) matching current filters`); toast("All matching assignments deleted"); paintAssignTable();
        if (currentPage === "dashboard") renderDashboard();
      });
    };
  }
}

/* ---------------- Asset Handover Slip (PDF, with signature) ---------------- */
function openHandoverSlip(uidVal) {
  const rec = DB.assignments.find(a => a.uid === uidVal);
  if (!rec) return;
  openModal("Asset Handover Slip", `
    <p class="muted" style="margin-top:0"><strong>${escapeHtml(rec.assetName)}</strong>${rec.assetTagNo ? ` (${escapeHtml(rec.assetTagNo)})` : ""} → <strong>${escapeHtml(rec.employeeName)}</strong> on ${fmtDate(rec.date)}</p>
    <div class="field"><label>Employee Signature (optional — draw with mouse/finger)</label>
      <div class="sig-pad-wrap">
        <canvas id="sigPad" class="sig-pad" width="480" height="150"></canvas>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="sigClearBtn" style="margin-top:8px;">Clear Signature</button>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelSlip">Cancel</button>
      <button class="btn btn-primary" id="downloadSlipBtn">⬇ Generate PDF</button>
    </div>
  `, () => {
    const canvas = document.getElementById("sigPad");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#1c2333"; ctx.lineWidth = 2; ctx.lineCap = "round";
    let drawing = false, hasSignature = false;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
    };
    const start = (e) => { drawing = true; hasSignature = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
    const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
    const end = () => { drawing = false; };
    canvas.addEventListener("mousedown", start); canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start); canvas.addEventListener("touchmove", move); canvas.addEventListener("touchend", end);
    document.getElementById("sigClearBtn").onclick = () => { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); hasSignature = false; };

    document.getElementById("cancelSlip").onclick = closeModal;
    document.getElementById("downloadSlipBtn").onclick = () => {
      const sigDataUrl = hasSignature ? canvas.toDataURL("image/png") : null;
      generateHandoverSlipPDF(rec, sigDataUrl);
      closeModal();
    };
  });
}

function generateHandoverSlipPDF(rec, signatureDataUrl) {
  if (typeof window.jspdf === "undefined") { toast("PDF library didn't load — check your connection", "err"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const officeInfo = OFFICES.find(o => o.id === currentOfficeId) || {};
  const officeName = officeInfo.name || "Speelfinance";
  const officeCity = officeInfo.city || "";
  const marginX = 48;
  let y = 56;

  doc.setFont("helvetica", "bold"); doc.setFontSize(18);
  doc.text("Speelfinance", marginX, y);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100);
  doc.text(`${officeName}${officeCity ? " — " + officeCity : ""}`, marginX, y + 16);
  doc.setTextColor(0);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  doc.text("ASSET HANDOVER SLIP", 595 - marginX, y, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100);
  doc.text(`Generated ${fmtDate(todayISO())}`, 595 - marginX, y + 16, { align: "right" });
  doc.setTextColor(0);
  y += 36;
  doc.setDrawColor(220); doc.line(marginX, y, 595 - marginX, y);
  y += 28;

  const rows = [
    ["Employee Name", rec.employeeName || "—"],
    ["Employee ID", rec.employeeId || "—"],
    ["Department", rec.department || "—"],
    ["Asset", rec.assetName || "—"],
    ["Asset Tag No.", rec.assetTagNo || "—"],
    ["Assignment Date", rec.date ? fmtDate(rec.date) : "—"],
    ["Assigned By", rec.assignedBy || "—"],
    ["Status", rec.status || "—"],
    ["Remarks", rec.remarks || "—"],
  ];
  doc.setFontSize(11);
  rows.forEach(([label, value]) => {
    doc.setFont("helvetica", "bold"); doc.text(label, marginX, y);
    doc.setFont("helvetica", "normal"); doc.text(String(value), marginX + 150, y);
    y += 22;
  });

  y += 14;
  doc.setFont("helvetica", "italic"); doc.setFontSize(9.5); doc.setTextColor(70);
  const declaration = "I acknowledge receipt of the asset(s) listed above in good working condition. I agree to take reasonable care of it, use it only for authorized purposes, and return it upon request or upon exit from the organization.";
  const wrapped = doc.splitTextToSize(declaration, 595 - marginX * 2);
  doc.text(wrapped, marginX, y);
  y += wrapped.length * 13 + 30;
  doc.setTextColor(0);

  if (signatureDataUrl) {
    doc.addImage(signatureDataUrl, "PNG", marginX, y - 45, 180, 56);
  }
  doc.setDrawColor(120);
  doc.line(marginX, y + 14, marginX + 200, y + 14);
  doc.line(340, y + 14, 340 + 200, y + 14);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
  doc.text("Employee Signature", marginX, y + 28);
  doc.text("Issued By Signature", 340, y + 28);
  doc.text(`Name: ${rec.employeeName || ""}`, marginX, y + 44);
  doc.text(`Name: ${rec.assignedBy || ""}`, 340, y + 44);

  const filename = `Handover_${safeFileBit(rec.employeeName)}_${safeFileBit(rec.assetName)}.pdf`;
  doc.save(filename);
  logAction("Generated handover slip", `${rec.assetName} → ${rec.employeeName}`);
  toast("Handover slip downloaded");
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
        ${editing.assetTagNo ? `<div class="muted" style="margin-top:4px;">Asset Tag: <strong>${escapeHtml(editing.assetTagNo)}</strong></div>` : ""}
      </div>`
    : `<div class="field">
        <label>Assets <span class="muted" style="font-weight:500;">(tick one or more, set Qty for bulk items — e.g. tick Headphone and set Qty 10 to log 10 headphones to one recipient in one go; each unit gets its own asset tag automatically)</span></label>
        <div class="asset-multiselect" id="assetMultiSelect">
          <div class="asset-multiselect-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="assetSelectAll">Select All</button>
            <button type="button" class="btn btn-secondary btn-sm" id="assetSelectNone">Clear</button>
          </div>
          ${cats.map(c => `
            <label class="asset-check-row">
              <input type="checkbox" class="f_asset_multi" value="${escapeHtml(c)}">
              <span>${escapeHtml(c)}</span>
              <span class="qty-label">Qty</span>
              <input type="number" class="f_asset_qty" data-cat="${escapeHtml(c)}" min="1" step="1" value="1" title="How many units of ${escapeHtml(c)} to log">
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
      <div class="field"><label>Employee / Recipient Name</label>
        <input type="text" id="f_emp" list="empList" value="${escapeHtml(editing ? editing.employeeName : "")}" placeholder="Employee name, or a team/TL name like 'KYC Training'">
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

      let newRecords = [];
      if (editing) {
        const rec = { ...common, assetName: document.getElementById("f_asset").value };
        Object.assign(editing, rec);
        saveRecord("assignments", editing);
        logAction("Edited assignment", `${rec.assetName} → ${empName}`);
        toast("Assignment updated");
      } else {
        const selectedBoxes = [...document.querySelectorAll(".f_asset_multi:checked")];
        if (!selectedBoxes.length) { toast("Select at least one asset", "err"); return; }

        // Each ticked category can carry its own Qty (default 1). One assignment
        // record — with its own unique, sequential asset tag — is created per unit,
        // so 10 headphones handed to one recipient becomes 10 linked, traceable
        // records instead of one entry with a quantity buried inside it. Because
        // each unit is its own "Assigned" record, the dashboard/stock counts
        // (which count assignment records, not a separate quantity field) stay
        // accurate automatically — nothing to reconcile by hand.
        const picks = selectedBoxes.map(cb => {
          const qtyInput = document.querySelector(`.f_asset_qty[data-cat="${CSS.escape(cb.value)}"]`);
          const qty = Math.max(1, Math.floor(Number(qtyInput?.value) || 1));
          return { assetName: cb.value, qty };
        });

        const summaryParts = [];
        picks.forEach(({ assetName, qty }) => {
          for (let i = 0; i < qty; i++) {
            const newRec = {
              uid: uid(),
              id: DB.assignments.length + 1,
              createdAt: nowISO(),
              ...common,
              assetName,
              assetTagNo: nextAssetTagNo(assetName),
            };
            DB.assignments.push(newRec);
            newRecords.push(newRec);
          }
          summaryParts.push(qty > 1 ? `${assetName} × ${qty}` : assetName);
        });

        newRecords.forEach(r => saveRecord("assignments", r));
        saveMeta(); // persists the updated per-category tag-number counters
        logAction("Added assignment(s)", `${summaryParts.join(", ")} → ${empName}`);
        toast(newRecords.length > 1
          ? `${newRecords.length} assignments added for ${empName}`
          : "Assignment added");
      }
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
      deleteRecord("assignments", uidVal); logAction("Deleted assignment", rec ? `${rec.assetName} — ${rec.employeeName}` : uidVal); closeModal(); toast("Assignment deleted"); paintAssignTable();
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
      const idsToDelete = [...invSelected];
      const n = idsToDelete.length;
      DB.inventory = DB.inventory.filter(r => !invSelected.has(r.uid));
      invSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "inventory", type: "delete", uid: u })));
      logAction("Bulk deleted inventory assets", `Deleted ${n} selected asset(s)`); toast("Selected assets deleted"); paintInvTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "assets (matching current search)", () => {
      const idsToDelete = rows.map(r => r.uid);
      const idSet = new Set(idsToDelete);
      const n = idsToDelete.length;
      DB.inventory = DB.inventory.filter(r => !idSet.has(r.uid));
      invSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "inventory", type: "delete", uid: u })));
      logAction("Bulk deleted inventory assets", `Deleted ${n} asset(s) matching current filters`); toast("All matching assets deleted"); paintInvTable();
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
      if (editing) { Object.assign(editing, rec); saveRecord("inventory", editing); logAction("Edited inventory asset", `${rec.assetId} — ${rec.assetName}`); toast("Asset updated"); }
      else { const newRec = { uid: uid(), ...rec }; DB.inventory.push(newRec); saveRecord("inventory", newRec); logAction("Added inventory asset", `${rec.assetId} — ${rec.assetName}`); toast("Asset added"); }
      closeModal(); paintInvTable();
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
      deleteRecord("inventory", uidVal); logAction("Deleted inventory asset", rec ? `${rec.assetId} — ${rec.assetName}` : uidVal); closeModal(); toast("Asset deleted"); paintInvTable();
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
      const idsToDelete = [...empSelected];
      const n = idsToDelete.length;
      DB.employees = DB.employees.filter(e => !empSelected.has(e.uid));
      empSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "employees", type: "delete", uid: u })));
      logAction("Bulk deleted employees", `Deleted ${n} selected employee(s)`); toast("Selected employees deleted"); paintEmpTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "employees (matching current search)", () => {
      const idsToDelete = rows.map(r => r.uid);
      const idSet = new Set(idsToDelete);
      const n = idsToDelete.length;
      DB.employees = DB.employees.filter(e => !idSet.has(e.uid));
      empSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "employees", type: "delete", uid: u })));
      logAction("Bulk deleted employees", `Deleted ${n} employee(s) matching current filters`); toast("All matching employees deleted"); paintEmpTable();
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
      if (editing) { Object.assign(editing, rec); saveRecord("employees", editing); logAction("Edited employee", `${rec.name}${rec.id ? " (" + rec.id + ")" : ""}`); toast("Employee updated"); }
      else { const newRec = { uid: uid(), ...rec }; DB.employees.push(newRec); saveRecord("employees", newRec); logAction("Added employee", `${rec.name}${rec.id ? " (" + rec.id + ")" : ""}`); toast("Employee added"); }
      closeModal(); paintEmpTable();
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
      deleteRecord("employees", uidVal); logAction("Removed employee", rec ? rec.name : uidVal); closeModal(); toast("Employee removed"); paintEmpTable();
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
  const ops = [];
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
      ops.push({ kind: "employees", type: "set", record: existing });
      updated++;
    } else {
      const newRec = { uid: uid(), id: rec.id || "", name: rec.name, department: rec.department || "", email: rec.email || "", phone: rec.phone || "" };
      DB.employees.push(newRec);
      ops.push({ kind: "employees", type: "set", record: newRec });
      added++;
    }
  });

  batchWrite(ops);
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
        <thead><tr><th>Date</th><th>Asset</th><th>Asset Tag</th><th>Status</th><th>Assigned By</th><th>Return Date</th><th>Remarks</th></tr></thead>
        <tbody>
          ${records.length ? records.map(a => `
            <tr>
              <td>${fmtAssignDateCell(a)}</td>
              <td>${escapeHtml(a.assetName)}</td>
              <td>${a.assetTagNo ? escapeHtml(a.assetTagNo) : "—"}</td>
              <td>${statusBadge(a.status)}</td>
              <td>${escapeHtml(a.assignedBy || "—")}</td>
              <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}</td>
              <td>${escapeHtml(a.remarks || "—")}</td>
            </tr>`).join("") : `<tr class="empty-row"><td colspan="7">No assets have been issued to this employee yet</td></tr>`}
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
        saveMeta();
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
      const idsToDelete = [...refillSelected];
      const n = idsToDelete.length;
      DB.refills = DB.refills.filter(r => !refillSelected.has(r.uid));
      refillSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "refills", type: "delete", uid: u })));
      logAction("Bulk deleted refill entries", `Deleted ${n} selected entr${n === 1 ? "y" : "ies"}`); toast("Selected entries deleted"); paintRefillTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "refill entries", () => {
      const idsToDelete = DB.refills.map(r => r.uid);
      const n = idsToDelete.length;
      DB.refills = [];
      refillSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "refills", type: "delete", uid: u })));
      logAction("Bulk deleted refill entries", `Deleted all ${n} refill log entries`); toast("All refill entries deleted"); paintRefillTable();
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
      const newRec = {
        uid: uid(), id: DB.refills.length + 1,
        date: document.getElementById("f_date").value,
        category,
        quantity: qty,
        addedBy: document.getElementById("f_by").value.trim(),
        source: document.getElementById("f_source").value.trim(),
      };
      DB.refills.push(newRec);
      saveRecord("refills", newRec); logAction("Logged stock refill", `+${qty} ${category}`); closeModal(); toast("Refill logged"); paintRefillTable();
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
      deleteRecord("refills", uidVal); logAction("Deleted refill entry", rec ? `-${rec.quantity} ${rec.category}` : uidVal); closeModal(); toast("Refill entry deleted"); paintRefillTable();
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
      const idsToDelete = [...catSelected];
      const n = idsToDelete.length;
      DB.categories = DB.categories.filter(c => !catSelected.has(c.uid));
      catSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "categories", type: "delete", uid: u })));
      logAction("Bulk deleted categories", `Deleted ${n} selected categor${n === 1 ? "y" : "ies"}`); toast("Selected categories deleted"); paintCatTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "categories", () => {
      const idsToDelete = DB.categories.map(c => c.uid);
      const n = idsToDelete.length;
      DB.categories = [];
      catSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "categories", type: "delete", uid: u })));
      logAction("Bulk deleted categories", `Deleted all ${n} categories`); toast("All categories deleted"); paintCatTable();
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
        const ops = [{ kind: "categories", type: "set", record: editing }];
        if (oldName !== name) {
          DB.assignments.forEach(a => {
            if (a.assetName === oldName) { a.assetName = name; ops.push({ kind: "assignments", type: "set", record: a }); }
          });
          DB.refills.forEach(r => {
            if (r.category === oldName) { r.category = name; ops.push({ kind: "refills", type: "set", record: r }); }
          });
          if (DB.stockManual[oldName]) { DB.stockManual[name] = DB.stockManual[oldName]; delete DB.stockManual[oldName]; }
        }
        batchWrite(ops);
        saveMeta();
        logAction("Edited category", oldName !== name ? `Renamed "${oldName}" → "${name}"` : name);
        toast("Category updated");
      } else {
        const newRec = { uid: uid(), name, notes: document.getElementById("f_notes").value.trim() };
        DB.categories.push(newRec);
        DB.stockManual[name] = { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5 };
        saveRecord("categories", newRec);
        saveMeta();
        logAction("Added category", name);
        toast("Category added");
      }
      closeModal(); paintCatTable();
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
      deleteRecord("categories", uidVal); logAction("Deleted category", rec ? rec.name : uidVal); closeModal(); toast("Category deleted"); paintCatTable();
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
   REPORTS — export any module (or everything) to Excel
   ========================================================= */
function safeFileBit(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "office";
}
function exportSheet(filenameBase, sheetName, rows) {
  if (!rows.length) { toast("Nothing to export yet", "err"); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, `${filenameBase}.xlsx`);
  logAction("Exported report", `${sheetName} (${rows.length} rows)`);
  toast(`Exported ${sheetName}`);
}

function reportRows(kind) {
  const stock = kind === "stock" ? computeStockSummary() : null;
  switch (kind) {
    case "employees": return DB.employees.map(e => ({ "Employee ID": e.id || "", "Name": e.name || "", "Department": e.department || "", "Email": e.email || "", "Phone": e.phone || "" }));
    case "assignment": return DB.assignments.map(a => ({ "Date": a.date || "", "Asset": a.assetName || "", "Asset Tag": a.assetTagNo || "", "Employee": a.employeeName || "", "Employee ID": a.employeeId || "", "Department": a.department || "", "Assigned By": a.assignedBy || "", "Return Date": a.returnDate || "", "Status": a.status || "", "Remarks": a.remarks || "" }));
    case "inventory": return DB.inventory.map(r => ({ "Asset ID": r.assetId || "", "Asset Name": r.assetName || "", "Brand": r.brand || "", "Model": r.model || "", "Serial": r.serial || "", "Purchase Date": r.purchaseDate || "", "Status": r.status || "", "Assigned To": r.assignedTo || "", "Floor": r.floor || "", "Condition": r.condition || "" }));
    case "stock": return stock.map(r => ({ "Category": r.category, "Total Stock": r.total, "Assigned": r.assigned, "Under Repair": r.underRepair, "Faulty": r.faulty, "Lost": r.lost, "Scrap": r.scrap, "Available": r.available, "Threshold": r.threshold, "Alert": r.low ? "Low Stock" : "OK" }));
    case "refill": return DB.refills.map(r => ({ "Date": r.date || "", "Category": r.category || "", "Quantity Added": r.quantity || 0, "Added By": r.addedBy || "", "Source / Remarks": r.source || "" }));
    case "categories": return DB.categories.map(c => ({ "Category": c.name || "", "Notes": c.notes || "" }));
    case "activityLog": return activityLogCache.map(l => ({ "When": fmtDateTime(l.ts), "User": l.email || "", "Action": l.action || "", "Details": l.details || "" }));
    default: return [];
  }
}

function renderReports() {
  const content = document.getElementById("content");
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "office";
  const modules = [
    { kind: "employees", label: "Employees", sheet: "Employees", icon: "👥" },
    { kind: "assignment", label: "Asset Assignment", sheet: "Asset Assignment", icon: "🗂️" },
    { kind: "inventory", label: "Master Inventory", sheet: "Master Inventory", icon: "💻" },
    { kind: "stock", label: "Stock Summary", sheet: "Stock Summary", icon: "📦" },
    { kind: "refill", label: "Stock Refill Log", sheet: "Stock Refill Log", icon: "➕" },
    { kind: "categories", label: "Asset Categories", sheet: "Asset Categories", icon: "🏷️" },
  ];

  content.innerHTML = `
    <div class="card" style="margin-bottom:18px">
      <div class="card-header">
        <div><h2>Export Everything</h2><div class="sub">One Excel file with every module below as its own sheet, for <strong>${escapeHtml(officeName)}</strong></div></div>
        <button class="btn btn-primary btn-sm" id="exportAllBtn">⬇ Export Full Workbook</button>
      </div>
      <p class="muted" style="margin-top:0">Mirrors the shape of the original Excel tracker — handy for sharing a snapshot with someone outside the app.</p>
    </div>

    <div class="card">
      <div class="card-header"><div><h2>Export by Module</h2><div class="sub">Just one sheet at a time, as its own .xlsx file</div></div></div>
      <div class="report-grid">
        ${modules.map(m => `
          <div class="report-tile">
            <div class="report-tile-icon">${m.icon}</div>
            <div class="report-tile-label">${m.label}</div>
            <button class="btn btn-secondary btn-sm" data-kind="${m.kind}" data-sheet="${escapeHtml(m.sheet)}">Export</button>
          </div>
        `).join("")}
        <div class="report-tile">
          <div class="report-tile-icon">📝</div>
          <div class="report-tile-label">Activity Log</div>
          <button class="btn btn-secondary btn-sm" id="exportLogBtn">Export</button>
        </div>
      </div>
    </div>
  `;

  document.querySelectorAll(".report-tile button[data-kind]").forEach(btn => {
    btn.onclick = () => exportSheet(`${safeFileBit(officeName)}_${btn.dataset.kind}`, btn.dataset.sheet, reportRows(btn.dataset.kind));
  });

  document.getElementById("exportLogBtn").onclick = async () => {
    await loadActivityLog();
    exportSheet(`${safeFileBit(officeName)}_activity_log`, "Activity Log", reportRows("activityLog"));
  };

  document.getElementById("exportAllBtn").onclick = async () => {
    await loadActivityLog();
    const wb = XLSX.utils.book_new();
    modules.forEach(m => {
      const rows = reportRows(m.kind);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ " ": "No data" }]), m.sheet.slice(0, 31));
    });
    const logRows = reportRows("activityLog");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logRows.length ? logRows : [{ " ": "No data" }]), "Activity Log");
    XLSX.writeFile(wb, `${safeFileBit(officeName)}_full_export.xlsx`);
    logAction("Exported report", `Full workbook (${modules.length + 1} sheets)`);
    toast("Full workbook exported");
  };
}

/* =========================================================
   SETTINGS — manage dropdown lists
   ========================================================= */
function renderSettings() {
  const content = document.getElementById("content");
  const admin = isAdmin();
  const superAdmin = isSuperAdmin();
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "this office";
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
        <div><h2>Office Access — ${escapeHtml(officeName)}</h2><div class="sub">Who can edit THIS office specifically (Super Admin only to manage)</div></div>
        ${superAdmin ? `<button class="btn btn-primary btn-sm" id="addOfficeAccessBtn">+ Add Person</button>` : ""}
      </div>
      ${superAdmin ? `<div class="table-wrap"><table>
        <thead><tr><th>Email</th><th>Role in this office</th><th></th></tr></thead>
        <tbody id="officeAccessTbody"><tr class="empty-row"><td colspan="3">Loading…</td></tr></tbody>
      </table></div>` : `<p class="muted" style="margin-top:0">Only Super Admins can view or manage office-specific access. ${admin ? "You're an Admin for this office, granted by a Super Admin." : "Ask a Super Admin to grant you Admin access here if you need to edit this office."}</p>`}
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="card-header">
        <div><h2>Super Admins</h2><div class="sub">Can edit every office, plus create/delete offices and grant office-specific access</div></div>
        ${superAdmin ? `<button class="btn btn-primary btn-sm" id="addRoleBtn">+ Add Person</button>` : ""}
      </div>
      ${superAdmin ? `<div class="table-wrap"><table>
        <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody id="rolesTbody"><tr class="empty-row"><td colspan="3">Loading…</td></tr></tbody>
      </table></div>` : `<p class="muted" style="margin-top:0">Only Super Admins can view or manage this list.</p>`}
    </div>

    <div class="card">
      <div class="card-header"><div><h2>How access works</h2></div></div>
      <p class="muted" style="margin-top:0"><strong>Viewer</strong>: signs in, can browse and search every office, no edits.
      <strong>Office Admin</strong>: can edit one specific office (granted in "Office Access" above).
      <strong>Super Admin</strong>: can edit every office and manage who has access to what.</p>
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
        saveMeta(); logAction("Added list option", `${key}: "${val}"`); input.value = ""; paintChips(key); toast("Added");
      };
    });
  }

  if (superAdmin) {
    document.getElementById("addRoleBtn").onclick = () => openRoleForm();
    loadRolesList();
    document.getElementById("addOfficeAccessBtn").onclick = () => openOfficeAccessForm();
    loadOfficeAccessList();
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
  if (!requireSuperAdminOrWarn()) return;
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
  if (!requireSuperAdminOrWarn()) return;
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

/* ---------------- Office Access (per-office Admin/Viewer grants) ---------------- */
async function loadOfficeAccessList() {
  const tbody = document.getElementById("officeAccessTbody");
  if (!tbody) return;
  try {
    const snap = await docRef().collection("access").get();
    const rows = [];
    snap.forEach(doc => rows.push({ email: doc.id, ...doc.data() }));
    rows.sort((a, b) => (a.email || "").localeCompare(b.email || ""));
    tbody.innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td>${escapeHtml(r.email)}</td>
        <td><span class="badge ${r.role === "admin" ? "badge-blue" : "badge-grey"}">${r.role === "admin" ? "Admin" : "Viewer"}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn btn-secondary btn-sm btn-icon" title="Change role" onclick="openOfficeAccessForm('${escapeHtml(r.email)}','${r.role}')">✏️</button>
            <button class="btn btn-danger btn-sm btn-icon" title="Remove access" onclick="removeOfficeAccess('${escapeHtml(r.email)}')">🗑️</button>
          </div>
        </td>
      </tr>
    `).join("") : `<tr class="empty-row"><td colspan="3">Nobody has office-specific access yet — Super Admins can already edit here.</td></tr>`;
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load access list.</td></tr>`;
  }
}

function openOfficeAccessForm(existingEmail, existingRole) {
  if (!requireSuperAdminOrWarn()) return;
  const editing = !!existingEmail;
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "this office";
  openModal(editing ? "Change Office Access" : "Grant Office Access", `
    ${editing ? "" : `<p class="muted" style="margin-top:0">Grants access to <strong>${escapeHtml(officeName)}</strong> only. The email must exactly match a login already created in Firebase → Authentication → Users.</p>`}
    <div class="field"><label>Email</label><input type="email" id="f_oaEmail" value="${escapeHtml(existingEmail || "")}" ${editing ? "disabled" : ""} placeholder="person@company.com"></div>
    <div class="field"><label>Role</label>
      <select id="f_oaRole">
        <option value="viewer" ${existingRole === "viewer" ? "selected" : ""}>Viewer — view only</option>
        <option value="admin" ${existingRole === "admin" ? "selected" : ""}>Admin — can edit this office</option>
      </select>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelOA">Cancel</button>
      <button class="btn btn-primary" id="saveOA">${editing ? "Save" : "Grant Access"}</button>
    </div>
  `, () => {
    const emailInp = document.getElementById("f_oaEmail");
    document.getElementById("cancelOA").onclick = closeModal;
    document.getElementById("saveOA").onclick = async () => {
      const email = emailInp.value.trim().toLowerCase();
      const role = document.getElementById("f_oaRole").value;
      if (!email) { toast("Enter an email", "err"); return; }
      try {
        await docRef().collection("access").doc(email).set({ email, role, updatedAt: new Date().toISOString() }, { merge: true });
        logAction(editing ? "Changed office access" : "Granted office access", `${email} → ${role === "admin" ? "Admin" : "Viewer"}`);
        closeModal();
        toast(editing ? "Access updated" : "Access granted");
        loadOfficeAccessList();
      } catch (err) {
        console.error(err);
        toast("Couldn't save — check your Firestore Rules", "err");
      }
    };
  });
}

function removeOfficeAccess(email) {
  if (!requireSuperAdminOrWarn()) return;
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "this office";
  openModal("Remove access?", `
    <p class="muted" style="margin-top:0"><strong>${escapeHtml(email)}</strong> will no longer have office-specific access to <strong>${escapeHtml(officeName)}</strong>. (Super Admins always retain access regardless.)</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelOAD">Cancel</button>
      <button class="btn btn-danger" id="confirmOAD">Remove</button>
    </div>`, () => {
    document.getElementById("cancelOAD").onclick = closeModal;
    document.getElementById("confirmOAD").onclick = async () => {
      try {
        await docRef().collection("access").doc(email).delete();
        logAction("Removed office access", email);
        closeModal();
        toast("Access removed");
        loadOfficeAccessList();
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
  saveMeta();
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
function showFirebaseSetupScreen(isError, detail) {
  const shell = document.querySelector(".app-shell");
  if (shell) shell.style.display = "none";
  document.getElementById("signInGateScreen")?.classList.remove("show");
  document.getElementById("officeSelectScreen")?.classList.remove("show");
  const el = document.getElementById("firebaseSetupScreen");
  if (el) {
    el.classList.add("show");
    const note = document.getElementById("setupErrorNote");
    if (note) {
      note.style.display = isError ? "block" : "none";
      if (isError && detail) {
        note.innerHTML = `Firebase is configured, but the app couldn't load data — double-check your config values,
        that Firestore + Authentication are enabled, and that your Security Rules are published.<br>
        <code style="display:inline-block;margin-top:6px;">Error: ${escapeHtml(detail)}</code>`;
      }
    }
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
  const admin = isAdmin(); // on the picker, currentOfficeRole is unset, so this means Super Admin
  if (!OFFICES.length) {
    grid.innerHTML = `<div class="office-empty-note">No offices yet${admin ? " — add one to get started." : ". Ask an Admin to create one."}</div>`;
    return;
  }
  grid.innerHTML = OFFICES.map(o => {
    const role = isSuperAdminUser ? "admin" : (officeRoleMap[o.id] || "viewer");
    const roleBadge = isSuperAdminUser
      ? `<span class="office-role-badge admin">Super Admin</span>`
      : `<span class="office-role-badge ${role}">${role === "admin" ? "Admin" : "Viewer"}</span>`;
    return `
    <div class="office-card" data-id="${escapeHtml(o.id)}">
      ${admin ? `<div class="office-card-actions">
        <button class="office-card-edit" data-id="${escapeHtml(o.id)}" title="Rename office">✎</button>
        ${OFFICES.length > 1 ? `<button class="office-card-del" data-id="${escapeHtml(o.id)}" title="Delete office">✕</button>` : ""}
      </div>` : ""}
      <div class="office-card-icon">🏢</div>
      <div class="office-card-name">${escapeHtml(o.name)}</div>
      <div class="office-card-city">${escapeHtml(o.city || "—")} ${roleBadge}</div>
    </div>
  `;
  }).join("");
  const addBtn = document.getElementById("addOfficeBtn");
  if (addBtn) addBtn.style.display = admin ? "" : "none";
}
async function openOffice(officeId) {
  currentOfficeId = officeId;
  localStorage.setItem(LAST_OFFICE_KEY, officeId);
  hideAllGateScreens();
  showLoadingScreen();
  try {
    await fetchOfficeRole();
    await loadInitialData();
    attachRealtimeListener();
    dataBootstrapped = true;
  } catch (err) {
    console.error(err);
    hideLoadingScreen();
    showFirebaseSetupScreen(true, err && err.message);
    return;
  }
  hideLoadingScreen();
  paintRoleUI();
  paintOfficeUI();
  logAction("Opened office", `Signed in and opened this office's data`);
  goto(currentPage);
}
async function showOfficeSelectScreen() {
  detachRealtimeListener();
  DB = null;
  dataBootstrapped = false;
  currentOfficeId = null;
  currentOfficeRole = null;
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
    if (!requireSuperAdminOrWarn()) return;
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
    if (!requireSuperAdminOrWarn()) return;
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
  if (!requireSuperAdminOrWarn()) return;
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
      isSuperAdminUser = false;
      currentOfficeRole = null;
      officeRoleMap = {};
      paintRoleUI();
      detachRealtimeListener();
      DB = null;
      dataBootstrapped = false;
      currentOfficeId = null;
      hideLoadingScreen();
      showSignInGate();
      return;
    }

    await fetchGlobalRole();
    await fetchAccessibleOffices();
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

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
function requestsColl() { return docRef().collection("requests"); }
function transfersColl() { return docRef().collection("transfers"); }
function collFor(kind) {
  return { employees: employeesColl, assignments: assignmentsColl, inventory: inventoryColl, refills: refillsColl, categories: categoriesColl, requests: requestsColl, transfers: transfersColl }[kind]();
}
// Team Leads can only ever list THEIR OWN requests (enforced by firestore.rules —
// an unfiltered query would be denied outright for them), so which query to run
// depends on who's asking. Admins/Super Admins get the full office queue.
function requestsQuery() {
  return isAdmin() ? requestsColl() : requestsColl().where("requestedBy", "==", (fauth.currentUser || {}).email || "");
}
// Sequential, human-facing Request IDs (AST-REQ-2026-00001, ...) — a small counter
// document incremented inside a real Firestore transaction, kept in its own
// subcollection (not the office meta doc, which only Admins can write) so a Team
// Lead submitting a request can still get a real, collision-safe number.
function requestCounterRef() { return docRef().collection("counters").doc("assetRequests"); }
// fdb.runTransaction() already retries internally on real contention (two
// people submitting at the same instant) — adding our own retry loop on top
// of that just compounds into dozens of attempts and a much longer wait
// without fixing anything, especially for 'resource-exhausted', which usually
// means an actual Firestore quota/rate limit, not a one-document traffic jam
// that a retry will clear. So: one attempt, fail fast, and let the caller
// show a clear reason instead of spinning.
async function nextRequestId() {
  const year = new Date().getFullYear();
  const seq = await fdb.runTransaction(async tx => {
    const snap = await tx.get(requestCounterRef());
    const cur = ((snap.exists && snap.data()[year]) || 0) + 1;
    tx.set(requestCounterRef(), { [year]: cur }, { merge: true });
    return cur;
  });
  return `AST-REQ-${year}-${String(seq).padStart(5, "0")}`;
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
// Blank starting meta for a brand-new office — keeps the generic dropdown
// option lists (status/condition/floor/department) but no actual records.
// Every actual record collection (employees/assignments/etc.) starts empty
// simply by not existing yet — only .lists/.stockManual ever get written from
// this, so that's all it returns (used to also list empty record arrays that
// nothing ever read, which just implied a full DB shape was being built here).
function emptyOfficeDB() {
  return { lists: JSON.parse(JSON.stringify(SEED_DATA.lists || {})), stockManual: {} };
}
async function resetOfficeData(toOriginalSheet) {
  const deleteOps = [];
  ["employees", "categories", "assignments", "refills", "inventory", "requests", "transfers"].forEach(kind => {
    (DB[kind] || []).forEach(r => deleteOps.push({ kind, type: "delete", uid: r.uid }));
  });
  if (deleteOps.length) await batchWrite(deleteOps);
  // Not part of DB (only ever touched directly via requestCounterRef()), so it's
  // not covered by the loop above — without this, Request IDs would keep
  // incrementing from wherever they left off instead of restarting at 00001,
  // even though every actual request was just wiped.
  try { await requestCounterRef().delete(); } catch (err) { console.error("Couldn't reset the request ID counter:", err); }

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
  for (const sub of ["employees", "categories", "assignments", "refills", "inventory", "logs", "requests", "counters", "transfers"]) {
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
let currentOfficeRole = null;   // "admin" | "teamlead" | "viewer" | null — from this office's access/{email}
let currentOfficeTeam = null;   // which Team a "teamlead" is responsible for, e.g. "KYC Team A" — same access doc
let officeRoleMap = {};         // officeId -> "admin"|"teamlead"|"viewer", for badges on the office picker
const OFFICE_ROLES = ["admin", "teamlead", "viewer"]; // valid values for access/{email}.role, most-privileged first

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
  currentOfficeTeam = null;
  if (!fauth || !fauth.currentUser || !currentOfficeId) return;
  if (isSuperAdminUser) { currentOfficeRole = "admin"; return; }
  try {
    const snap = await docRef().collection("access").doc(fauth.currentUser.email).get();
    const data = snap.exists ? snap.data() : {};
    const role = data.role || "viewer";
    currentOfficeRole = OFFICE_ROLES.includes(role) ? role : "viewer";
    currentOfficeTeam = (data.team || "").trim();
  } catch (err) {
    console.error("Couldn't look up office role, defaulting to Viewer:", err);
    currentOfficeRole = "viewer";
  }
}
// Which Team the signed-in Team Lead is responsible for (blank if not yet
// assigned one, or if they're not a Team Lead at all).
function myTeam() { return currentOfficeTeam || ""; }

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
      const role = doc.data().role;
      officeRoleMap[officeId] = OFFICE_ROLES.includes(role) ? role : "viewer";
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
// A Team Lead can submit and track their own Asset Requests, but has none of the
// Admin's edit rights — isAdmin() stays false for them everywhere else in the app.
function isTeamLead() {
  return !!(fauth && fauth.currentUser) && !isAdmin() && currentOfficeRole === "teamlead";
}
function paintRoleUI() {
  const badge = document.getElementById("roleBadge");
  const btn = document.getElementById("roleSwitchBtn");
  const emailLbl = document.getElementById("roleEmailLabel");
  if (!badge || !btn) return;
  const signedIn = !!(fauth && fauth.currentUser);
  const admin = isAdmin();
  const teamLead = isTeamLead();
  badge.textContent = !signedIn ? "Signed out" : (isSuperAdminUser ? "Super Admin" : (admin ? "Admin" : (teamLead ? "Team Lead" : "Viewer")));
  badge.className = "role-badge " + (admin ? "admin" : (teamLead ? "teamlead" : "viewer"));
  btn.textContent = "Sign Out";
  btn.style.display = signedIn ? "" : "none";
  if (emailLbl) emailLbl.textContent = signedIn ? (fauth.currentUser.email || "") : "";
  applyNavVisibility();
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

// Loads the office's meta doc (lists/stockManual), handling one-time
// migration/seeding as needed, then hands off to refreshAllData() for the
// per-record collections (employees/assignments/etc) — the only thing that
// ever fetches those, so there's exactly one read path for them, not two
// (this file used to fetch everything here AND again via a realtime
// listener's first snapshot — see refreshAllData()'s comment for why
// listeners were removed entirely in favor of load-once + manual refresh).
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
      requests: [], transfers: [],
    };
    await fetchRequestsIntoDB();
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
    employees: [], categories: [], assignments: [], refills: [], inventory: [], requests: [], transfers: [],
  };
  await refreshAllData();
}
// Asset Requests are loaded separately from the rest of the collections (rather
// than folded into the Promise.all above) because WHICH query is even allowed
// depends on the signed-in user's role — see requestsQuery(). A Team Lead's
// unfiltered query would be denied outright by firestore.rules.
async function fetchRequestsIntoDB() {
  DB.requests = [];
  try {
    const snap = await requestsQuery().get();
    snap.forEach(d => DB.requests.push(d.data()));
  } catch (err) {
    console.error("Couldn't load asset requests:", err);
  }
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

// Which collections currently have NO data loaded (their most recent fetch
// attempt failed — quota limit, offline, etc.) — surfaced via a persistent
// banner (updateDataLoadWarning) instead of failing silently. A failed
// employees load used to just leave DB.employees empty with no indication
// why, which looked exactly like "this employee genuinely isn't in Employee
// Master" — very misleading for the Team-lock feature specifically.
let dataLoadFailures = new Set();
const DATA_LOAD_LABELS = { employees: "Employees", categories: "Asset Categories", assignments: "Asset Assignment", refills: "Stock Refill Log", inventory: "Master Inventory", meta: "Settings / Lists", requests: "Asset Requests", transfers: "Asset Transfers" };
function updateDataLoadWarning() {
  const bar = document.getElementById("dataLoadWarningBar");
  if (!bar) return;
  if (dataLoadFailures.size) {
    bar.style.display = "flex";
    const names = [...dataLoadFailures].map(k => DATA_LOAD_LABELS[k] || k).join(", ");
    bar.textContent = `⚠️ Couldn't load: ${names} — related fields (like Team autofill) won't work correctly. Usually a Firestore quota limit or connection issue. Try 🔄 Refresh Data below once it clears.`;
  } else {
    bar.style.display = "none";
  }
}

// One-time fetch of every collection — this app deliberately does NOT use
// Firestore realtime listeners (onSnapshot). Listeners re-broadcast every
// single change to every other person who has the app open at that moment —
// on Firestore's free Spark plan (50k reads/day, hard cap, no paid tier),
// that fan-out is what actually burns through the quota, far more than
// logins alone: one write with N people connected costs N reads, repeated
// for every change anyone makes. Loading once (on sign-in, and again only
// when the person explicitly hits 🔄 Refresh Data) makes reads scale with
// how often people actually ask for fresh data, not with how many tabs
// happen to be open in the background. The trade-off: other people's changes
// don't appear until you refresh — no longer instant across devices/tabs.
async function refreshAllData() {
  // Master Inventory, the Stock Refill Log, and Asset Transfers are all
  // Admin/Viewer-only pages — a Team Lead can never navigate to any of them
  // (see TEAM_LEAD_PAGES) and nothing on their Dashboard or Asset Requests
  // page reads DB.inventory/DB.refills/DB.transfers, so there's no reason to
  // fetch any of them for that role. They just stay empty arrays.
  const colls = { employees: employeesColl, categories: categoriesColl, assignments: assignmentsColl };
  if (!isTeamLead()) Object.assign(colls, { refills: refillsColl, inventory: inventoryColl, transfers: transfersColl });

  const tasks = Object.entries(colls).map(([key, fn]) =>
    fn().get().then(snap => {
      const list = [];
      snap.forEach(d => list.push(d.data()));
      DB[key] = list;
      dataLoadFailures.delete(key);
    }).catch(err => {
      console.error(`Couldn't load ${key}:`, err);
      dataLoadFailures.add(key);
    })
  );
  tasks.push(docRef().get().then(snap => {
    if (snap.exists) {
      const data = snap.data();
      if (data.lists) DB.lists = data.lists;
      if (data.stockManual) DB.stockManual = data.stockManual;
    }
    dataLoadFailures.delete("meta");
  }).catch(err => {
    console.error("Couldn't load office settings:", err);
    dataLoadFailures.add("meta");
  }));
  // Kept separate from the `colls` loop above — the query itself (all requests vs.
  // just this person's own) depends on role, see requestsQuery().
  tasks.push(requestsQuery().get().then(snap => {
    const list = [];
    snap.forEach(d => list.push(d.data()));
    DB.requests = list;
    dataLoadFailures.delete("requests");
  }).catch(err => {
    console.error("Couldn't load asset requests:", err);
    dataLoadFailures.add("requests");
  }));

  await Promise.all(tasks);
  updateDataLoadWarning();
  updateRequestsNavBadge();
}
// Resets the "couldn't load" banner on sign-out/office-switch so a stale
// warning from a previous session/office never lingers into the next one.
function stopDataSync() {
  dataLoadFailures = new Set();
  updateDataLoadWarning();
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

/* Renders the "N selected · Delete Selected · Delete All" strip used on every list page.
   Delete is Super-Admin-only everywhere in this app — an Office Admin only sees this
   bar at all if there's a non-delete bulk action to offer (e.g. the combined handover
   slip on Assignments); otherwise there's nothing here for them to do with a selection. */
function bulkToolbarHtml(selectedSize, totalSize, extraButtonsHtml) {
  if (!isAdmin()) return "";
  const superAdmin = isSuperAdmin();
  if (!superAdmin && !extraButtonsHtml) return "";
  return `
    <div class="bulk-actions">
      <span class="bulk-count">${selectedSize} selected</span>
      ${extraButtonsHtml || ""}
      ${superAdmin ? `
      <button class="btn btn-danger btn-sm" id="deleteSelectedBtn" ${selectedSize === 0 ? "disabled" : ""}>🗑 Delete Selected</button>
      <button class="btn btn-secondary btn-sm" id="deleteAllBtn" ${totalSize === 0 ? "disabled" : ""}>Delete All</button>
      ` : ""}
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
// Total Stock = Stock Refill Log entries + units RECEIVED from another office,
// PLUS Under Repair (still owned, just temporarily unusable), MINUS
// Faulty/Lost/Scrap — those are gone for good (broken beyond repair, lost, or
// disposed), so they no longer count as stock we actually have, not just
// "stock we have but can't hand out."
//
// Assigned = assigned to an employee here + sent to another office. Once a
// unit has left this office, whether to a person or another branch, it's
// equally out of our available pool — one number, not two separate
// deductions (assignedToEmployees / sentTotal are still broken out below for
// the on-screen footnote). Reassigning a previously-returned unit never
// double-counts: the old assignment record stays "Returned" permanently, only
// the new one is ever "Assigned" — see openReassignForm().
function computeStockSummary() {
  return DB.categories.map(cat => {
    const name = cat.name;
    const refillTotal = DB.refills
      .filter(r => r.category === name)
      .reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    const receivedTotal = (DB.transfers || [])
      .filter(t => t.assetType === name && t.direction === "Received")
      .reduce((s, t) => s + (Number(t.quantity) || 0), 0);
    const sentTotal = (DB.transfers || [])
      .filter(t => t.assetType === name && t.direction === "Sent")
      .reduce((s, t) => s + (Number(t.quantity) || 0), 0);
    const assignedToEmployees = DB.assignments
      .filter(a => a.assetName === name && a.status === "Assigned").length;
    const assigned = assignedToEmployees + sentTotal;
    const manual = DB.stockManual[name] || { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5 };
    const total = refillTotal + receivedTotal - manual.faulty - manual.lost - manual.scrap;
    const available = total - assigned - manual.underRepair;
    const low = available <= manual.threshold;
    return {
      category: name, total, assigned, assignedToEmployees, sentTotal, receivedTotal,
      underRepair: manual.underRepair, faulty: manual.faulty, lost: manual.lost, scrap: manual.scrap,
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

function conditionBadge(cond) {
  const map = { "New": "badge-green", "Good": "badge-green", "Fair": "badge-amber", "Poor": "badge-red", "Damaged": "badge-red" };
  const cls = map[cond] || "badge-grey";
  return `<span class="badge ${cls}">${escapeHtml(cond)}</span>`;
}

/* ---------------- Asset Requests: shared badge helpers ---------------- */
function requestStatusBadge(status) {
  const map = {
    "Draft": "badge-grey", "Submitted": "badge-blue", "Under Review": "badge-amber",
    "Approved": "badge-purple", "Partially Fulfilled": "badge-amber", "Rejected": "badge-red",
    "Fulfilled": "badge-green", "Cancelled": "badge-grey",
  };
  return `<span class="badge ${map[status] || "badge-grey"}">${escapeHtml(status)}</span>`;
}
function priorityBadge(priority) {
  const map = { "Normal": "badge-grey", "High": "badge-amber", "Urgent": "badge-red" };
  return `<span class="badge ${map[priority] || "badge-grey"}">${escapeHtml(priority)}</span>`;
}
const REQUEST_ACTIVE_STATUSES = ["Draft", "Submitted", "Under Review", "Approved", "Partially Fulfilled"];

/* ---------------- Asset Requests: multi-item helpers ----------------
   A request can ask for several different assets at once (e.g. a new
   employee needing a laptop + mouse + headset in one go) instead of one
   asset type per request. Each item tracks its own requested quantity vs.
   how much has actually been given out so far, so Admin can hand over
   whichever items are in stock now and leave the rest Pending until a
   later Assign Asset pass — see fulfillRequestFromAssignment(). */
function getRequestItems(rec) {
  if (Array.isArray(rec.items) && rec.items.length) return rec.items;
  // Backward-compat: requests created before this existed only ever had
  // one asset type/quantity at the top level — treat that as a 1-item list.
  if (rec.assetType) {
    return [{ assetType: rec.assetType, otherAssetType: rec.otherAssetType || "", quantity: rec.quantity || 1, givenQuantity: rec.status === "Fulfilled" ? (rec.quantity || 1) : 0 }];
  }
  return [];
}
function requestItemLabel(item) {
  return item.assetType === "Other" ? (item.otherAssetType || "Other") : item.assetType;
}
function requestItemRemaining(item) {
  return Math.max(0, (item.quantity || 1) - (item.givenQuantity || 0));
}
function requestItemStatus(item) {
  const remaining = requestItemRemaining(item);
  if (remaining <= 0) return "Given";
  return (item.givenQuantity || 0) > 0 ? "Partially Given" : "Pending";
}
function requestItemStatusBadge(item) {
  const s = requestItemStatus(item);
  const cls = s === "Given" ? "badge-green" : s === "Partially Given" ? "badge-amber" : "badge-grey";
  return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
}
function requestItemsSummary(rec) {
  const items = getRequestItems(rec);
  return items.map(i => `${requestItemLabel(i)}${(i.quantity || 1) > 1 ? ` ×${i.quantity}` : ""}`).join(", ") || "—";
}

/* ---------------- Asset Returns ---------------- */
// Maps a return "Outcome" (what happens to the unit once it's back) onto the
// same manual repair/faulty/lost/scrap counters the Stock Summary page uses,
// so a broken phone coming back doesn't silently count itself as "Available"
// again — it actually lands in the right bucket.
const RETURN_OUTCOME_BUCKET = { "Under Repair": "underRepair", "Faulty": "faulty", "Lost": "lost", "Scrap": "scrap" };

// Suggests a sensible default Outcome from the Condition the item came back in.
// Just a starting point — the admin can always override it in the form.
function suggestReturnOutcome(condition) {
  if (condition === "Poor") return "Under Repair";
  if (condition === "Damaged") return "Faulty";
  return "Available";
}

// Runs once, the moment an assignment record transitions INTO "Returned" —
// whether that's through the quick "↩ Return" button, editing an existing
// assignment's status, or logging a brand-new record that's already marked
// Returned (for backfilling assets you never entered an "Assigned" row for).
//
// 1. Adjusts the category's manual stock counters so Available reflects reality.
// 2. Finds or creates the matching Master Inventory row (by Asset Tag), so even
//    assets that were never registered in Master Inventory get one automatically
//    the first time a return is recorded for them — no manual pre-step needed.
function applyReturnSideEffects(rec) {
  const outcome = rec.returnOutcome || "Available";
  const bucket = RETURN_OUTCOME_BUCKET[outcome];
  if (bucket) {
    if (!DB.stockManual[rec.assetName]) {
      DB.stockManual[rec.assetName] = { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5 };
    }
    DB.stockManual[rec.assetName][bucket] = (DB.stockManual[rec.assetName][bucket] || 0) + 1;
    saveMeta();
  }

  if (rec.assetTagNo) {
    const note = `Returned ${fmtDate(rec.returnDate || todayISO())} by ${rec.employeeName}` +
      (rec.remarks ? ` — ${rec.remarks}` : "");
    const existing = DB.inventory.find(i => i.assetId === rec.assetTagNo);
    if (existing) {
      existing.status = outcome;
      existing.condition = rec.returnCondition || existing.condition || "";
      existing.assignedTo = "";
      existing.remarks = existing.remarks ? `${existing.remarks}\n${note}` : note;
      saveRecord("inventory", existing);
    } else {
      const newInv = {
        uid: uid(),
        assetId: rec.assetTagNo,
        assetName: rec.assetName,
        brand: "", model: "", serial: "",
        purchaseDate: "", purchaseCost: "", vendor: "", warrantyExpiry: "",
        status: outcome,
        assignedTo: "",
        department: rec.department || "",
        floor: "",
        condition: rec.returnCondition || "",
        remarks: `Auto-created from asset return — ${note}`,
      };
      DB.inventory.push(newInv);
      saveRecord("inventory", newInv);
    }
  }

  logAction("Returned asset", `${rec.assetName}${rec.assetTagNo ? ` (${rec.assetTagNo})` : ""} returned by ${rec.employeeName} — condition: ${rec.returnCondition || "—"}, now ${outcome}`);
}

/* =========================================================
   ROUTER
   ========================================================= */
const PAGES = {
  dashboard: { title: "Dashboard", render: renderDashboard },
  assignment: { title: "Asset Assignment", render: renderAssignment },
  returns: { title: "Asset Returns", render: renderReturns },
  assetRequests: { title: "Asset Requests", render: renderAssetRequests },
  inventory: { title: "Master Inventory", render: renderInventory },
  employees: { title: "Employees", render: renderEmployees },
  empHistory: { title: "Employee History", render: renderEmployeeHistory },
  stock: { title: "Stock Summary", render: renderStock },
  refill: { title: "Stock Refill Log", render: renderRefill },
  transfers: { title: "Asset Transfers", render: renderTransfers },
  categories: { title: "Asset Categories", render: renderCategories },
  activityLog: { title: "Activity Log", render: renderActivityLog },
  reports: { title: "Reports", render: renderReports },
  settings: { title: "Settings", render: renderSettings },
};

// Pages a pure Team Lead (has the "teamlead" role and isn't also an Admin) is allowed to
// open — this only drives the nav/UX; the real enforcement is always firestore.rules, so
// even someone forcing goto('inventory') from the console gets no more read/write access
// than the rules already grant a Team Lead (same as any other role in this app).
const TEAM_LEAD_PAGES = new Set(["dashboard", "assetRequests"]);
// Asset Requests itself is Team-Lead-and-Admin-only — a plain Viewer never sees it,
// same spirit as Settings already being admin-only content.
function canOpenAssetRequests() { return isAdmin() || isTeamLead(); }
function applyNavVisibility() {
  const teamLeadOnly = isTeamLead();
  document.querySelectorAll(".nav-item").forEach(b => {
    const page = b.dataset.page;
    if (teamLeadOnly) { b.style.display = TEAM_LEAD_PAGES.has(page) ? "" : "none"; return; }
    if (page === "assetRequests") { b.style.display = canOpenAssetRequests() ? "" : "none"; return; }
    b.style.display = "";
  });
}

function goto(page) {
  if (!PAGES[page]) page = "dashboard"; // guard against a stale/invalid saved page
  if (isTeamLead() && !TEAM_LEAD_PAGES.has(page)) page = "dashboard";
  if (page === "assetRequests" && !canOpenAssetRequests()) page = "dashboard";
  currentPage = page;
  localStorage.setItem(LAST_PAGE_KEY, page);
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  document.getElementById("pageTitle").textContent = PAGES[page].title;
  document.getElementById("content").innerHTML = "";
  PAGES[page].render();
  document.getElementById("sidebar").classList.remove("open");
  window.scrollTo(0, 0);
  updateRequestsNavBadge();
}
// Unread-style count on the "Asset Requests" nav item — Submitted requests an
// Admin hasn't looked at yet, same idea as a chat app's unread badge. Called
// from goto() (every page render) and from refreshAllData() (every fetch), so
// it's as fresh as the data currently in memory — no separate listener needed.
function updateRequestsNavBadge() {
  const btn = document.querySelector('.nav-item[data-page="assetRequests"]');
  if (!btn) return;
  let badge = btn.querySelector(".nav-badge");
  const count = isAdmin() ? (DB.requests || []).filter(r => r.status === "Submitted").length : 0;
  if (count > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-badge";
      btn.appendChild(badge);
    }
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.title = `${count} new asset request${count === 1 ? "" : "s"} awaiting review`;
  } else if (badge) {
    badge.remove();
  }
}

document.getElementById("nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (btn) goto(btn.dataset.page);
});
document.getElementById("hamburger").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
});
document.getElementById("refreshDataBtn").addEventListener("click", async () => {
  if (!fauth || !fauth.currentUser || !currentOfficeId) return;
  const btn = document.getElementById("refreshDataBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "🔄 Refreshing…";
  try {
    await refreshAllData();
    goto(currentPage);
    toast("Data refreshed");
  } catch (err) {
    console.error(err);
    toast("Couldn't refresh — check your connection", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});
document.getElementById("resetDataBtn").addEventListener("click", () => {
  // Wipes every record in the office — same "only a Super Admin can delete
  // anything" policy as the delete buttons themselves.
  if (!requireSuperAdminOrWarn()) return;
  const isDefaultOffice = currentOfficeId === DEFAULT_OFFICE_ID;
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "this office";
  // Confirmed by typing the office's own name back (like GitHub's "delete this repo" flow) —
  // no shared secret to keep track of, and it forces you to actually read which office you're
  // about to wipe instead of muscle-memory-typing a password.
  openModal("Reset this office's data?", `
    <p class="muted" style="margin-top:0">This resets the dashboard, assignments, employees and logs for
    <strong>${escapeHtml(officeName)}</strong> ${isDefaultOffice ? "back to the original uploaded sheet" : "to a blank slate"} —
    for everyone viewing this office, since data is shared live via Firebase. Other offices are not affected.
    Anything anyone has added or edited for this office will be lost.</p>
    <div class="field"><label>Type <strong>${escapeHtml(officeName)}</strong> to confirm</label>
      <input type="text" id="resetConfirmName" placeholder="${escapeHtml(officeName)}" autocomplete="off">
    </div>
    <p id="resetPwError" style="display:none; color:var(--red); font-weight:600; font-size:12.5px; margin-top:-6px;">That doesn't match the office name.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelReset">Cancel</button>
      <button class="btn btn-danger" id="confirmReset">Yes, reset this office's data</button>
    </div>
  `, () => {
    const nameInp = document.getElementById("resetConfirmName");
    nameInp.focus();
    document.getElementById("cancelReset").onclick = closeModal;
    const attempt = async () => {
      if (nameInp.value.trim().toLowerCase() !== officeName.trim().toLowerCase()) {
        document.getElementById("resetPwError").style.display = "block";
        nameInp.focus();
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
    nameInp.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
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
// Only buckets that are still genuinely part of "Total Stock" belong here —
// Faulty/Lost/Scrap are excluded from Total itself now (see
// computeStockSummary: they're gone for good, not just unavailable), so
// showing them as a slice "flowing out of" Total would be double-counting
// something that was already subtracted before this diagram even runs.
// Under Repair is still part of Total (temporarily unusable, not gone).
function svgLifecycleFlow(s) {
  const nodesAll = [
    { label: "Assigned", value: s.assigned, color: "#8a5cf6" },
    { label: "Under Repair", value: s.underRepair, color: "#f5a623" },
    { label: "Available", value: s.available, color: "#0fb9a7" },
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
function last14DaysActivityFor(records) {
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, label: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) });
  }
  return days.map(d => ({ ...d, count: records.filter(a => a.date === d.iso).length }));
}
function last14DaysActivity() { return last14DaysActivityFor(DB.assignments); }
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
// Everything about a Team Lead's own team, in one place: who's on it, what
// they're currently holding, who has nothing yet, and a category breakdown —
// joined purely by matching Employee.team against Assignment.employeeName
// (assignments don't carry a team of their own, so this is the link).
function computeTeamOverview(team) {
  const teamKey = (team || "").trim().toLowerCase();
  const members = teamKey ? DB.employees.filter(e => (e.team || "").trim().toLowerCase() === teamKey) : [];
  const memberNameKeys = new Set(members.map(e => (e.name || "").trim().toLowerCase()));
  const teamAssignments = DB.assignments.filter(a => memberNameKeys.has((a.employeeName || "").trim().toLowerCase()));
  const heldAssignments = teamAssignments.filter(a => a.status === "Assigned");

  const perMember = members.map(emp => {
    const nameKey = (emp.name || "").trim().toLowerCase();
    const held = heldAssignments.filter(a => (a.employeeName || "").trim().toLowerCase() === nameKey);
    return { employee: emp, held };
  }).sort((a, b) => b.held.length - a.held.length || (a.employee.name || "").localeCompare(b.employee.name || ""));

  const catMap = {};
  heldAssignments.forEach(a => { catMap[a.assetName] = (catMap[a.assetName] || 0) + 1; });
  const categoryBreakdown = Object.entries(catMap).sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value, color: chartColor(i) }));

  return {
    team, members, memberCount: members.length,
    assetsHeld: heldAssignments.length,
    membersWithNothing: perMember.filter(m => m.held.length === 0).length,
    distinctCategories: Object.keys(catMap).length,
    perMember, teamAssignments, heldAssignments, categoryBreakdown,
  };
}
function teamStatCards(ov) {
  return [
    { icon: "👥", cls: "icon-blue", value: ov.memberCount, label: "Team Members" },
    { icon: "📦", cls: "icon-purple", value: ov.assetsHeld, label: "Assets Currently Held" },
    { icon: "🙈", cls: "icon-amber", value: ov.membersWithNothing, label: "With Nothing Assigned" },
    { icon: "🏷️", cls: "icon-teal", value: ov.distinctCategories, label: "Asset Types In Use" },
  ];
}

// A Team Lead's "home" — their own team's asset picture front and center
// (who has what, who has nothing, category mix, recent activity), plus their
// own request queue below it so both halves of the job are in one place.
function renderTeamLeadDashboard() {
  const content = document.getElementById("content");
  const team = myTeam();
  const ov = computeTeamOverview(team);
  const mine = sortRequestsNewestFirst(getMyRequests());
  const reqSummary = computeRequestsSummary(mine);
  const recentRequests = mine.slice(0, 6);
  const recentTeamActivity = sortAssignmentsNewestFirst(ov.teamAssignments).slice(0, 8);

  content.innerHTML = `
    ${viewerNotice()}
    ${!team ? `
      <div class="viewer-note" style="align-items:flex-start;border-color:var(--amber,#e2a13b);">
        <span style="font-size:16px;">👋</span>
        <div>
          <strong>Your account isn't linked to a team yet.</strong>
          <div style="margin-top:2px;">Ask an Admin to assign one under Settings → Office Access, and this page will fill in with your team's asset picture. Your own requests still work below in the meantime.</div>
        </div>
      </div>
    ` : `
      <div class="req-detail-head" style="margin-bottom:16px;">
        <div><h2 style="margin:0;font-size:17px;">${escapeHtml(team)}</h2><div class="muted" style="font-size:12.5px;margin-top:2px;">${ov.memberCount} team member${ov.memberCount === 1 ? "" : "s"}</div></div>
        <button class="btn btn-primary btn-sm" id="tlNewReqBtn">+ New Asset Request</button>
      </div>
      ${renderStatGrid(teamStatCards(ov))}

      <div class="dash-stack">
        <div class="grid-2-even">
          <div class="card">
            <div class="card-header">
              <div><h2>Assets by Category</h2><div class="sub">Currently held by your team</div></div>
            </div>
            ${ov.categoryBreakdown.length ? `<div class="chart-flex">${svgDonutChart(ov.categoryBreakdown, { centerLabel: "Held" })}${chartLegend(ov.categoryBreakdown)}</div>`
              : `<div class="chart-empty">Nobody on your team has an asset assigned yet.</div>`}
          </div>
          <div class="card">
            <div class="card-header">
              <div><h2>Team Activity</h2><div class="sub">Assignments &amp; returns — last 14 days</div></div>
            </div>
            ${svgTrendChart(last14DaysActivityFor(ov.teamAssignments))}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div><h2>Who Has What</h2><div class="sub">Every team member and what's currently assigned to them</div></div>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Employee</th><th>Employee ID</th><th>Currently Held</th><th>Count</th></tr></thead>
            <tbody>
              ${ov.perMember.length ? ov.perMember.map(m => `
                <tr>
                  <td>${escapeHtml(m.employee.name)}</td>
                  <td>${escapeHtml(m.employee.id || "—")}</td>
                  <td>${m.held.length ? m.held.map(a => `<span class="badge badge-grey" style="margin:1px 3px 1px 0;">${escapeHtml(a.assetName)}${a.assetTagNo ? ` (${escapeHtml(a.assetTagNo)})` : ""}</span>`).join("") : `<span class="muted">Nothing assigned</span>`}</td>
                  <td>${m.held.length}</td>
                </tr>
              `).join("") : `<tr class="empty-row"><td colspan="4">No employees found with Team = "${escapeHtml(team)}" yet — set it on the Employees page, or it fills in automatically the next time a request for them is approved.</td></tr>`}
            </tbody>
          </table></div>
        </div>

        <div class="card">
          <div class="card-header">
            <div><h2>Recent Team Asset Activity</h2><div class="sub">Latest assignments &amp; returns for your team</div></div>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Asset</th><th>Employee</th><th>Status</th></tr></thead>
            <tbody>
              ${recentTeamActivity.length ? recentTeamActivity.map(a => `
                <tr>
                  <td>${fmtAssignDateCell(a)}</td>
                  <td>${escapeHtml(a.assetName)}${a.assetTagNo ? ` <span class="muted">(${escapeHtml(a.assetTagNo)})</span>` : ""}</td>
                  <td>${escapeHtml(a.employeeName)}</td>
                  <td>${statusBadge(a.status)}</td>
                </tr>
              `).join("") : `<tr class="empty-row"><td colspan="4">No activity yet for this team.</td></tr>`}
            </tbody>
          </table></div>
        </div>
      </div>
    `}

    <div class="card-header" style="margin:22px 0 2px;">
      <div><h2 style="margin:0;">My Asset Requests</h2><div class="sub">Requests you've submitted, across every status</div></div>
      <button class="btn btn-secondary btn-sm" onclick="goto('assetRequests')">View all →</button>
    </div>
    ${renderStatGrid(requestStatCards(reqSummary))}
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Request ID</th><th>Employee</th><th>Assets</th><th>Status</th><th>Last Updated</th></tr></thead>
        <tbody>
          ${recentRequests.length ? recentRequests.map(r => `
            <tr style="cursor:pointer" title="Click to view" onclick="openRequestDetail('${r.uid}')">
              <td>${r.requestId ? `<span class="badge badge-grey">${escapeHtml(r.requestId)}</span>` : `<span class="muted">Draft</span>`}</td>
              <td>${escapeHtml(r.employeeName || "—")}</td>
              <td>${escapeHtml(requestItemsSummary(r))}</td>
              <td>${requestStatusBadge(r.status)}</td>
              <td>${fmtDate((r.updatedAt || r.createdAt || "").slice(0, 10))}</td>
            </tr>
          `).join("") : `<tr class="empty-row"><td colspan="5">No asset requests yet — click "+ New Asset Request" to submit one for your team.</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <p class="footer-note">Speelfinance · Asset Management Tracker — synced when you sign in or hit 🔄 Refresh Data</p>
  `;
  const newReqBtn = document.getElementById("tlNewReqBtn");
  if (newReqBtn) newReqBtn.onclick = () => openRequestForm();
}

function renderDashboard() {
  // A pure Team Lead's home is their own team's asset picture + their own
  // request queue (§20) — a dedicated dashboard, not the full org one below.
  if (isTeamLead()) return renderTeamLeadDashboard();

  const s = computeDashboard();
  const content = document.getElementById("content");
  const admin = isAdmin();
  const reqSummary = computeRequestsSummary(DB.requests || []);

  // Cards link to wherever that number actually lives, so the dashboard
  // works as a jumping-off point rather than a dead-end summary.
  const cards = [
    { label: "Asset Categories", value: s.categories, icon: "🏷️", cls: "icon-indigo", foot: "Tracked categories", goto: "categories" },
    { label: "Total Inventory", value: s.total, icon: "📦", cls: "icon-blue", foot: "Refills + received, minus faulty/lost/scrap", goto: "stock" },
    { label: "Available", value: s.available, icon: "🟢", cls: "icon-teal", foot: "Ready to assign", goto: "stock" },
    { label: "Assigned", value: s.assigned, icon: "🔵", cls: "icon-purple", foot: "Currently in use", goto: "assignment", presetFilter: "Assigned" },
    { label: "Under Repair", value: s.underRepair, icon: "🔧", cls: "icon-amber", foot: "Being fixed", goto: "stock" },
    { label: "Faulty", value: s.faulty, icon: "🔴", cls: "icon-red", foot: "Not working", goto: "stock" },
    { label: "Lost", value: s.lost, icon: "✖", cls: "icon-grey", foot: "Unaccounted", goto: "stock" },
    { label: "Scrap", value: s.scrap, icon: "⚫", cls: "icon-grey", foot: "Decommissioned", goto: "stock" },
    // Kept to just these two so the dashboard doesn't get overloaded (§21) —
    // the full request queue with every filter lives on Asset Requests itself.
    ...(admin ? [
      { label: "Pending Asset Requests", value: reqSummary.pending, icon: "📋", cls: "icon-blue", foot: "Awaiting review", goto: "assetRequests" },
      { label: "Urgent Requests", value: reqSummary.urgent, icon: "🔥", cls: "icon-red", foot: "Marked Urgent, still open", goto: "assetRequests" },
    ] : []),
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
        <div class="stat-card" role="button" tabindex="0" title="View in ${c.goto === "assignment" ? "Asset Assignment" : c.goto === "categories" ? "Asset Categories" : c.goto === "assetRequests" ? "Asset Requests" : "Stock Summary"}"
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

    <p class="footer-note">Speelfinance · Asset Management Tracker — synced when you sign in or hit 🔄 Refresh Data</p>
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
      <td>${escapeHtml(a.assetName)}${a.sourceRequestId ? `<div class="muted" style="font-size:11px;margin-top:2px;">${admin ? `<a href="#" onclick="event.preventDefault();openRequestByRequestId('${escapeHtml(a.sourceRequestId)}')" style="color:var(--primary);font-weight:600;">📋 from ${escapeHtml(a.sourceRequestId)}</a>` : `📋 from ${escapeHtml(a.sourceRequestId)}`}</div>` : ""}${a.reassignedFromEmployee ? `<div class="muted" style="font-size:11px;margin-top:2px;">🔁 reassigned from ${escapeHtml(a.reassignedFromEmployee)}</div>` : ""}</td>
      <td>${a.assetTagNo ? `<span class="badge badge-grey">${escapeHtml(a.assetTagNo)}</span>` : "—"}</td>
      <td>${escapeHtml(a.employeeName)}</td>
      <td>${escapeHtml(a.department || "—")}</td>
      <td>${escapeHtml(a.assignedBy || "—")}</td>
      <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}${a.returnCondition ? `<br>${conditionBadge(a.returnCondition)}` : ""}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${escapeHtml(a.remarks || "—")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" title="Handover Slip (PDF)" aria-label="Generate handover slip for ${escapeHtml(a.employeeName)}" onclick="openHandoverSlip('${a.uid}')">📄</button>
          ${admin ? `
          ${a.status !== "Returned" ? `<button class="btn btn-secondary btn-sm btn-icon" title="Return this asset" aria-label="Return asset for ${escapeHtml(a.employeeName)}" onclick="openAssignForm('${a.uid}', true)">↩️</button>` : ""}
          ${a.status === "Returned" && (a.returnOutcome || "Available") === "Available" ? `<button class="btn btn-primary btn-sm btn-icon" title="Reassign to someone else" aria-label="Reassign ${escapeHtml(a.assetName)} to a different employee" onclick="openReassignForm('${a.uid}')">🔁</button>` : ""}
          <button class="btn btn-secondary btn-sm btn-icon" title="Edit" aria-label="Edit assignment for ${escapeHtml(a.employeeName)}" onclick="openAssignForm('${a.uid}')">✏️</button>
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" aria-label="Delete assignment for ${escapeHtml(a.employeeName)}" onclick="deleteAssignment('${a.uid}')">🗑️</button>` : ""}
          ` : ""}
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="${admin ? 11 : 10}">${filterActive ? `No records match your search/filters. <a href="#" id="assignEmptyClear" style="color:var(--primary);font-weight:600;">Clear filters</a>` : "No assignments yet"}</td></tr>`;

  document.getElementById("assignBulkBar").innerHTML = bulkToolbarHtml(assignSelected.size, rows.length, assignSlipBtnHtml());
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
      document.getElementById("assignBulkBar").innerHTML = bulkToolbarHtml(assignSelected.size, rows.length, assignSlipBtnHtml());
      wireAssignBulk(rows);
    };
  });
  const delSel = document.getElementById("deleteSelectedBtn");
  if (delSel) delSel.onclick = () => {
    if (!requireSuperAdminOrWarn() || assignSelected.size === 0) return;
    confirmBulkDelete(assignSelected.size, "assignments", () => {
      const recordsToDelete = DB.assignments.filter(a => assignSelected.has(a.uid));
      const idsToDelete = recordsToDelete.map(r => r.uid);
      const n = idsToDelete.length;
      DB.assignments = DB.assignments.filter(a => !assignSelected.has(a.uid));
      assignSelected = new Set();
      unlinkAssignmentsFromRequests(recordsToDelete);
      batchWrite(idsToDelete.map(u => ({ kind: "assignments", type: "delete", uid: u })));
      logAction("Bulk deleted assignments", `Deleted ${n} selected assignment record(s)`); toast("Selected assignments deleted"); paintAssignTable();
      if (currentPage === "assetRequests") renderAssetRequests();
      if (currentPage === "dashboard") renderDashboard();
    });
  };
  const slipBtn = document.getElementById("bulkSlipBtn");
  if (slipBtn) slipBtn.onclick = () => {
    if (assignSelected.size === 0) return;
    const records = DB.assignments.filter(a => assignSelected.has(a.uid));
    openCombinedHandoverSlip(records);
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) {
    delAll.title = "Deletes only the assignments currently shown by your search/filters — not the whole log";
    delAll.onclick = () => {
      if (!requireSuperAdminOrWarn()) return;
      confirmBulkDelete(rows.length, "assignments (matching your current search/filters)", () => {
        const idsToDelete = rows.map(r => r.uid);
        const idSet = new Set(idsToDelete);
        const n = idsToDelete.length;
        DB.assignments = DB.assignments.filter(a => !idSet.has(a.uid));
        assignSelected = new Set();
        unlinkAssignmentsFromRequests(rows);
        batchWrite(idsToDelete.map(u => ({ kind: "assignments", type: "delete", uid: u })));
        logAction("Bulk deleted assignments", `Deleted ${n} assignment record(s) matching current filters`); toast("All matching assignments deleted"); paintAssignTable();
        if (currentPage === "assetRequests") renderAssetRequests();
        if (currentPage === "dashboard") renderDashboard();
      });
    };
  }
}

/* ---------------- Asset Handover Slip (PDF, with signature) ---------------- */
function assignSlipBtnHtml() {
  return `<button class="btn btn-secondary btn-sm" id="bulkSlipBtn" ${assignSelected.size === 0 ? "disabled" : ""}>📄 Generate Slip for Selected</button>`;
}

// Single row's 📄 button — one asset, one employee, with signature capture.
function openHandoverSlip(uidVal) {
  const rec = DB.assignments.find(a => a.uid === uidVal);
  if (!rec) return;
  openSignatureSlipModal([rec], `<strong>${escapeHtml(rec.assetName)}</strong>${rec.assetTagNo ? ` (${escapeHtml(rec.assetTagNo)})` : ""} → <strong>${escapeHtml(rec.employeeName)}</strong> on ${fmtDate(rec.date)}`);
}

// Bulk "Generate Slip for Selected" — groups the selection by employee. One
// employee selected → single combined slip (with signature) listing every
// asset they're getting. Multiple employees selected → one multi-page PDF,
// one page per employee, no signature capture (nothing sensible to sign for
// a batch spanning several people in one sitting).
function openCombinedHandoverSlip(records) {
  if (!records.length) return;
  const groups = groupAssignmentsByEmployee(records);
  if (groups.length === 1) {
    const g = groups[0];
    openSignatureSlipModal(g.records, `<strong>${g.records.length} asset${g.records.length > 1 ? "s" : ""}</strong> → <strong>${escapeHtml(g.employeeName)}</strong>`);
  } else {
    generateHandoverSlipPDF(groups, null);
  }
}

function groupAssignmentsByEmployee(records) {
  const map = new Map();
  records.forEach(r => {
    const key = `${r.employeeName || ""}__${r.employeeId || ""}`;
    if (!map.has(key)) map.set(key, { employeeName: r.employeeName, employeeId: r.employeeId, department: r.department, assignedBy: r.assignedBy, records: [] });
    map.get(key).records.push(r);
  });
  return [...map.values()];
}

// Tracks the signature pad's current window-level "mouseup" handler (needed so
// releasing the mouse outside the canvas still stops the stroke) — this modal
// can be reopened many times a session (every handover slip), and `window`
// itself is never recreated, so without this the old handler from each past
// opening would stack up on window forever instead of being replaced.
let sigPadMouseupHandler = null;
function openSignatureSlipModal(records, summaryHtml) {
  const groups = groupAssignmentsByEmployee(records);
  openModal(records.length > 1 ? "Combined Asset Handover Slip" : "Asset Handover Slip", `
    <p class="muted" style="margin-top:0">${summaryHtml}</p>
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
    if (sigPadMouseupHandler) window.removeEventListener("mouseup", sigPadMouseupHandler);
    sigPadMouseupHandler = end;
    window.addEventListener("mouseup", sigPadMouseupHandler);
    canvas.addEventListener("touchstart", start); canvas.addEventListener("touchmove", move); canvas.addEventListener("touchend", end);
    document.getElementById("sigClearBtn").onclick = () => { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height); hasSignature = false; };

    document.getElementById("cancelSlip").onclick = closeModal;
    document.getElementById("downloadSlipBtn").onclick = () => {
      const sigDataUrl = hasSignature ? canvas.toDataURL("image/png") : null;
      generateHandoverSlipPDF(groups, sigDataUrl);
      closeModal();
    };
  });
}

// groups: [{ employeeName, employeeId, department, assignedBy, records: [assignment,...] }, ...]
// One page per employee group. signatureDataUrl (if given) is only stamped on the
// first/only page — it only makes sense when there's exactly one employee group.
function generateHandoverSlipPDF(groups, signatureDataUrl) {
  if (typeof window.jspdf === "undefined") { toast("PDF library didn't load — check your connection", "err"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const officeInfo = OFFICES.find(o => o.id === currentOfficeId) || {};
  const officeName = officeInfo.name || "Speelfinance";
  const officeCity = officeInfo.city || "";
  const marginX = 48;
  const pageWidth = 595;

  groups.forEach((g, gi) => {
    if (gi > 0) doc.addPage();
    let y = 56;

    doc.setFont("helvetica", "bold"); doc.setFontSize(18);
    doc.text("Speelfinance", marginX, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100);
    doc.text(`${officeName}${officeCity ? " — " + officeCity : ""}`, marginX, y + 16);
    doc.setTextColor(0);
    doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("ASSET HANDOVER SLIP", pageWidth - marginX, y, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100);
    doc.text(`Generated ${fmtDate(todayISO())}`, pageWidth - marginX, y + 16, { align: "right" });
    doc.setTextColor(0);
    y += 36;
    doc.setDrawColor(220); doc.line(marginX, y, pageWidth - marginX, y);
    y += 28;

    const header = [
      ["Employee Name", g.employeeName || "—"],
      ["Employee ID", g.employeeId || "—"],
      ["Department", g.department || "—"],
      ["Assigned By", g.assignedBy || "—"],
    ];
    doc.setFontSize(11);
    header.forEach(([label, value]) => {
      doc.setFont("helvetica", "bold"); doc.text(label, marginX, y);
      doc.setFont("helvetica", "normal"); doc.text(String(value), marginX + 150, y);
      y += 22;
    });
    y += 8;

    // Asset table — one row per asset, even when there's only one.
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    const cols = [
      { label: "Asset", x: marginX, w: 165 },
      { label: "Tag No.", x: marginX + 165, w: 80 },
      { label: "Date", x: marginX + 245, w: 75 },
      { label: "Status", x: marginX + 320, w: 70 },
      { label: "Remarks", x: marginX + 390, w: pageWidth - marginX - (marginX + 390) },
    ];
    doc.setDrawColor(200); doc.line(marginX, y + 4, pageWidth - marginX, y + 4);
    y += 16;
    cols.forEach(c => doc.text(c.label, c.x, y));
    y += 8;
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    g.records.forEach(rec => {
      const vals = [rec.assetName || "—", rec.assetTagNo || "—", rec.date ? fmtDate(rec.date) : "—", rec.status || "—", rec.remarks || "—"];
      let maxLines = 1;
      cols.forEach((c, i) => {
        const wrapped = doc.splitTextToSize(String(vals[i]), c.w - 4);
        doc.text(wrapped, c.x, y);
        maxLines = Math.max(maxLines, wrapped.length);
      });
      y += maxLines * 12 + 8;
    });

    y += 20;
    doc.setFont("helvetica", "italic"); doc.setFontSize(9.5); doc.setTextColor(70);
    const declaration = "I acknowledge receipt of the asset(s) listed above in good working condition. I agree to take reasonable care of them, use them only for authorized purposes, and return them upon request or upon exit from the organization.";
    const wrapped = doc.splitTextToSize(declaration, pageWidth - marginX * 2);
    doc.text(wrapped, marginX, y);
    y += wrapped.length * 13 + 30;
    doc.setTextColor(0);

    if (signatureDataUrl && groups.length === 1) {
      doc.addImage(signatureDataUrl, "PNG", marginX, y - 45, 180, 56);
    }
    doc.setDrawColor(120);
    doc.line(marginX, y + 14, marginX + 200, y + 14);
    doc.line(340, y + 14, 340 + 200, y + 14);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    doc.text("Employee Signature", marginX, y + 28);
    doc.text("Issued By Signature", 340, y + 28);
    doc.text(`Name: ${g.employeeName || ""}`, marginX, y + 44);
    doc.text(`Name: ${g.assignedBy || ""}`, 340, y + 44);
  });

  const first = groups[0] || {};
  const filename = groups.length === 1 && first.records.length === 1
    ? `Handover_${safeFileBit(first.employeeName)}_${safeFileBit(first.records[0].assetName)}.pdf`
    : groups.length === 1
      ? `Handover_${safeFileBit(first.employeeName)}_${first.records.length}_assets.pdf`
      : `Handover_${groups.length}_employees.pdf`;
  doc.save(filename);

  const totalAssets = groups.reduce((s, g) => s + g.records.length, 0);
  logAction("Generated handover slip", groups.length === 1
    ? `${totalAssets} asset(s) → ${first.employeeName}`
    : `${totalAssets} asset(s) across ${groups.length} employees`);
  toast("Handover slip downloaded");
}

// `requestPrefill` (optional) is set when this is opened via an Approved Asset
// Request's "Assign Asset" button (§18) — {requestUid, requestId, employeeName,
// employeeCode, department, assetType, quantity}. It only applies to a brand-new
// assignment (uidVal null); on save, the created assignment gets stamped with
// sourceRequestId and the source request is flipped to Fulfilled — see
// fulfillRequestFromAssignment(), no separate assignment system involved.
function openAssignForm(uidVal, quickReturn, requestPrefill) {
  if (!requireAdminOrWarn()) return;
  const editing = uidVal ? DB.assignments.find(a => a.uid === uidVal) : null;
  const cats = DB.categories.map(c => c.name);
  const depts = DB.lists.department || [];
  const statuses = DB.lists.assignmentStatus || ["Assigned", "Returned", "Overdue"];
  const conditions = DB.lists.condition || ["New", "Good", "Fair", "Poor", "Damaged"];
  const outcomes = (DB.lists.status || []).filter(s => s !== "Assigned");
  const initialStatus = quickReturn ? "Returned" : (editing ? editing.status : "Assigned");
  const initialCondition = editing ? editing.returnCondition || "" : "";
  const initialOutcome = editing ? editing.returnOutcome || "" : "";

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
          ${cats.map(c => {
            const prefillItem = !editing && requestPrefill && (requestPrefill.items || []).find(i => i.assetType === c);
            const preChecked = !!prefillItem;
            return `
            <label class="asset-check-row">
              <input type="checkbox" class="f_asset_multi" value="${escapeHtml(c)}" ${preChecked ? "checked" : ""}>
              <span>${escapeHtml(c)}</span>
              <span class="qty-label">Qty</span>
              <input type="number" class="f_asset_qty" data-cat="${escapeHtml(c)}" min="1" step="1" value="${preChecked ? prefillItem.remaining : 1}" title="How many units of ${escapeHtml(c)} to log">
            </label>
          `;
          }).join("")}
        </div>
      </div>`;

  openModal(quickReturn ? "Return Asset" : (editing ? "Edit Assignment" : (requestPrefill ? `Fulfill Request ${requestPrefill.requestId || ""}` : "New Assignment")), `
    ${requestPrefill ? `<div class="viewer-note" style="border-color:var(--primary);"><span style="font-size:16px;">📋</span><div>Fulfilling <strong>${escapeHtml(requestPrefill.requestId || "")}</strong> for ${escapeHtml(requestPrefill.employeeName || "")} — tick whichever items you're actually giving now (adjust Qty if only some are in stock); leave the rest unticked and they'll stay Pending until you come back and assign them.</div></div>` : ""}
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
        <input type="text" id="f_emp" list="empList" value="${escapeHtml(editing ? editing.employeeName : (requestPrefill ? requestPrefill.employeeName || "" : ""))}" placeholder="Employee name, or a team/TL name like 'KYC Training'">
        <datalist id="empList">${DB.employees.map(e => `<option value="${escapeHtml(e.name)}">`).join("")}</datalist>
      </div>
      <div class="field"><label>Employee ID</label><input type="text" id="f_empid" value="${escapeHtml(editing ? editing.employeeId || "" : (requestPrefill ? requestPrefill.employeeCode || "" : ""))}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Department</label>
        <select id="f_dept"><option value="">—</option>${depts.map(d => `<option ${(editing ? editing.department === d : (requestPrefill && requestPrefill.department === d)) ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Assigned By</label><input type="text" id="f_by" value="${escapeHtml(editing ? editing.assignedBy || "" : (requestPrefill ? ((fauth.currentUser || {}).email || "") : ""))}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Status</label>
        <select id="f_status">${statuses.map(s => `<option ${s === initialStatus ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Return Date</label><input type="date" id="f_return" value="${quickReturn ? todayISO() : (editing ? editing.returnDate || "" : "")}"></div>
    </div>
    <div class="field-row" id="returnFieldsWrap" style="display:none">
      <div class="field"><label>Condition on Return</label>
        <select id="f_returnCondition"><option value="">—</option>${conditions.map(c => `<option ${c === initialCondition ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Outcome <span class="muted" style="font-weight:500;">(where it goes now)</span></label>
        <select id="f_returnOutcome">${outcomes.map(o => `<option ${o === initialOutcome ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field"><label>Remarks${quickReturn ? ` <span class="muted" style="font-weight:500;">(e.g. "screen cracked, not powering on")</span>` : ""}</label><textarea id="f_remarks" rows="2">${escapeHtml(editing ? editing.remarks || "" : "")}</textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">${quickReturn ? "Confirm Return" : (editing ? "Save Changes" : "Add Assignment")}</button>
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

    // The Condition/Outcome fields only matter once Status is "Returned" — keep
    // them hidden otherwise so the form doesn't ask irrelevant questions while
    // an asset is still just being assigned.
    const statusSel = document.getElementById("f_status");
    const returnFieldsWrap = document.getElementById("returnFieldsWrap");
    const conditionSel = document.getElementById("f_returnCondition");
    const outcomeSel = document.getElementById("f_returnOutcome");
    const syncReturnFieldsVisibility = () => {
      returnFieldsWrap.style.display = statusSel.value === "Returned" ? "" : "none";
    };
    statusSel.addEventListener("change", syncReturnFieldsVisibility);
    syncReturnFieldsVisibility();
    // Suggest an Outcome from the Condition picked, as a starting point the
    // admin is always free to override manually.
    let outcomeTouched = !!initialOutcome;
    outcomeSel.addEventListener("change", () => { outcomeTouched = true; });
    conditionSel.addEventListener("change", () => {
      if (outcomeTouched) return;
      const suggestion = suggestReturnOutcome(conditionSel.value);
      if ([...outcomeSel.options].some(o => o.value === suggestion)) outcomeSel.value = suggestion;
    });

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

      const statusVal = document.getElementById("f_status").value;
      if (statusVal === "Returned" && !document.getElementById("f_return").value) {
        toast("Return Date is required when Status is Returned", "err"); return;
      }
      const common = {
        date: document.getElementById("f_date").value,
        employeeName: empName,
        employeeId: document.getElementById("f_empid").value.trim(),
        department: document.getElementById("f_dept").value,
        assignedBy: document.getElementById("f_by").value.trim(),
        status: statusVal,
        returnDate: document.getElementById("f_return").value,
        returnCondition: statusVal === "Returned" ? document.getElementById("f_returnCondition").value : "",
        returnOutcome: statusVal === "Returned" ? document.getElementById("f_returnOutcome").value : "",
        remarks: document.getElementById("f_remarks").value.trim(),
      };

      let newRecords = [];
      if (editing) {
        const wasReturned = editing.status === "Returned";
        const rec = { ...common, assetName: document.getElementById("f_asset").value };
        Object.assign(editing, rec);
        saveRecord("assignments", editing);
        if (!wasReturned && editing.status === "Returned") {
          applyReturnSideEffects(editing);
          toast("Asset marked as returned");
        } else {
          logAction("Edited assignment", `${rec.assetName} → ${empName}`);
          toast("Assignment updated");
        }
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
              sourceRequestId: requestPrefill ? requestPrefill.requestId : "",
            };
            DB.assignments.push(newRec);
            newRecords.push(newRec);
          }
          summaryParts.push(qty > 1 ? `${assetName} × ${qty}` : assetName);
        });

        newRecords.forEach(r => saveRecord("assignments", r));
        saveMeta(); // persists the updated per-category tag-number counters
        logAction("Added assignment(s)", `${summaryParts.join(", ")} → ${empName}`);
        // Lets you backfill an asset you never logged an "Assigned" row for at
        // all — just add it here with Status already set to "Returned" (e.g. an
        // old phone someone's handing back, 1-2 years after the fact) and it
        // still gets a proper record + a Master Inventory entry created for it.
        if (common.status === "Returned") newRecords.forEach(r => applyReturnSideEffects(r));
        // Approved Asset Request → Assignment linkage (§18): rolls whatever was
        // actually ticked/given here into the source request's per-item progress
        // (Fulfilled once everything's given, Partially Fulfilled otherwise) —
        // fulfillRequestFromAssignment() shows its own toast for this case.
        if (requestPrefill && newRecords.length) {
          fulfillRequestFromAssignment(requestPrefill, picks, newRecords);
        } else {
          toast(newRecords.length > 1 ? `${newRecords.length} assignments added for ${empName}` : "Assignment added");
        }
      }
      closeModal();
      paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    };
  });
}

// Reverses fulfillRequestFromAssignment()'s bookkeeping when an Asset
// Assignment that came from a request gets deleted directly from the
// Assignment/Returns page — keeps the source request's Given counts and
// status honest instead of it staying stuck saying more was given than
// what's actually still on file. Mirror of the Request→Assignment cascade in
// deleteRequest(); this is the other direction (Assignment→Request).
function unlinkAssignmentsFromRequests(deletedAssignments) {
  const byRequestId = new Map();
  deletedAssignments.forEach(a => {
    if (!a.sourceRequestId) return;
    if (!byRequestId.has(a.sourceRequestId)) byRequestId.set(a.sourceRequestId, []);
    byRequestId.get(a.sourceRequestId).push(a);
  });
  byRequestId.forEach((removed, requestId) => {
    const rec = (DB.requests || []).find(r => r.requestId === requestId);
    if (!rec) return;
    const items = getRequestItems(rec);
    removed.forEach(a => {
      const item = items.find(i => i.assetType === a.assetName && (i.givenQuantity || 0) > 0);
      if (item) item.givenQuantity = Math.max(0, (item.givenQuantity || 0) - 1);
    });
    rec.items = items;
    const removedUids = new Set(removed.map(a => a.uid));
    rec.assignedUnits = (rec.assignedUnits || []).filter(u => !removedUids.has(u.assignmentUid));
    if (["Fulfilled", "Partially Fulfilled"].includes(rec.status)) {
      rec.status = items.some(i => (i.givenQuantity || 0) > 0) ? "Partially Fulfilled" : "Approved";
    }
    rec.updatedAt = nowISO();
    rec.history = [...(rec.history || []), {
      ts: nowISO(), email: (fauth.currentUser || {}).email || "", role: isAdmin() ? "admin" : "teamlead",
      action: "Linked assignment deleted", toStatus: rec.status,
      comment: removed.map(a => `${a.assetName}${a.assetTagNo ? ` (${a.assetTagNo})` : ""}`).join(", "),
    }];
    saveRecord("requests", rec);
  });
}

function deleteAssignment(uidVal) {
  if (!requireSuperAdminOrWarn()) return;
  const rec = DB.assignments.find(a => a.uid === uidVal);
  const desc = rec ? `<strong>${escapeHtml(rec.assetName)}</strong> assigned to <strong>${escapeHtml(rec.employeeName)}</strong>` : "this assignment";
  openModal("Delete assignment?", `
    <p class="muted" style="margin-top:0">Delete ${desc}? This action can't be undone.${rec && rec.sourceRequestId ? ` This will also update its linked Asset Request (${escapeHtml(rec.sourceRequestId)}) back to reflect it's no longer given.` : ""}</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.assignments = DB.assignments.filter(a => a.uid !== uidVal);
      assignSelected.delete(uidVal);
      if (rec) unlinkAssignmentsFromRequests([rec]);
      deleteRecord("assignments", uidVal); logAction("Deleted assignment", rec ? `${rec.assetName} — ${rec.employeeName}` : uidVal); closeModal(); toast("Assignment deleted"); paintAssignTable();
      if (currentPage === "assetRequests") renderAssetRequests();
      if (currentPage === "dashboard") renderDashboard();
    };
  });
}

// Reassign a previously-returned asset — still identified by its original
// Asset Tag — straight to a different employee, without minting a new tag or
// losing the return that came before it. Creates a brand-new "Assigned"
// record for the same physical unit, linked both ways to the record it came
// from (reassignedFromUid / reassignedToUid), so there's a proper, traceable
// handover history — this is why it must show up correctly, not a fresh
// assignment that looks unrelated to the return that preceded it.
function openReassignForm(returnedUidVal) {
  if (!requireAdminOrWarn()) return;
  const prev = DB.assignments.find(a => a.uid === returnedUidVal);
  if (!prev) { toast("Record not found", "err"); return; }
  if (prev.status !== "Returned") { toast("Only a returned asset can be reassigned", "err"); return; }
  const outcome = prev.returnOutcome || "Available";
  if (outcome !== "Available") { toast(`This asset is marked "${outcome}" — it can't be reassigned until it's back to Available`, "err"); return; }

  const depts = DB.lists.department || [];
  openModal(`Reassign ${prev.assetName}${prev.assetTagNo ? ` (${prev.assetTagNo})` : ""}`, `
    <div class="viewer-note" style="border-color:var(--primary);"><span style="font-size:16px;">🔁</span><div>Reassigning the <strong>same physical asset</strong>${prev.assetTagNo ? ` — tag <strong>${escapeHtml(prev.assetTagNo)}</strong>` : ""}, last returned by <strong>${escapeHtml(prev.employeeName)}</strong> on ${fmtDate(prev.returnDate || prev.date)}. This creates a new Assignment record and keeps the original return on file.</div></div>
    <div class="field"><label>Date</label><input type="date" id="rf_date" value="${todayISO()}"></div>
    <div class="field-row">
      <div class="field"><label>Employee / Recipient Name</label>
        <input type="text" id="rf_emp" list="rf_empList" placeholder="Employee name, or a team/TL name like 'KYC Training'">
        <datalist id="rf_empList">${DB.employees.map(e => `<option value="${escapeHtml(e.name)}">`).join("")}</datalist>
      </div>
      <div class="field"><label>Employee ID</label><input type="text" id="rf_empid"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Department</label>
        <select id="rf_dept"><option value="">—</option>${depts.map(d => `<option>${escapeHtml(d)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Assigned By</label><input type="text" id="rf_by" value="${escapeHtml((fauth.currentUser || {}).email || "")}"></div>
    </div>
    <div class="field"><label>Remarks <span class="muted" style="font-weight:500;">(optional — e.g. reason for reassigning)</span></label><textarea id="rf_remarks" rows="2"></textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="rf_cancel">Cancel</button>
      <button class="btn btn-primary" id="rf_save">Reassign Asset</button>
    </div>
  `, () => {
    document.getElementById("modal").classList.add("modal-wide");
    // Same "don't overwrite a field the admin already touched" autofill pattern
    // used by the main Assignment form.
    const empIdInput = document.getElementById("rf_empid");
    const deptSel = document.getElementById("rf_dept");
    let empIdTouched = false, deptTouched = false;
    empIdInput.addEventListener("input", () => { empIdTouched = true; });
    deptSel.addEventListener("change", () => { deptTouched = true; });
    const empInput = document.getElementById("rf_emp");
    const autofillFromName = () => {
      const typed = empInput.value.trim().toLowerCase();
      if (!typed) return;
      const match = DB.employees.find(e => (e.name || "").trim().toLowerCase() === typed);
      if (!match) return;
      if (!empIdTouched && match.id) empIdInput.value = match.id;
      if (!deptTouched && match.department && [...deptSel.options].some(o => o.value === match.department)) deptSel.value = match.department;
    };
    empInput.addEventListener("input", autofillFromName);
    empInput.addEventListener("change", autofillFromName);

    document.getElementById("rf_cancel").onclick = closeModal;
    document.getElementById("rf_save").onclick = () => {
      const empName = empInput.value.trim();
      if (!empName) { toast("Employee name is required", "err"); return; }
      const dateVal = document.getElementById("rf_date").value;
      if (!dateVal) { toast("Date is required", "err"); return; }
      if (empName.toLowerCase() === (prev.employeeName || "").trim().toLowerCase()) {
        toast("Pick a different recipient — this asset was already with them", "err"); return;
      }

      const newRec = {
        uid: uid(),
        id: DB.assignments.length + 1,
        createdAt: nowISO(),
        date: dateVal,
        employeeName: empName,
        employeeId: empIdInput.value.trim(),
        department: deptSel.value,
        assignedBy: document.getElementById("rf_by").value.trim(),
        status: "Assigned",
        returnDate: "", returnCondition: "", returnOutcome: "",
        remarks: document.getElementById("rf_remarks").value.trim(),
        assetName: prev.assetName,
        assetTagNo: prev.assetTagNo || "",
        sourceRequestId: "",
        reassignedFromUid: prev.uid,
        reassignedFromEmployee: prev.employeeName || "",
      };
      DB.assignments.push(newRec);
      saveRecord("assignments", newRec);

      // Leave a forward-pointer + note on the record it came from, so the
      // return stays on file but also shows exactly where the asset went next.
      prev.reassignedToUid = newRec.uid;
      prev.remarks = prev.remarks ? `${prev.remarks}\nReassigned to ${empName} on ${fmtDate(dateVal)}` : `Reassigned to ${empName} on ${fmtDate(dateVal)}`;
      saveRecord("assignments", prev);

      // The Master Inventory row auto-created when this asset was returned
      // needs to flip back to Assigned, or it keeps showing as available stock
      // that's actually back out with someone.
      if (newRec.assetTagNo) {
        const inv = DB.inventory.find(i => i.assetId === newRec.assetTagNo);
        if (inv) {
          inv.status = "Assigned";
          inv.assignedTo = empName;
          inv.department = deptSel.value || inv.department;
          saveRecord("inventory", inv);
        }
      }

      logAction("Reassigned asset", `${prev.assetName}${prev.assetTagNo ? ` (${prev.assetTagNo})` : ""} reassigned from ${prev.employeeName || "—"} to ${empName}`);
      toast(`${prev.assetName} reassigned to ${empName}`);
      closeModal();
      if (currentPage === "returns") paintReturnsTable();
      if (currentPage === "assignment") paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    };
  });
}

/* =========================================================
   ASSET RETURNS  (dedicated view over assignments where status = "Returned")
   ========================================================= */
let returnFilter = { q: "", condition: "", outcome: "", dept: "" };

function getReturnedAssignments() {
  return DB.assignments.filter(a => a.status === "Returned");
}
function returnSortKey(a) {
  return a.returnDate || a.date || "";
}
function sortReturnsNewestFirst(list) {
  return [...list].sort((a, b) => returnSortKey(b).localeCompare(returnSortKey(a)));
}
function computeReturnsSummary(records) {
  const s = { total: records.length, available: 0, underRepair: 0, faulty: 0, lost: 0, scrap: 0 };
  records.forEach(a => {
    const o = a.returnOutcome || "Available";
    if (o === "Available") s.available++;
    else if (o === "Under Repair") s.underRepair++;
    else if (o === "Faulty") s.faulty++;
    else if (o === "Lost") s.lost++;
    else if (o === "Scrap") s.scrap++;
  });
  return s;
}

function renderReturns() {
  const content = document.getElementById("content");
  const depts = DB.lists.department || [];
  const conditions = DB.lists.condition || [];
  const outcomes = (DB.lists.status || []).filter(s => s !== "Assigned");
  const all = getReturnedAssignments();
  const summary = computeReturnsSummary(all);

  content.innerHTML = `
    ${viewerNotice()}
    <div class="stat-grid" style="margin-bottom:18px">
      ${[
        { icon: "↩️", cls: "icon-purple", value: summary.total, label: "Total Returns" },
        { icon: "✅", cls: "icon-blue", value: summary.available, label: "Back to Available" },
        { icon: "🔧", cls: "icon-amber", value: summary.underRepair, label: "Under Repair" },
        { icon: "⚠️", cls: "icon-red", value: summary.faulty, label: "Faulty" },
        { icon: "🗑️", cls: "icon-grey", value: summary.lost + summary.scrap, label: "Lost / Scrap" },
      ].map(c => `
        <div class="stat-card">
          <div class="stat-top">
            <div class="stat-icon ${c.cls}">${c.icon}</div>
            <div class="stat-label">${c.label}</div>
          </div>
          <div class="stat-value">${c.value}</div>
        </div>
      `).join("")}
    </div>
    <div class="card">
      <div class="card-header">
        <div><h2>Asset Returns</h2><div class="sub" id="returnCountSub">${all.length} returned record${all.length === 1 ? "" : "s"}</div></div>
        <button class="btn btn-secondary btn-sm" id="exportReturnsBtn">⬇ Export Returns</button>
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="returnSearch" placeholder="Search employee, asset, remarks..." value="${escapeHtml(returnFilter.q)}" /></div>
        <select class="filter-select" id="returnConditionFilter">
          <option value="">All conditions</option>
          ${conditions.map(c => `<option value="${escapeHtml(c)}" ${returnFilter.condition === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
        </select>
        <select class="filter-select" id="returnOutcomeFilter">
          <option value="">All outcomes</option>
          ${outcomes.map(o => `<option value="${escapeHtml(o)}" ${returnFilter.outcome === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
        </select>
        <select class="filter-select" id="returnDeptFilter">
          <option value="">All departments</option>
          ${depts.map(d => `<option value="${escapeHtml(d)}" ${returnFilter.dept === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}
        </select>
        <button class="btn btn-secondary btn-sm" id="returnClearFiltersBtn" style="display:none">Clear filters</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Return Date</th><th>Asset</th><th>Asset Tag</th><th>Returned By</th><th>Dept</th>
          <th>Condition</th><th>Outcome</th><th>Remarks</th><th></th>
        </tr></thead>
        <tbody id="returnTbody"></tbody>
      </table></div>
    </div>
  `;

  document.getElementById("returnSearch").oninput = (e) => { returnFilter.q = e.target.value.toLowerCase(); paintReturnsTable(); };
  document.getElementById("returnConditionFilter").onchange = (e) => { returnFilter.condition = e.target.value; paintReturnsTable(); };
  document.getElementById("returnOutcomeFilter").onchange = (e) => { returnFilter.outcome = e.target.value; paintReturnsTable(); };
  document.getElementById("returnDeptFilter").onchange = (e) => { returnFilter.dept = e.target.value; paintReturnsTable(); };
  document.getElementById("returnClearFiltersBtn").onclick = () => {
    returnFilter = { q: "", condition: "", outcome: "", dept: "" };
    document.getElementById("returnSearch").value = "";
    document.getElementById("returnConditionFilter").value = "";
    document.getElementById("returnOutcomeFilter").value = "";
    document.getElementById("returnDeptFilter").value = "";
    paintReturnsTable();
  };
  document.getElementById("exportReturnsBtn").onclick = () => exportSheet("asset_returns", "Asset Returns", reportRows("returns"));

  paintReturnsTable();
}

function getFilteredReturns() {
  let rows = sortReturnsNewestFirst(getReturnedAssignments());
  if (returnFilter.q) {
    rows = rows.filter(a => [a.employeeName, a.assetName, a.remarks].join(" ").toLowerCase().includes(returnFilter.q));
  }
  if (returnFilter.condition) rows = rows.filter(a => a.returnCondition === returnFilter.condition);
  if (returnFilter.outcome) rows = rows.filter(a => (a.returnOutcome || "Available") === returnFilter.outcome);
  if (returnFilter.dept) rows = rows.filter(a => a.department === returnFilter.dept);
  return rows;
}

function paintReturnsTable() {
  const tbody = document.getElementById("returnTbody");
  if (!tbody) return;
  const rows = getFilteredReturns();
  const admin = isAdmin();
  const filterActive = !!(returnFilter.q || returnFilter.condition || returnFilter.outcome || returnFilter.dept);
  const all = getReturnedAssignments();

  const countSub = document.getElementById("returnCountSub");
  if (countSub) {
    countSub.textContent = filterActive
      ? `${rows.length} of ${all.length} returned records (filtered)`
      : `${all.length} returned record${all.length === 1 ? "" : "s"}`;
  }
  const clearBtn = document.getElementById("returnClearFiltersBtn");
  if (clearBtn) clearBtn.style.display = filterActive ? "" : "none";

  tbody.innerHTML = rows.length ? rows.map(a => `
    <tr>
      <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}</td>
      <td>${escapeHtml(a.assetName)}</td>
      <td>${a.assetTagNo ? `<span class="badge badge-grey">${escapeHtml(a.assetTagNo)}</span>` : "—"}</td>
      <td>${escapeHtml(a.employeeName)}</td>
      <td>${escapeHtml(a.department || "—")}</td>
      <td>${a.returnCondition ? conditionBadge(a.returnCondition) : "—"}</td>
      <td>${statusBadge(a.returnOutcome || "Available")}</td>
      <td>${escapeHtml(a.remarks || "—")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" title="Handover Slip (PDF)" aria-label="Generate handover slip for ${escapeHtml(a.employeeName)}" onclick="openHandoverSlip('${a.uid}')">📄</button>
          ${admin ? `
          ${(a.returnOutcome || "Available") === "Available" ? `<button class="btn btn-primary btn-sm btn-icon" title="Reassign to someone else" aria-label="Reassign ${escapeHtml(a.assetName)} to a different employee" onclick="openReassignForm('${a.uid}')">🔁</button>` : ""}
          <button class="btn btn-secondary btn-sm btn-icon" title="Edit" aria-label="Edit return for ${escapeHtml(a.employeeName)}" onclick="openAssignForm('${a.uid}')">✏️</button>
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" aria-label="Delete return for ${escapeHtml(a.employeeName)}" onclick="deleteAssignment('${a.uid}')">🗑️</button>` : ""}
          ` : ""}
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="9">${filterActive ? `No returns match your search/filters. <a href="#" id="returnEmptyClear" style="color:var(--primary);font-weight:600;">Clear filters</a>` : "No assets have been returned yet — use the ↩ Return button on Asset Assignment, or add a Returned record directly if you're backfilling an old asset."}</td></tr>`;

  const emptyClear = document.getElementById("returnEmptyClear");
  if (emptyClear) emptyClear.onclick = (e) => { e.preventDefault(); document.getElementById("returnClearFiltersBtn").click(); };
}

/* =========================================================
   ASSET REQUESTS
   Team Leads submit + track their own requests; Admins review, approve/reject,
   and convert an Approved request straight into a real Assignment (§18 — no
   separate/duplicate assignment system). Enforcement of who can do what lives
   in firestore.rules, not just here — this is the UI on top of that.
   ========================================================= */
const REQUEST_TYPES = [
  { value: "New Asset", icon: "🆕", desc: "A brand-new asset for an existing employee." },
  { value: "Asset Replacement", icon: "🔁", desc: "Swap out something damaged, faulty, or due for an upgrade." },
  { value: "New Employee – First-Time Asset Assignment", icon: "👋", desc: "First-time setup for someone who just joined." },
];
const REPLACEMENT_REASONS = ["Damaged", "Not Working", "Performance Issue", "Lost", "End of Life", "Upgrade Required", "Other"];

function getMyRequests() {
  const email = (fauth.currentUser || {}).email || "";
  return (DB.requests || []).filter(r => r.requestedBy === email);
}
function requestSortKey(r) { return r.updatedAt || r.createdAt || ""; }
function sortRequestsNewestFirst(list) {
  return [...list].sort((a, b) => requestSortKey(b).localeCompare(requestSortKey(a)));
}
function computeRequestsSummary(records) {
  const s = { total: records.length, pending: 0, approved: 0, rejected: 0, fulfilled: 0, urgent: 0 };
  records.forEach(r => {
    if (r.status === "Submitted" || r.status === "Under Review") s.pending++;
    else if (r.status === "Approved" || r.status === "Partially Fulfilled") s.approved++;
    else if (r.status === "Rejected") s.rejected++;
    else if (r.status === "Fulfilled") s.fulfilled++;
    if (r.priority === "Urgent" && REQUEST_ACTIVE_STATUSES.includes(r.status)) s.urgent++;
  });
  return s;
}
function requestStatCards(summary) {
  return [
    { icon: "📋", cls: "icon-blue", value: summary.total, label: "Total Requests" },
    { icon: "⏳", cls: "icon-amber", value: summary.pending, label: "Pending Review" },
    { icon: "✅", cls: "icon-purple", value: summary.approved, label: "Approved / Partial" },
    { icon: "✖️", cls: "icon-red", value: summary.rejected, label: "Rejected" },
    { icon: "🏁", cls: "icon-teal", value: summary.fulfilled, label: "Fulfilled" },
    { icon: "🔥", cls: "icon-grey", value: summary.urgent, label: "Urgent Requests" },
  ];
}
function renderStatGrid(cards) {
  return `<div class="stat-grid" style="margin-bottom:18px">${cards.map(c => `
    <div class="stat-card">
      <div class="stat-top"><div class="stat-icon ${c.cls}">${c.icon}</div><div class="stat-label">${c.label}</div></div>
      <div class="stat-value">${c.value}</div>
    </div>
  `).join("")}</div>`;
}

function renderAssetRequests() {
  if (!canOpenAssetRequests()) { goto("dashboard"); return; }
  if (isTeamLead()) return renderMyAssetRequests();
  return renderAdminAssetRequests();
}

/* ---------- Team Lead view: their own requests only ---------- */
function renderMyAssetRequests() {
  const content = document.getElementById("content");
  const mine = sortRequestsNewestFirst(getMyRequests());
  const summary = computeRequestsSummary(mine);

  content.innerHTML = `
    ${renderStatGrid(requestStatCards(summary))}
    <div class="card">
      <div class="card-header">
        <div><h2>My Asset Requests</h2><div class="sub" id="reqCountSub">${mine.length} request${mine.length === 1 ? "" : "s"}</div></div>
        <button class="btn btn-primary" id="newReqBtn">+ New Asset Request</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Request ID</th><th>Employee</th><th>Asset</th><th>Type</th><th>Priority</th><th>Status</th><th>Last Updated</th><th></th>
        </tr></thead>
        <tbody id="reqTbody"></tbody>
      </table></div>
    </div>
  `;
  document.getElementById("newReqBtn").onclick = () => openRequestForm();
  paintMyRequestsTable(mine);
}
function paintMyRequestsTable(mine) {
  const tbody = document.getElementById("reqTbody");
  if (!tbody) return;
  tbody.innerHTML = mine.length ? mine.map(r => `
    <tr>
      <td>${r.requestId ? `<span class="badge badge-grey">${escapeHtml(r.requestId)}</span>` : `<span class="muted">Draft</span>`}</td>
      <td>${escapeHtml(r.employeeName || "—")}</td>
      <td>${escapeHtml(requestItemsSummary(r))}</td>
      <td>${escapeHtml(r.requestType || "—")}</td>
      <td>${priorityBadge(r.priority)}</td>
      <td>${requestStatusBadge(r.status)}</td>
      <td>${fmtDate((r.updatedAt || r.createdAt || "").slice(0, 10))}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" title="View" aria-label="View request ${escapeHtml(r.requestId || "")}" onclick="openRequestDetail('${r.uid}')">👁️</button>
          ${["Draft", "Submitted"].includes(r.status) ? `<button class="btn btn-secondary btn-sm btn-icon" title="Edit" aria-label="Edit request ${escapeHtml(r.requestId || "")}" onclick="openRequestForm('${r.uid}')">✏️</button>` : ""}
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="8">No asset requests yet — click "+ New Asset Request" to submit one for your team.</td></tr>`;
}

/* ---------- Admin / Super Admin view: the full queue ---------- */
let requestFilter = { q: "", status: "", type: "", dept: "", assetType: "", priority: "", requestedBy: "", from: "", to: "" };
function getFilteredRequests() {
  let rows = sortRequestsNewestFirst(DB.requests || []);
  if (requestFilter.q) {
    const q = requestFilter.q;
    rows = rows.filter(r => [r.requestId, r.employeeName, r.employeeCode, requestItemsSummary(r), r.businessJustification].join(" ").toLowerCase().includes(q));
  }
  if (requestFilter.status) rows = rows.filter(r => r.status === requestFilter.status);
  if (requestFilter.type) rows = rows.filter(r => r.requestType === requestFilter.type);
  if (requestFilter.dept) rows = rows.filter(r => r.department === requestFilter.dept);
  if (requestFilter.assetType) rows = rows.filter(r => getRequestItems(r).some(i => i.assetType === requestFilter.assetType));
  if (requestFilter.priority) rows = rows.filter(r => r.priority === requestFilter.priority);
  if (requestFilter.requestedBy) rows = rows.filter(r => r.requestedBy === requestFilter.requestedBy);
  if (requestFilter.from) rows = rows.filter(r => (r.createdAt || "").slice(0, 10) >= requestFilter.from);
  if (requestFilter.to) rows = rows.filter(r => (r.createdAt || "").slice(0, 10) <= requestFilter.to);
  return rows;
}
function renderAdminAssetRequests() {
  const content = document.getElementById("content");
  const all = DB.requests || [];
  const summary = computeRequestsSummary(all);
  const depts = DB.lists.department || [];
  const cats = DB.categories.map(c => c.name);
  const requesters = [...new Set(all.map(r => r.requestedBy).filter(Boolean))].sort();
  const statuses = ["Draft", "Submitted", "Under Review", "Approved", "Partially Fulfilled", "Rejected", "Fulfilled", "Cancelled"];

  content.innerHTML = `
    ${viewerNotice()}
    ${renderStatGrid(requestStatCards(summary))}
    <div class="card">
      <div class="card-header">
        <div><h2>Asset Requests</h2><div class="sub" id="reqCountSub">${all.length} request${all.length === 1 ? "" : "s"}</div></div>
        <button class="btn btn-secondary btn-sm" id="exportReqBtn">⬇ Export Requests</button>
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="reqSearch" placeholder="Search request ID, employee, asset..." value="${escapeHtml(requestFilter.q)}"/></div>
        <select class="filter-select" id="reqStatusFilter"><option value="">All statuses</option>${statuses.map(s => `<option value="${escapeHtml(s)}" ${requestFilter.status === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select>
        <select class="filter-select" id="reqTypeFilter"><option value="">All request types</option>${REQUEST_TYPES.map(t => `<option value="${escapeHtml(t.value)}" ${requestFilter.type === t.value ? "selected" : ""}>${escapeHtml(t.value)}</option>`).join("")}</select>
        <select class="filter-select" id="reqDeptFilter"><option value="">All departments</option>${depts.map(d => `<option value="${escapeHtml(d)}" ${requestFilter.dept === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>
        <select class="filter-select" id="reqAssetTypeFilter"><option value="">All asset types</option>${cats.map(c => `<option value="${escapeHtml(c)}" ${requestFilter.assetType === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
        <select class="filter-select" id="reqPriorityFilter"><option value="">All priorities</option>${["Normal", "High", "Urgent"].map(p => `<option value="${p}" ${requestFilter.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select>
        <select class="filter-select" id="reqRequesterFilter"><option value="">All team leads</option>${requesters.map(e => `<option value="${escapeHtml(e)}" ${requestFilter.requestedBy === e ? "selected" : ""}>${escapeHtml(e)}</option>`).join("")}</select>
        <input type="date" class="filter-select" id="reqFromFilter" title="Created from" value="${escapeHtml(requestFilter.from)}">
        <input type="date" class="filter-select" id="reqToFilter" title="Created to" value="${escapeHtml(requestFilter.to)}">
        <button class="btn btn-secondary btn-sm" id="reqClearFiltersBtn" style="display:none">Clear filters</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Request ID</th><th>Requested By</th><th>Department</th><th>Employee</th><th>Employee Code</th>
          <th>Asset</th><th>Type</th><th>Priority</th><th>Requested</th><th>Status</th><th>Last Updated</th><th></th>
        </tr></thead>
        <tbody id="reqTbody"></tbody>
      </table></div>
    </div>
  `;

  document.getElementById("reqSearch").oninput = (e) => { requestFilter.q = e.target.value.toLowerCase(); paintAdminRequestsTable(); };
  document.getElementById("reqStatusFilter").onchange = (e) => { requestFilter.status = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqTypeFilter").onchange = (e) => { requestFilter.type = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqDeptFilter").onchange = (e) => { requestFilter.dept = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqAssetTypeFilter").onchange = (e) => { requestFilter.assetType = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqPriorityFilter").onchange = (e) => { requestFilter.priority = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqRequesterFilter").onchange = (e) => { requestFilter.requestedBy = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqFromFilter").onchange = (e) => { requestFilter.from = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqToFilter").onchange = (e) => { requestFilter.to = e.target.value; paintAdminRequestsTable(); };
  document.getElementById("reqClearFiltersBtn").onclick = () => {
    requestFilter = { q: "", status: "", type: "", dept: "", assetType: "", priority: "", requestedBy: "", from: "", to: "" };
    renderAdminAssetRequests();
  };
  document.getElementById("exportReqBtn").onclick = () => exportSheet("asset_requests", "Asset Requests", reportRows("requests"));

  paintAdminRequestsTable();
}
function paintAdminRequestsTable() {
  const tbody = document.getElementById("reqTbody");
  if (!tbody) return;
  const rows = getFilteredRequests();
  const all = DB.requests || [];
  const filterActive = Object.values(requestFilter).some(Boolean);

  const countSub = document.getElementById("reqCountSub");
  if (countSub) countSub.textContent = filterActive ? `${rows.length} of ${all.length} requests (filtered)` : `${all.length} request${all.length === 1 ? "" : "s"}`;
  const clearBtn = document.getElementById("reqClearFiltersBtn");
  if (clearBtn) clearBtn.style.display = filterActive ? "" : "none";

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${r.requestId ? `<span class="badge badge-grey">${escapeHtml(r.requestId)}</span>` : `<span class="muted">Draft</span>`}</td>
      <td>${escapeHtml(r.requestedBy || "—")}</td>
      <td>${escapeHtml(r.department || "—")}</td>
      <td>${escapeHtml(r.employeeName || "—")}${r.isNewEmployee ? ` <span class="badge badge-purple" style="margin-left:4px;">New</span>` : ""}</td>
      <td>${escapeHtml(r.employeeCode || "—")}</td>
      <td>${escapeHtml(requestItemsSummary(r))}</td>
      <td>${escapeHtml(r.requestType || "—")}</td>
      <td>${priorityBadge(r.priority)}</td>
      <td>${fmtDate((r.createdAt || "").slice(0, 10))}</td>
      <td>${requestStatusBadge(r.status)}</td>
      <td>${fmtDate((r.updatedAt || r.createdAt || "").slice(0, 10))}</td>
      <td><div class="row-actions">
        <button class="btn btn-secondary btn-sm btn-icon" title="View / Review" aria-label="Review request ${escapeHtml(r.requestId || "")}" onclick="openRequestDetail('${r.uid}')">👁️</button>
        ${["Approved", "Partially Fulfilled"].includes(r.status) ? `<button class="btn btn-primary btn-sm btn-icon" title="Assign Asset — creates the Asset Assignment record" aria-label="Assign asset for request ${escapeHtml(r.requestId || "")}" onclick="assignAssetForRequest('${r.uid}')">📦</button>` : ""}
        ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" aria-label="Delete request ${escapeHtml(r.requestId || "")}" onclick="deleteRequest('${r.uid}')">🗑️</button>` : ""}
      </div></td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="12">${filterActive ? `No requests match your filters. <a href="#" id="reqEmptyClear" style="color:var(--primary);font-weight:600;">Clear filters</a>` : "No asset requests submitted yet."}</td></tr>`;

  const emptyClear = document.getElementById("reqEmptyClear");
  if (emptyClear) emptyClear.onclick = (e) => { e.preventDefault(); document.getElementById("reqClearFiltersBtn").click(); };
}

// "Location" on the request form isn't typed in — it's whichever office the Team
// Lead currently has open (same {name, city} shown on the sidebar's office badge),
// since that already tells you where the employee/asset physically is.
function currentOfficeLocationLabel() {
  const o = OFFICES.find(o => o.id === currentOfficeId);
  if (!o) return "";
  return `${o.name}${o.city ? " · " + o.city : ""}`;
}

/* ---------- New / Edit Request form (progressive disclosure + review step) ---------- */
function openRequestForm(uidVal) {
  if (!canOpenAssetRequests()) { toast("Only Team Leads and Admins can do this", "err"); return; }
  const editing = uidVal ? DB.requests.find(r => r.uid === uidVal) : null;
  const myEmail = (fauth.currentUser || {}).email || "";
  if (editing && !isAdmin() && editing.requestedBy !== myEmail) { toast("You can only edit your own requests", "err"); return; }
  if (editing && !isAdmin() && !["Draft", "Submitted"].includes(editing.status)) { toast("This request can no longer be edited", "err"); return; }

  const vals = editing ? { ...editing, items: getRequestItems(editing).map(i => ({ ...i })) } : {
    department: "", isNewEmployee: false, employeeName: "", employeeCode: "", team: "", location: currentOfficeLocationLabel(),
    requestType: "New Asset", items: [],
    quantityReason: "", priority: "Normal", urgentReason: "",
    requiredBy: "", businessJustification: "", additionalInstructions: "", supportingNote: "",
    existingAssetId: "", existingAssetTag: "", existingAssetSerial: "",
    replacementReason: "", replacementReasonOther: "", currentCondition: "", issueDescription: "",
    joiningDate: "", expectedRequirementDate: "",
  };
  // Backfill Location on an older Draft that predates this field being auto-filled.
  if (editing && !vals.location) vals.location = currentOfficeLocationLabel();
  showRequestFormStep(vals, editing);
}

function showRequestFormStep(vals, editing) {
  openModal(editing ? `Edit Request${editing.requestId ? " — " + editing.requestId : ""}` : "New Asset Request",
    buildRequestFormHtml(vals, editing),
    () => wireRequestForm(vals, editing));
}

function buildRequestFormHtml(vals, editing) {
  const depts = DB.lists.department || [];
  const cats = DB.categories.map(c => c.name);
  const conditions = DB.lists.condition || [];
  const isReplacement = vals.requestType === "Asset Replacement";
  const isNewEmpType = vals.requestType === "New Employee – First-Time Asset Assignment";

  return `
    <div class="field"><label class="required">Team Lead Department</label>
      <select id="rf_dept"><option value="">—</option>${depts.map(d => `<option ${vals.department === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>
    </div>

    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;">
        <input type="checkbox" id="rf_newEmp" ${vals.isNewEmployee ? "checked" : ""}> This is a new employee not yet added to the system
      </label>
    </div>
    <div class="field-row">
      <div class="field"><label class="required">Employee Name</label>
        <input type="text" id="rf_emp" list="reqEmpList" value="${escapeHtml(vals.employeeName)}" placeholder="Start typing a name...">
        <datalist id="reqEmpList">${DB.employees.map(e => `<option value="${escapeHtml(e.name)}">`).join("")}</datalist>
      </div>
      <div class="field"><label>Employee Code</label><input type="text" id="rf_empCode" value="${escapeHtml(vals.employeeCode)}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Team <span class="muted" style="font-weight:500;" id="rf_teamSourceNote"></span></label>
        <input type="text" id="rf_team" list="rf_teamList" value="${escapeHtml(vals.team)}">
        <datalist id="rf_teamList">${distinctEmployeeTeams().map(t => `<option value="${escapeHtml(t)}">`).join("")}</datalist>
      </div>
      <div class="field"><label>Location</label><input type="text" id="rf_location" value="${escapeHtml(vals.location)}" readonly title="Auto-filled from your office — Settings > Switch Office to change it"></div>
    </div>

    <div class="field"><label class="required">What is the requirement?</label>
      <div class="request-type-cards" id="rf_typeCards">
        ${REQUEST_TYPES.map(t => `
          <label class="request-type-card ${vals.requestType === t.value ? "active" : ""}">
            <input type="radio" name="rf_type_radio" value="${escapeHtml(t.value)}" ${vals.requestType === t.value ? "checked" : ""}>
            <span class="request-type-card-icon">${t.icon}</span>
            <span class="request-type-card-title">${escapeHtml(t.value)}</span>
            <span class="request-type-card-desc">${escapeHtml(t.desc)}</span>
          </label>
        `).join("")}
      </div>
      <input type="hidden" id="rf_type" value="${escapeHtml(vals.requestType)}">
    </div>

    <div class="field">
      <label class="required">Assets Required <span class="muted" style="font-weight:500;">(tick one or more — an employee needing several things can go on the same request; set Qty for more than one of the same asset)</span></label>
      <div class="asset-multiselect" id="rf_assetMultiSelect">
        <div class="asset-multiselect-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="rf_assetSelectAll">Select All</button>
          <button type="button" class="btn btn-secondary btn-sm" id="rf_assetSelectNone">Clear</button>
        </div>
        ${cats.map(c => {
          const item = (vals.items || []).find(i => i.assetType === c);
          return `
          <label class="asset-check-row">
            <input type="checkbox" class="rf_asset_multi" value="${escapeHtml(c)}" ${item ? "checked" : ""}>
            <span>${escapeHtml(c)}</span>
            <span class="qty-label">Qty</span>
            <input type="number" class="rf_asset_qty" data-cat="${escapeHtml(c)}" min="1" max="10" step="1" value="${item ? item.quantity : 1}">
          </label>
        `;
        }).join("")}
        <label class="asset-check-row">
          <input type="checkbox" class="rf_asset_multi" value="Other" id="rf_asset_other_ck" ${(vals.items || []).some(i => i.assetType === "Other") ? "checked" : ""}>
          <span>Other</span>
          <span class="qty-label">Qty</span>
          <input type="number" class="rf_asset_qty" data-cat="Other" min="1" max="10" step="1" value="${((vals.items || []).find(i => i.assetType === "Other") || {}).quantity || 1}">
        </label>
      </div>
    </div>
    <div class="field" id="rf_otherAssetTypeWrap" style="display:none"><label class="required">Describe the "Other" asset needed</label><input type="text" id="rf_otherAssetType" value="${escapeHtml(((vals.items || []).find(i => i.assetType === "Other") || {}).otherAssetType || "")}"></div>
    <div class="field" id="rf_qtyReasonWrap" style="display:none"><label class="required">Why more than one of the same asset?</label><textarea id="rf_qtyReason" rows="2">${escapeHtml(vals.quantityReason)}</textarea></div>

    <div class="field"><label class="required">Priority</label>
      <select id="rf_priority">${["Normal", "High", "Urgent"].map(p => `<option ${vals.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select>
    </div>
    <div class="field" id="rf_urgentReasonWrap" style="display:none"><label class="required">Why is this urgent?</label><textarea id="rf_urgentReason" rows="2">${escapeHtml(vals.urgentReason)}</textarea></div>

    <div class="field"><label class="required">Required By</label><input type="date" id="rf_requiredBy" min="${todayISO()}" value="${escapeHtml(vals.requiredBy)}"></div>

    <div class="field-row" id="rf_replacementBlock" style="display:${isReplacement ? "" : "none"}">
      <div class="field"><label class="required">Existing Asset ID</label><input type="text" id="rf_exAssetId" value="${escapeHtml(vals.existingAssetId)}"></div>
      <div class="field"><label>Existing Serial / Asset Tag</label><input type="text" id="rf_exAssetTag" value="${escapeHtml(vals.existingAssetTag)}"></div>
    </div>
    <div class="field-row" id="rf_replacementBlock2" style="display:${isReplacement ? "" : "none"}">
      <div class="field"><label class="required">Reason for Replacement</label>
        <select id="rf_replReason"><option value="">—</option>${REPLACEMENT_REASONS.map(r => `<option ${vals.replacementReason === r ? "selected" : ""}>${r}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Current Condition</label>
        <select id="rf_currentCondition"><option value="">—</option>${conditions.map(c => `<option ${vals.currentCondition === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field" id="rf_replReasonOtherWrap" style="display:none">
      <label class="required">Describe the reason</label><input type="text" id="rf_replReasonOther" value="${escapeHtml(vals.replacementReasonOther)}">
    </div>
    <div class="field" id="rf_issueDescWrap" style="display:${isReplacement ? "" : "none"}">
      <label class="required">Issue Description</label><textarea id="rf_issueDesc" rows="2">${escapeHtml(vals.issueDescription)}</textarea>
    </div>

    <div class="field-row" id="rf_newEmpBlock" style="display:${isNewEmpType ? "" : "none"}">
      <div class="field"><label class="required">Joining Date</label><input type="date" id="rf_joiningDate" value="${escapeHtml(vals.joiningDate)}"></div>
      <div class="field"><label>Expected Requirement Date</label><input type="date" id="rf_expectedDate" min="${todayISO()}" value="${escapeHtml(vals.expectedRequirementDate)}"></div>
    </div>

    <div class="field"><label class="required">Requirement Details / Business Justification</label>
      <div class="muted" style="margin-bottom:6px;font-weight:500;">Please provide complete details explaining why this asset is required. Include any specific configuration, business requirement, replacement reason, or other information that may help Admin process the request.</div>
      <textarea id="rf_justification" rows="3">${escapeHtml(vals.businessJustification)}</textarea>
    </div>
    <div class="field"><label>Additional Instructions / Special Requirement</label><textarea id="rf_instructions" rows="2">${escapeHtml(vals.additionalInstructions)}</textarea></div>
    <div class="field"><label>Supporting Evidence <span class="muted" style="font-weight:500;">(describe or link a photo/document — direct file upload isn't available yet)</span></label><textarea id="rf_supportNote" rows="2">${escapeHtml(vals.supportingNote)}</textarea></div>

    <div class="form-actions">
      <button class="btn btn-secondary" id="rf_cancelBtn">Cancel</button>
      ${!editing || editing.status === "Draft" ? `<button class="btn btn-secondary" id="rf_draftBtn">Save as Draft</button>` : ""}
      <button class="btn btn-primary" id="rf_reviewBtn">Continue to Review</button>
    </div>
  `;
}

function readRequestFormValues(vals) {
  const g = id => document.getElementById(id);
  vals.department = g("rf_dept").value;
  vals.isNewEmployee = g("rf_newEmp").checked;
  vals.employeeName = g("rf_emp").value.trim();
  vals.employeeCode = vals.isNewEmployee ? "" : g("rf_empCode").value.trim();
  vals.team = g("rf_team").value.trim();
  vals.location = g("rf_location").value.trim();
  vals.requestType = g("rf_type").value;
  const otherDesc = g("rf_otherAssetType").value.trim();
  vals.items = [...document.querySelectorAll(".rf_asset_multi:checked")].map(cb => {
    const qtyInput = document.querySelector(`.rf_asset_qty[data-cat="${CSS.escape(cb.value)}"]`);
    const quantity = Math.max(1, Math.min(10, Math.floor(Number(qtyInput?.value) || 1)));
    return { assetType: cb.value, otherAssetType: cb.value === "Other" ? otherDesc : "", quantity, givenQuantity: 0 };
  });
  vals.quantityReason = g("rf_qtyReason").value.trim();
  vals.priority = g("rf_priority").value;
  vals.urgentReason = g("rf_urgentReason").value.trim();
  vals.requiredBy = g("rf_requiredBy").value;
  vals.businessJustification = g("rf_justification").value.trim();
  vals.additionalInstructions = g("rf_instructions").value.trim();
  vals.supportingNote = g("rf_supportNote").value.trim();
  vals.existingAssetId = g("rf_exAssetId").value.trim();
  vals.existingAssetTag = g("rf_exAssetTag").value.trim();
  vals.existingAssetSerial = "";
  vals.replacementReason = g("rf_replReason").value;
  vals.replacementReasonOther = g("rf_replReasonOther").value.trim();
  vals.currentCondition = g("rf_currentCondition").value;
  vals.issueDescription = g("rf_issueDesc").value.trim();
  vals.joiningDate = g("rf_joiningDate").value;
  vals.expectedRequirementDate = g("rf_expectedDate").value;
  return vals;
}

function validateRequestForm(vals) {
  if (!vals.department) return "Team Lead Department is required";
  if (!vals.employeeName) return "Employee Name is required";
  if (!vals.requestType) return "Select what the requirement is";
  if (!vals.items || !vals.items.length) return "Tick at least one asset";
  const otherItem = vals.items.find(i => i.assetType === "Other");
  if (otherItem && !otherItem.otherAssetType) return 'Describe the "Other" asset needed';
  if (vals.items.some(i => i.quantity > 1) && !vals.quantityReason) return "Explain why more than one of the same asset is needed";
  if (!vals.priority) return "Priority is required";
  if (vals.priority === "Urgent" && !vals.urgentReason) return "Explain why this is urgent";
  if (!vals.requiredBy) return "Required By date is required";
  if (vals.requestType === "Asset Replacement") {
    if (!vals.existingAssetId) return "Existing Asset ID is required for a replacement";
    if (!vals.replacementReason) return "Reason for Replacement is required";
    if (vals.replacementReason === "Other" && !vals.replacementReasonOther) return "Describe the replacement reason";
    if (!vals.issueDescription) return "Issue Description is required for a replacement";
  }
  if (vals.requestType === "New Employee – First-Time Asset Assignment" && !vals.joiningDate) return "Joining Date is required";
  if (!vals.businessJustification) return "Business Justification is required";
  return null;
}

function wireRequestForm(vals, editing) {
  const g = id => document.getElementById(id);
  document.getElementById("modal").classList.add("modal-wide");

  const newEmpCk = g("rf_newEmp");
  const empInput = g("rf_emp");
  const empCodeInput = g("rf_empCode");
  const syncNewEmpMode = () => {
    if (newEmpCk.checked) {
      empInput.removeAttribute("list");
      empCodeInput.value = "";
      empCodeInput.disabled = true;
      empCodeInput.placeholder = "Not yet assigned";
    } else {
      empInput.setAttribute("list", "reqEmpList");
      empCodeInput.disabled = false;
      empCodeInput.placeholder = "";
    }
  };
  newEmpCk.addEventListener("change", syncNewEmpMode);
  syncNewEmpMode();

  // Autofill Employee Code / Department from a matched Employee record — same
  // "touched" pattern as the Assignment form (js/app.js openAssignForm), so it
  // never clobbers something the Team Lead already typed themselves.
  const deptSel = g("rf_dept");
  let empCodeTouched = !!empCodeInput.value.trim();
  let deptTouched = !!deptSel.value;
  empCodeInput.addEventListener("input", () => { empCodeTouched = true; });
  deptSel.addEventListener("change", () => { deptTouched = true; });
  const autofillFromEmployee = () => {
    if (newEmpCk.checked) return;
    const typed = empInput.value.trim().toLowerCase();
    if (!typed) return;
    const match = DB.employees.find(e => (e.name || "").trim().toLowerCase() === typed);
    if (!match) return;
    if (!empCodeTouched && match.id) empCodeInput.value = match.id;
    if (!deptTouched && match.department && [...deptSel.options].some(o => o.value === match.department)) {
      deptSel.value = match.department;
    }
  };
  empInput.addEventListener("input", autofillFromEmployee);
  empInput.addEventListener("change", autofillFromEmployee);
  if (!editing) autofillFromEmployee();

  // Team is different: the Employee Database is the master for it. If the
  // matched employee already has a Team on file, the field is LOCKED to that
  // value — no touched-pattern, no "keep what I typed" exception — because
  // the whole point is a Team Lead can never accidentally (or deliberately)
  // change someone's master Team from this form. Only when the master has no
  // Team yet does the field open up for manual entry, clearly labeled as such
  // (see ensureEmployeeExists() for where that manual value gets saved back —
  // only ever filling in a blank, never overwriting).
  const teamInput = g("rf_team");
  const teamNote = g("rf_teamSourceNote");
  const syncTeamLock = () => {
    const typed = empInput.value.trim().toLowerCase();
    const match = !newEmpCk.checked && typed ? DB.employees.find(e => (e.name || "").trim().toLowerCase() === typed) : null;
    const masterTeam = match ? (match.team || "").trim() : "";
    if (masterTeam) {
      teamInput.value = masterTeam;
      teamInput.readOnly = true;
      teamInput.removeAttribute("list");
      teamNote.textContent = "🔒 From Employee Master — can't be changed here";
      teamNote.style.color = "var(--primary)";
    } else {
      teamInput.readOnly = false;
      teamInput.setAttribute("list", "rf_teamList");
      // Spelled out with the live employee count + a close-spelling hint so a
      // "no match" is immediately tellable apart from "data hasn't loaded" —
      // the two used to look identical, which is exactly what caused the
      // last confusing report.
      if (match) {
        teamNote.textContent = "✏️ Not in Employee Master yet — enter manually";
      } else if (typed) {
        const close = DB.employees.find(e => (e.name || "").toLowerCase().includes(typed) || typed.includes((e.name || "").toLowerCase()));
        teamNote.textContent = `✏️ No exact match for "${empInput.value.trim()}" in Employee Master (${DB.employees.length} on file)`
          + (close ? ` — did you mean "${close.name}"?` : " — check the spelling on the Employees page, or tick \"new employee\" above");
      } else {
        teamNote.textContent = "✏️ Manual entry";
      }
      teamNote.style.color = "";
    }
  };
  empInput.addEventListener("input", syncTeamLock);
  empInput.addEventListener("change", syncTeamLock);
  newEmpCk.addEventListener("change", syncTeamLock);
  syncTeamLock();

  const typeCards = [...document.querySelectorAll("#rf_typeCards .request-type-card")];
  const typeHidden = g("rf_type");
  const replReasonSel = g("rf_replReason");
  const syncReplReasonOther = () => {
    const wrap = g("rf_replReasonOtherWrap");
    wrap.style.display = (typeHidden.value === "Asset Replacement" && replReasonSel.value === "Other") ? "" : "none";
  };
  const syncTypeBlocks = () => {
    const t = typeHidden.value;
    typeCards.forEach(card => card.classList.toggle("active", card.querySelector("input").value === t));
    const isReplacement = t === "Asset Replacement";
    const isNewEmpType = t === "New Employee – First-Time Asset Assignment";
    g("rf_replacementBlock").style.display = isReplacement ? "" : "none";
    g("rf_replacementBlock2").style.display = isReplacement ? "" : "none";
    g("rf_issueDescWrap").style.display = isReplacement ? "" : "none";
    g("rf_newEmpBlock").style.display = isNewEmpType ? "" : "none";
    syncReplReasonOther();
  };
  typeCards.forEach(card => {
    const radio = card.querySelector("input");
    radio.addEventListener("change", () => { typeHidden.value = radio.value; syncTypeBlocks(); });
  });
  replReasonSel.addEventListener("change", syncReplReasonOther);
  syncTypeBlocks();

  // Multi-asset checklist — same tick-a-category + per-category Qty pattern as
  // the Assignment form's own multiselect (openAssignForm), reused here so a
  // Team Lead can put everything one employee needs (laptop + mouse + bag, say)
  // on a single request instead of filing one request per asset.
  const assetChecks = [...document.querySelectorAll(".rf_asset_multi")];
  const otherWrap = g("rf_otherAssetTypeWrap");
  const qtyReasonWrap = g("rf_qtyReasonWrap");
  const syncAssetChecks = () => {
    const otherCk = g("rf_asset_other_ck");
    otherWrap.style.display = otherCk.checked ? "" : "none";
    const anyMultiQty = assetChecks.some(cb => {
      if (!cb.checked) return false;
      const qtyInput = document.querySelector(`.rf_asset_qty[data-cat="${CSS.escape(cb.value)}"]`);
      return Number(qtyInput?.value) > 1;
    });
    qtyReasonWrap.style.display = anyMultiQty ? "" : "none";
  };
  assetChecks.forEach(cb => cb.addEventListener("change", syncAssetChecks));
  document.querySelectorAll(".rf_asset_qty").forEach(inp => inp.addEventListener("input", syncAssetChecks));
  syncAssetChecks();
  const selAllBtn = g("rf_assetSelectAll");
  if (selAllBtn) selAllBtn.onclick = () => { assetChecks.forEach(cb => cb.checked = true); syncAssetChecks(); };
  const selNoneBtn = g("rf_assetSelectNone");
  if (selNoneBtn) selNoneBtn.onclick = () => { assetChecks.forEach(cb => cb.checked = false); syncAssetChecks(); };

  const prioritySel = g("rf_priority");
  const urgentWrap = g("rf_urgentReasonWrap");
  const syncPriority = () => { urgentWrap.style.display = prioritySel.value === "Urgent" ? "" : "none"; };
  prioritySel.addEventListener("change", syncPriority);
  syncPriority();

  g("rf_cancelBtn").onclick = closeModal;
  const draftBtn = g("rf_draftBtn");
  if (draftBtn) draftBtn.onclick = () => {
    readRequestFormValues(vals);
    if (!vals.employeeName) { toast("Employee Name is required, even for a draft", "err"); return; }
    // Disabled for the duration of the save so an impatient extra click can't
    // fire a second write on top of the first one.
    draftBtn.disabled = true;
    const label = draftBtn.textContent;
    draftBtn.textContent = "Saving…";
    submitRequestForm(vals, editing, "Draft").finally(() => { draftBtn.disabled = false; draftBtn.textContent = label; });
  };
  g("rf_reviewBtn").onclick = () => {
    readRequestFormValues(vals);
    const err = validateRequestForm(vals);
    if (err) { toast(err, "err"); return; }
    showRequestReviewStep(vals, editing);
  };
}

/* ---------- Duplicate-request detection (§19) ---------- */
// Checks every ticked asset type against every other active request/assignment
// for the same employee — one match anywhere in the list is enough to warn.
function findActiveDuplicateRequest(employeeName, items, excludeUid) {
  const name = (employeeName || "").trim().toLowerCase();
  const types = new Set((items || []).map(i => i.assetType));
  if (!name || !types.size) return null;
  return (DB.requests || []).find(r => r.uid !== excludeUid && REQUEST_ACTIVE_STATUSES.includes(r.status)
    && (r.employeeName || "").trim().toLowerCase() === name
    && getRequestItems(r).some(i => types.has(i.assetType))) || null;
}
function findActiveAssetOfType(employeeName, items) {
  const name = (employeeName || "").trim().toLowerCase();
  const types = new Set((items || []).map(i => i.assetType));
  if (!name || !types.size) return null;
  return DB.assignments.find(a => a.status === "Assigned" && (a.employeeName || "").trim().toLowerCase() === name && types.has(a.assetName)) || null;
}

function showRequestReviewStep(vals, editing) {
  const dup = findActiveDuplicateRequest(vals.employeeName, vals.items, editing ? editing.uid : null);
  const dupAsset = vals.requestType !== "Asset Replacement" ? findActiveAssetOfType(vals.employeeName, vals.items) : null;
  const warn = dup
    ? `An active request for ${escapeHtml(vals.employeeName)} already covers one of these asset types (${dup.requestId ? escapeHtml(dup.requestId) : "Draft"}, ${requestStatusBadge(dup.status)}).`
    : (dupAsset ? `${escapeHtml(vals.employeeName)} already has an active ${escapeHtml(dupAsset.assetName)} assignment${dupAsset.assetTagNo ? ` (${escapeHtml(dupAsset.assetTagNo)})` : ""}.` : "");
  const blockForNonAdmin = !!warn && !isAdmin();

  document.getElementById("modalTitle").textContent = "Review Your Request";
  document.getElementById("modalBody").innerHTML = `
    ${warn ? `
      <div class="viewer-note" style="align-items:flex-start;border-color:var(--red);background:var(--red-light);">
        <span style="font-size:16px;">⚠️</span>
        <div>
          <strong>Possible duplicate</strong>
          <div style="margin-top:2px;">${warn}</div>
          ${isAdmin()
            ? `<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-weight:600;cursor:pointer;"><input type="checkbox" id="rf_dupOverride"> Submit anyway</label>`
            : `<div class="muted" style="margin-top:6px;">Resolve or cancel the existing request before submitting a new one.</div>`}
        </div>
      </div>
    ` : ""}
    <div class="table-wrap"><table>
      <tbody>
        <tr><th>Employee</th><td>${escapeHtml(vals.employeeName)}${vals.isNewEmployee ? ` <span class="badge badge-purple">New Employee</span>` : ""}</td></tr>
        <tr><th>Employee Code</th><td>${escapeHtml(vals.employeeCode || "—")}</td></tr>
        <tr><th>Department</th><td>${escapeHtml(vals.department)}</td></tr>
        <tr><th>Team</th><td>${escapeHtml(vals.team || "—")}${vals.team ? ` ${(DB.employees.find(e => (e.name || "").trim().toLowerCase() === (vals.employeeName || "").trim().toLowerCase()) || {}).team ? '<span class="badge badge-purple" title="From Employee Master">📋 Master</span>' : '<span class="badge badge-grey" title="Not in Employee Master">✏️ Manual</span>'}` : ""}</td></tr>
        <tr><th>Assets Required</th><td>${(vals.items || []).map(i => `${escapeHtml(requestItemLabel(i))}${i.quantity > 1 ? ` × ${i.quantity}` : ""}`).join("<br>") || "—"}${vals.quantityReason ? `<div class="muted" style="margin-top:4px;">${escapeHtml(vals.quantityReason)}</div>` : ""}</td></tr>
        <tr><th>Request Type</th><td>${escapeHtml(vals.requestType)}</td></tr>
        <tr><th>Priority</th><td>${priorityBadge(vals.priority)}${vals.urgentReason ? ` — ${escapeHtml(vals.urgentReason)}` : ""}</td></tr>
        <tr><th>Required By</th><td>${fmtDate(vals.requiredBy)}</td></tr>
        ${vals.requestType === "Asset Replacement" ? `
        <tr><th>Existing Asset</th><td>${escapeHtml(vals.existingAssetId)}${vals.existingAssetTag ? ` (${escapeHtml(vals.existingAssetTag)})` : ""}</td></tr>
        <tr><th>Reason</th><td>${escapeHtml(vals.replacementReason === "Other" ? vals.replacementReasonOther : vals.replacementReason)} — ${escapeHtml(vals.issueDescription)}</td></tr>
        ` : ""}
        ${vals.requestType === "New Employee – First-Time Asset Assignment" ? `<tr><th>Joining Date</th><td>${fmtDate(vals.joiningDate)}</td></tr>` : ""}
        <tr><th>Justification</th><td>${escapeHtml(vals.businessJustification)}</td></tr>
        ${vals.additionalInstructions ? `<tr><th>Additional Instructions</th><td>${escapeHtml(vals.additionalInstructions)}</td></tr>` : ""}
      </tbody>
    </table></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="rf_backBtn">Back to Edit</button>
      <button class="btn btn-primary" id="rf_submitBtn" ${blockForNonAdmin ? "disabled" : ""}>Submit Request</button>
    </div>
  `;
  document.getElementById("modal").classList.add("modal-wide");
  document.getElementById("rf_backBtn").onclick = () => showRequestFormStep(vals, editing);
  const submitBtn = document.getElementById("rf_submitBtn");
  const overrideCk = document.getElementById("rf_dupOverride");
  if (overrideCk) overrideCk.addEventListener("change", () => { submitBtn.disabled = !!warn && !overrideCk.checked; });
  submitBtn.onclick = () => {
    // Disabled for the duration of the submit so a repeated/impatient click
    // can't fire a second overlapping write against the shared Request ID
    // counter — that's exactly what turns one contention hiccup into a storm.
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    submitRequestForm(vals, editing, "Submitted").finally(() => {
      submitBtn.disabled = !!warn && !(overrideCk && overrideCk.checked);
      submitBtn.textContent = "Submit Request";
    });
  };
}

async function submitRequestForm(vals, editing, targetStatus) {
  const myEmail = (fauth.currentUser || {}).email || "";
  const nowIso = nowISO();
  const isNewRecord = !editing;
  const rec = editing ? editing : {
    uid: uid(), requestId: "", requestedBy: myEmail,
    requestedByRole: isAdmin() ? "admin" : "teamlead",
    createdAt: nowIso, history: [],
  };
  const wasStatus = rec.status || null;

  // Employee Database is the master for Team — resolved here, not trusted from
  // the form, so a stale/tampered vals.team can never overwrite an existing
  // master value: if the matched employee already has a Team on file, THAT is
  // what gets stored on the request, full stop; only when the master has none
  // does the manually-entered value get used (and it's a "manual" source, not
  // silently treated as authoritative).
  const matchedEmp = !vals.isNewEmployee
    ? DB.employees.find(e => (e.name || "").trim().toLowerCase() === (vals.employeeName || "").trim().toLowerCase())
    : null;
  const masterTeam = matchedEmp ? (matchedEmp.team || "").trim() : "";
  const resolvedTeam = masterTeam || (vals.team || "").trim();
  const teamSource = masterTeam ? "master" : (resolvedTeam ? "manual" : "");

  Object.assign(rec, {
    department: vals.department,
    isNewEmployee: !!vals.isNewEmployee,
    employeeName: vals.employeeName,
    employeeCode: vals.isNewEmployee ? "" : vals.employeeCode,
    team: resolvedTeam, teamSource, location: vals.location,
    requestType: vals.requestType,
    items: vals.items || [],
    quantityReason: (vals.items || []).some(i => i.quantity > 1) ? vals.quantityReason : "",
    priority: vals.priority, urgentReason: vals.priority === "Urgent" ? vals.urgentReason : "",
    requiredBy: vals.requiredBy,
    businessJustification: vals.businessJustification,
    additionalInstructions: vals.additionalInstructions,
    supportingNote: vals.supportingNote,
    existingAssetId: vals.requestType === "Asset Replacement" ? vals.existingAssetId : "",
    existingAssetTag: vals.requestType === "Asset Replacement" ? vals.existingAssetTag : "",
    existingAssetSerial: "",
    replacementReason: vals.requestType === "Asset Replacement" ? vals.replacementReason : "",
    replacementReasonOther: (vals.requestType === "Asset Replacement" && vals.replacementReason === "Other") ? vals.replacementReasonOther : "",
    currentCondition: vals.requestType === "Asset Replacement" ? vals.currentCondition : "",
    issueDescription: vals.requestType === "Asset Replacement" ? vals.issueDescription : "",
    joiningDate: vals.requestType === "New Employee – First-Time Asset Assignment" ? vals.joiningDate : "",
    expectedRequirementDate: vals.requestType === "New Employee – First-Time Asset Assignment" ? vals.expectedRequirementDate : "",
    updatedAt: nowIso,
  });
  rec.status = targetStatus;

  if (targetStatus === "Submitted" && !rec.requestId) {
    try {
      rec.requestId = await nextRequestId();
    } catch (err) {
      console.error(err);
      const code = err && err.code;
      const msg = code === "resource-exhausted"
        ? "Firestore's quota has been hit for now — this usually means the project's daily free-tier limit, not a busy moment. Retrying won't help immediately; tell your Admin to check Firebase Console → Usage and billing."
        : code === "aborted"
        ? "Another submission landed at the exact same moment — please try again."
        : code === "permission-denied"
        ? "You don't have permission to submit this — ask an Admin to check your access"
        : "Couldn't reserve a Request ID — check your connection and try again";
      toast(msg, "err");
      return;
    }
  }

  // Auto-add a not-yet-registered employee the moment the request is actually
  // Submitted (not on every Draft save) — Team Leads get CREATE-only rights on
  // Employees in firestore.rules specifically for this. See ensureEmployeeExists().
  const addedEmployee = targetStatus === "Submitted" ? ensureEmployeeExists(rec) : null;

  rec.history = [...(rec.history || []), {
    ts: nowIso, email: myEmail, role: isAdmin() ? "admin" : "teamlead",
    action: targetStatus === "Draft" ? (isNewRecord ? "Created draft" : "Updated draft") : "Submitted",
    fromStatus: wasStatus, toStatus: targetStatus, comment: "",
  }];

  if (isNewRecord) DB.requests.push(rec);
  saveRecord("requests", rec);
  logAction(targetStatus === "Draft" ? "Saved asset request draft" : "Submitted asset request",
    `${rec.requestId || "(draft)"} — ${requestItemsSummary(rec)} for ${rec.employeeName}`);
  closeModal();
  toast(targetStatus === "Draft" ? "Draft saved"
    : addedEmployee ? `Request ${rec.requestId} submitted — added ${addedEmployee.name} to Employees`
    : `Request ${rec.requestId} submitted`);
  if (currentPage === "assetRequests") renderAssetRequests();
  if (currentPage === "dashboard") renderDashboard();
}

/* ---------- Admin review workflow (also used by Team Leads to view their own) ---------- */
function openRequestDetail(uidVal) {
  const rec = DB.requests.find(r => r.uid === uidVal);
  if (!rec) { toast("Request not found", "err"); return; }
  const myEmail = (fauth.currentUser || {}).email || "";
  const mine = rec.requestedBy === myEmail;
  if (!isAdmin() && !mine) { toast("You can only view your own requests", "err"); return; }
  const admin = isAdmin();
  const history = rec.history || [];

  // Team conflict detection (§4/§5 of the Team master-data spec): compare what's
  // stored on this request against the employee's CURRENT master Team — the
  // form locks the field to master at submit time, so a mismatch here can only
  // mean the master changed *after* this request was made. Never auto-resolved.
  const teamMatchedEmp = DB.employees.find(e => (e.name || "").trim().toLowerCase() === (rec.employeeName || "").trim().toLowerCase());
  const currentMasterTeam = teamMatchedEmp ? (teamMatchedEmp.team || "").trim() : "";
  const recTeam = (rec.team || "").trim();
  const teamConflict = !!(currentMasterTeam && recTeam && currentMasterTeam !== recTeam);

  const actionButtons = [];
  if (admin) {
    if (["Submitted", "Draft"].includes(rec.status)) actionButtons.push(`<button class="btn btn-secondary" id="rd_reviewBtn">Start Review</button>`);
    if (["Submitted", "Under Review", "Draft"].includes(rec.status)) {
      actionButtons.push(`<button class="btn btn-danger" id="rd_rejectBtn">Reject</button>`);
      actionButtons.push(`<button class="btn btn-primary" id="rd_approveBtn">Approve</button>`);
    }
    if (["Approved", "Partially Fulfilled"].includes(rec.status)) actionButtons.push(`<button class="btn btn-primary" id="rd_assignBtn">Assign Asset</button>`);
  }
  if (REQUEST_ACTIVE_STATUSES.includes(rec.status) && (admin || (mine && ["Draft", "Submitted"].includes(rec.status)))) {
    actionButtons.push(`<button class="btn btn-secondary" id="rd_cancelBtn">Cancel Request</button>`);
  }
  // Delete is Super-Admin-only, same policy as every other collection in the app.
  if (isSuperAdmin()) actionButtons.push(`<button class="btn btn-danger" id="rd_deleteBtn">Delete</button>`);

  openModal(rec.requestId ? `Request ${rec.requestId}` : "Request (Draft)", `
    <div class="req-detail-head">
      <div>${requestStatusBadge(rec.status)} ${priorityBadge(rec.priority)}</div>
      <div class="muted">${escapeHtml(rec.requestedBy)} · ${fmtDateTime(rec.createdAt)}</div>
    </div>
    ${admin && rec.status === "Approved" ? `<div class="viewer-note" style="border-color:var(--primary);"><span style="font-size:16px;">📦</span><div>This request is approved but <strong>no asset has been handed over yet</strong> — nothing will show up on the Asset Assignment page until you click <strong>Assign Asset</strong> below and complete the handover.</div></div>` : ""}
    ${rec.status === "Partially Fulfilled" ? `<div class="viewer-note" style="border-color:var(--primary);"><span style="font-size:16px;">⏳</span><div><strong>Partially fulfilled</strong> — ${escapeHtml(getRequestItems(rec).filter(i => requestItemRemaining(i) > 0).map(i => `${requestItemLabel(i)} ×${requestItemRemaining(i)}`).join(", "))} still pending. Click <strong>Assign Asset</strong> once stock is available to give the rest.</div></div>` : ""}
    ${rec.status === "Fulfilled" ? `<div class="viewer-note" style="border-color:var(--green,#22c55e);"><span style="font-size:16px;">✅</span><div>Fulfilled — everything on this request is recorded on the <a href="#" id="rd_gotoAssignment" style="color:var(--primary);font-weight:600;">Asset Assignment page</a>.</div></div>` : ""}
    ${teamConflict ? `<div class="viewer-note" style="align-items:flex-start;border-color:var(--red);background:var(--red-light);">
      <span style="font-size:16px;">⚠️</span>
      <div>
        <strong>Team mismatch detected</strong>
        <div style="margin-top:2px;">Employee Master shows <strong>${escapeHtml(currentMasterTeam)}</strong>, but this request shows <strong>${escapeHtml(recTeam)}</strong>. Employee Master data will remain unchanged.</div>
        ${admin ? `<button class="btn btn-secondary btn-sm" id="rd_resolveTeamBtn" style="margin-top:8px;">Resolve…</button>` : `<div class="muted" style="margin-top:6px;">Only an Admin can resolve this.</div>`}
      </div>
    </div>` : ""}
    <div class="table-wrap"><table>
      <tbody>
        <tr><th>Employee</th><td>${escapeHtml(rec.employeeName)}${rec.isNewEmployee ? ` <span class="badge badge-purple">New Employee</span>` : ""}</td></tr>
        <tr><th>Employee Code</th><td>${escapeHtml(rec.employeeCode || "—")}</td></tr>
        <tr><th>Department</th><td>${escapeHtml(rec.department || "—")}</td></tr>
        <tr><th>Team / Location</th><td>${escapeHtml([rec.team, rec.location].filter(Boolean).join(" · ") || "—")}${rec.team ? ` ${rec.teamSource === "master" ? '<span class="badge badge-purple" title="From Employee Master">📋 Master</span>' : rec.teamSource === "manual" ? '<span class="badge badge-grey" title="Manually entered — not in Employee Master at submission time">✏️ Manual</span>' : ""}` : ""}</td></tr>
        <tr><th>Assets Required</th><td>
          <div class="table-wrap"><table style="min-width:0;">
            <thead><tr><th>Asset</th><th>Qty</th><th>Given</th><th>Status</th></tr></thead>
            <tbody>
              ${getRequestItems(rec).map(i => `<tr>
                <td>${escapeHtml(requestItemLabel(i))}</td>
                <td>${i.quantity || 1}</td>
                <td>${i.givenQuantity || 0}</td>
                <td>${requestItemStatusBadge(i)}</td>
              </tr>`).join("")}
            </tbody>
          </table></div>
        </td></tr>
        <tr><th>Request Type</th><td>${escapeHtml(rec.requestType)}</td></tr>
        <tr><th>Required By</th><td>${fmtDate(rec.requiredBy)}</td></tr>
        ${rec.requestType === "Asset Replacement" ? `
        <tr><th>Existing Asset</th><td>${escapeHtml(rec.existingAssetId)}${rec.existingAssetTag ? ` (${escapeHtml(rec.existingAssetTag)})` : ""}</td></tr>
        <tr><th>Replacement Reason</th><td>${escapeHtml(rec.replacementReason === "Other" ? rec.replacementReasonOther : rec.replacementReason)}</td></tr>
        <tr><th>Issue</th><td>${escapeHtml(rec.issueDescription || "—")}</td></tr>
        ` : ""}
        ${rec.requestType === "New Employee – First-Time Asset Assignment" ? `<tr><th>Joining Date</th><td>${fmtDate(rec.joiningDate)}</td></tr>` : ""}
        <tr><th>Justification</th><td>${escapeHtml(rec.businessJustification || "—")}</td></tr>
        ${rec.additionalInstructions ? `<tr><th>Additional Instructions</th><td>${escapeHtml(rec.additionalInstructions)}</td></tr>` : ""}
        ${rec.supportingNote ? `<tr><th>Supporting Evidence</th><td>${escapeHtml(rec.supportingNote)}</td></tr>` : ""}
        ${rec.adminComment ? `<tr><th>Admin Comment</th><td>${escapeHtml(rec.adminComment)}</td></tr>` : ""}
        ${rec.rejectionReason ? `<tr><th>Rejection Reason</th><td>${escapeHtml(rec.rejectionReason)}</td></tr>` : ""}
        ${rec.assignedAssetTagNo ? `<tr><th>Assigned Asset</th><td><span class="badge badge-grey">${escapeHtml(rec.assignedAssetTagNo)}</span></td></tr>` : ""}
      </tbody>
    </table></div>

    <h3 style="margin:18px 0 8px;font-size:13px;">Timeline</h3>
    <div class="req-timeline">
      ${history.length ? history.map(h => `
        <div class="req-timeline-item">
          <div class="req-timeline-dot"></div>
          <div class="req-timeline-body">
            <div class="req-timeline-action">${escapeHtml(h.action)}${h.toStatus ? ` → ${requestStatusBadge(h.toStatus)}` : ""}</div>
            <div class="muted" style="font-size:11.5px;">${escapeHtml(h.email)} · ${fmtDateTime(h.ts)}${h.comment ? ` — ${escapeHtml(h.comment)}` : ""}</div>
          </div>
        </div>
      `).join("") : `<div class="muted">No history yet.</div>`}
    </div>

    <div class="form-actions">
      <button class="btn btn-secondary" id="rd_closeBtn">Close</button>
      ${actionButtons.join("")}
    </div>
  `, () => {
    document.getElementById("modal").classList.add("modal-wide");
    document.getElementById("rd_closeBtn").onclick = closeModal;
    const gotoAssignLink = document.getElementById("rd_gotoAssignment");
    if (gotoAssignLink) gotoAssignLink.onclick = (e) => { e.preventDefault(); closeModal(); goto("assignment"); };
    const resolveTeamBtn = document.getElementById("rd_resolveTeamBtn");
    if (resolveTeamBtn) resolveTeamBtn.onclick = () => openTeamConflictResolver(rec, teamMatchedEmp, currentMasterTeam, recTeam);

    const pushHistory = (action, fromStatus, toStatus, comment) => {
      rec.history = [...(rec.history || []), { ts: nowISO(), email: myEmail, role: admin ? "admin" : "teamlead", action, fromStatus, toStatus, comment: comment || "" }];
    };
    // `reopen: true` swaps back into this same detail view instead of closing —
    // used after Approve so the "Assign Asset" button is right there, rather than
    // dropping the admin back on the list and hoping they remember to come back.
    const persist = (label, detail, opts) => {
      rec.updatedAt = nowISO();
      saveRecord("requests", rec);
      logAction(label, detail);
      toast(label);
      if (currentPage === "assetRequests") renderAssetRequests();
      if (currentPage === "dashboard") renderDashboard();
      if (opts && opts.reopen) openRequestDetail(rec.uid); else closeModal();
    };

    const reviewBtn = document.getElementById("rd_reviewBtn");
    if (reviewBtn) reviewBtn.onclick = () => {
      const from = rec.status;
      rec.status = "Under Review";
      pushHistory("Started review", from, "Under Review");
      persist("Request moved to Under Review", `${rec.requestId || rec.uid} — Under Review`);
    };

    const approveBtn = document.getElementById("rd_approveBtn");
    if (approveBtn) approveBtn.onclick = () => {
      openModal("Approve Request", `
        <div class="field"><label>Admin Comment <span class="muted" style="font-weight:500;">(optional)</span></label>
          <textarea id="rd_approveComment" rows="3" placeholder='e.g. "Approved. Laptop will be issued from Mount Road available stock."'></textarea>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" id="rd_approveCancel">Back</button>
          <button class="btn btn-primary" id="rd_approveConfirm">Approve</button>
        </div>
      `, () => {
        document.getElementById("modal").classList.add("modal-wide");
        document.getElementById("rd_approveCancel").onclick = () => openRequestDetail(rec.uid);
        document.getElementById("rd_approveConfirm").onclick = () => {
          const comment = document.getElementById("rd_approveComment").value.trim();
          const from = rec.status;
          rec.status = "Approved";
          rec.adminComment = comment;
          rec.reviewedAt = nowISO();
          const addedEmployee = ensureEmployeeExists(rec);
          pushHistory("Approved", from, "Approved", comment);
          persist(addedEmployee ? `Request approved — added ${addedEmployee.name} to Employees` : "Request approved — now assign the actual asset",
            `${rec.requestId || rec.uid} approved`, { reopen: true });
        };
      });
    };

    const rejectBtn = document.getElementById("rd_rejectBtn");
    if (rejectBtn) rejectBtn.onclick = () => {
      openModal("Reject Request", `
        <div class="field"><label class="required">Rejection Reason</label>
          <textarea id="rd_rejectReason" rows="3" placeholder="Explain why this request is being rejected — required"></textarea>
        </div>
        <p id="rd_rejectErr" class="signin-error" style="display:none;">A rejection reason is required.</p>
        <div class="form-actions">
          <button class="btn btn-secondary" id="rd_rejectCancel">Back</button>
          <button class="btn btn-danger" id="rd_rejectConfirm">Reject</button>
        </div>
      `, () => {
        document.getElementById("modal").classList.add("modal-wide");
        document.getElementById("rd_rejectCancel").onclick = () => openRequestDetail(rec.uid);
        document.getElementById("rd_rejectConfirm").onclick = () => {
          const reason = document.getElementById("rd_rejectReason").value.trim();
          if (!reason) { document.getElementById("rd_rejectErr").style.display = "block"; return; }
          const from = rec.status;
          rec.status = "Rejected";
          rec.rejectionReason = reason;
          rec.reviewedAt = nowISO();
          pushHistory("Rejected", from, "Rejected", reason);
          persist("Request rejected", `${rec.requestId || rec.uid} rejected — ${reason}`);
        };
      });
    };

    const assignBtn = document.getElementById("rd_assignBtn");
    if (assignBtn) assignBtn.onclick = () => assignAssetForRequest(rec.uid);

    const cancelBtn = document.getElementById("rd_cancelBtn");
    if (cancelBtn) cancelBtn.onclick = () => {
      openModal("Cancel this request?", `
        <p class="muted" style="margin-top:0">This can't be undone. The request will be marked Cancelled.</p>
        <div class="form-actions">
          <button class="btn btn-secondary" id="rd_cancelBack">Back</button>
          <button class="btn btn-danger" id="rd_cancelConfirm">Cancel Request</button>
        </div>
      `, () => {
        document.getElementById("rd_cancelBack").onclick = () => openRequestDetail(rec.uid);
        document.getElementById("rd_cancelConfirm").onclick = () => {
          const from = rec.status;
          rec.status = "Cancelled";
          pushHistory("Cancelled", from, "Cancelled");
          persist("Request cancelled", `${rec.requestId || rec.uid} cancelled`);
        };
      });
    };

    const deleteBtn = document.getElementById("rd_deleteBtn");
    if (deleteBtn) deleteBtn.onclick = () => deleteRequest(rec.uid);
  });
}

// The only path that resolves a Team mismatch (§4/§8 of the master-data spec)
// — Admin-only, requires a reason, and never silently picks a side. Either
// updates Employee Master to match this request (with a teamHistory entry),
// or leaves Master untouched and corrects the stale value on the request
// itself so the mismatch banner clears. Both choices are logged.
function openTeamConflictResolver(rec, matchedEmp, masterTeam, requestTeam) {
  if (!requireAdminOrWarn()) return;
  openModal("Resolve Team Mismatch", `
    <p class="muted" style="margin-top:0">Employee Master currently shows <strong>${escapeHtml(masterTeam)}</strong> for ${escapeHtml(rec.employeeName)}. This request shows <strong>${escapeHtml(requestTeam)}</strong>.</p>
    <div class="field"><label>Which is correct?</label>
      <select id="rtc_choice">
        <option value="master">Employee Master is correct (${escapeHtml(masterTeam)}) — fix this request to match</option>
        <option value="request">This request is correct (${escapeHtml(requestTeam)}) — update Employee Master</option>
      </select>
    </div>
    <div class="field"><label class="required">Reason</label><textarea id="rtc_reason" rows="2" placeholder="Required — kept on the audit trail"></textarea></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="rtc_cancel">Cancel</button>
      <button class="btn btn-primary" id="rtc_confirm">Confirm</button>
    </div>
  `, () => {
    document.getElementById("rtc_cancel").onclick = closeModal;
    document.getElementById("rtc_confirm").onclick = () => {
      const choice = document.getElementById("rtc_choice").value;
      const reason = document.getElementById("rtc_reason").value.trim();
      if (!reason) { toast("A reason is required", "err"); return; }
      const myEmail = (fauth.currentUser || {}).email || "";

      if (choice === "request" && matchedEmp) {
        pushTeamHistory(matchedEmp, { previousTeam: masterTeam, newTeam: requestTeam, source: "admin-conflict-resolution", requestId: rec.requestId || rec.uid, reason });
        matchedEmp.team = requestTeam;
        saveRecord("employees", matchedEmp);
        logAction("Resolved Team mismatch — updated Employee Master", `${rec.employeeName}: ${masterTeam} → ${requestTeam} (${reason})`);
      } else {
        logAction("Resolved Team mismatch — kept Employee Master", `${rec.employeeName}: Master stays "${masterTeam}"; request corrected to match (${reason})`);
      }

      const finalTeam = choice === "request" ? requestTeam : masterTeam;
      rec.team = finalTeam;
      rec.teamSource = "master";
      rec.updatedAt = nowISO();
      rec.history = [...(rec.history || []), {
        ts: nowISO(), email: myEmail, role: "admin", action: "Resolved Team mismatch",
        comment: `${choice === "request" ? "Master updated to" : "Kept Master at"} "${finalTeam}" — ${reason}`,
      }];
      saveRecord("requests", rec);
      toast("Team mismatch resolved");
      closeModal();
      openRequestDetail(rec.uid);
    };
  });
}

// Every assignment record that was actually created FROM this request — via
// its assignedUnits log (the precise list, stamped by fulfillRequestFromAssignment)
// or, as a fallback for older records, by matching sourceRequestId — so a
// cascading delete can find every one of them, not just the first.
function findAssignmentsFromRequest(rec) {
  const uids = new Set((rec.assignedUnits || []).map(u => u.assignmentUid).filter(Boolean));
  DB.assignments.forEach(a => { if (rec.requestId && a.sourceRequestId === rec.requestId) uids.add(a.uid); });
  return DB.assignments.filter(a => uids.has(a.uid));
}

// Delete is Super-Admin-only, same policy as every other collection — an Office
// Admin/Team Lead can review, approve/reject, or cancel a request, but only a
// Super Admin can permanently remove one (e.g. cleaning up test requests).
// Deleting a request cascades to every Asset Assignment record it actually
// produced — since those only exist because of this request, leaving them
// behind would be a real assignment with no request to explain where it came
// from. The requesting Team Lead's own dashboard reflects the deletion the
// next time they load the app or hit Refresh Data (DB.requests is no longer
// kept live in the background — see refreshAllData()).
function deleteRequest(uidVal) {
  if (!requireSuperAdminOrWarn()) return;
  const rec = (DB.requests || []).find(r => r.uid === uidVal);
  const desc = rec ? `<strong>${escapeHtml(rec.requestId || "this draft request")}</strong> (${escapeHtml(rec.employeeName || "—")})` : "this request";
  const linkedAssignments = rec ? findAssignmentsFromRequest(rec) : [];
  openModal("Delete asset request?", `
    <p class="muted" style="margin-top:0">Delete ${desc}? This action can't be undone.</p>
    ${linkedAssignments.length ? `
      <div class="viewer-note" style="align-items:flex-start;border-color:var(--red);background:var(--red-light);">
        <span style="font-size:16px;">⚠️</span>
        <div>
          <strong>${linkedAssignments.length} linked Asset Assignment${linkedAssignments.length === 1 ? "" : "s"} will also be deleted</strong>
          <div style="margin-top:4px;">${linkedAssignments.map(a => `${escapeHtml(a.assetName)}${a.assetTagNo ? ` (${escapeHtml(a.assetTagNo)})` : ""} → ${escapeHtml(a.employeeName)}`).join("<br>")}</div>
        </div>
      </div>
    ` : ""}
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete${linkedAssignments.length ? ` (+ ${linkedAssignments.length} assignment${linkedAssignments.length === 1 ? "" : "s"})` : ""}</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      const linkedUids = new Set(linkedAssignments.map(a => a.uid));
      DB.requests = (DB.requests || []).filter(r => r.uid !== uidVal);
      DB.assignments = DB.assignments.filter(a => !linkedUids.has(a.uid));
      linkedUids.forEach(u => assignSelected.delete(u));
      batchWrite([
        { kind: "requests", type: "delete", uid: uidVal },
        ...linkedAssignments.map(a => ({ kind: "assignments", type: "delete", uid: a.uid })),
      ]);
      logAction("Deleted asset request", rec ? `${rec.requestId || rec.uid} — ${rec.employeeName || "—"}${linkedAssignments.length ? ` (+ ${linkedAssignments.length} linked assignment${linkedAssignments.length === 1 ? "" : "s"})` : ""}` : uidVal);
      closeModal();
      toast(linkedAssignments.length ? `Request and ${linkedAssignments.length} linked assignment${linkedAssignments.length === 1 ? "" : "s"} deleted` : "Asset request deleted");
      if (currentPage === "assetRequests") renderAssetRequests();
      if (currentPage === "assignment") paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    };
  });
}

// Shared entry point into "hand over the actual asset for this Approved
// request" — used by both the detail modal's "Assign Asset" button and the
// quick-action icon on the admin requests table row, so there's more than one
// obvious path into it (this is the step that actually creates the Asset
// Assignment record — Approve alone does not).
function assignAssetForRequest(uidVal) {
  const rec = (DB.requests || []).find(r => r.uid === uidVal);
  if (!rec) { toast("Request not found", "err"); return; }
  if (!isAdmin()) { toast("Only Admins can assign an asset", "err"); return; }
  if (!["Approved", "Partially Fulfilled"].includes(rec.status)) { toast("Only Approved requests can be assigned", "err"); return; }
  // Only the items (or partial quantities) not already given show up here — an
  // "Other" item has no real category to pre-check and needs an existing
  // Category added for it first, same limitation as before.
  const pendingItems = getRequestItems(rec).filter(i => i.assetType !== "Other" && requestItemRemaining(i) > 0);
  if (!pendingItems.length) { toast("Everything on this request has already been given (or is an \"Other\" item — assign it manually)", "err"); return; }
  closeModal();
  openAssignForm(null, false, {
    requestUid: rec.uid, requestId: rec.requestId, employeeName: rec.employeeName,
    employeeCode: rec.employeeCode, department: rec.department,
    items: pendingItems.map(i => ({ assetType: i.assetType, remaining: requestItemRemaining(i) })),
  });
}

// Jump from a linked "AST-REQ-..." badge (shown on assignment rows) straight
// to that request's detail — lets an admin trace an assignment back to the
// request that caused it, and vice versa.
function openRequestByRequestId(requestId) {
  const rec = (DB.requests || []).find(r => r.requestId === requestId);
  if (!rec) { toast("Linked request not found", "err"); return; }
  openRequestDetail(rec.uid);
}

// Saves a manual step in two ways:
//  1. If the request names someone who isn't in the Employees list yet
//     (whether or not "new employee" was ticked), add them automatically —
//     called the moment a Team Lead SUBMITS the request (not at Approval), so
//     a new executive's name/code/department/team are on file immediately,
//     the same instant the request is filed. firestore.rules grants Team
//     Leads CREATE (only — never update/delete) on employees specifically
//     for this; see the `employees` match block for the reasoning.
//  2. If they already exist but don't have a Team on file yet, save whatever
//     Team was entered on this request onto their employee record — so the
//     next request for the same person auto-fills it. This part edits an
//     EXISTING record, which stays Admin-only (Team Leads still can't update
//     employees), so it only runs when called as an Admin — e.g. still runs
//     as a safety net at Approve time for older requests filed before this
//     existed, or when an Admin files a request on someone's behalf.
// Returns the new employee record if one was created, or null otherwise
// (including when an existing employee's Team was just backfilled).
function ensureEmployeeExists(rec) {
  const name = (rec.employeeName || "").trim();
  if (!name) return null;
  const team = (rec.team || "").trim();
  const existing = DB.employees.find(e => (e.name || "").trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    if (isAdmin() && team && !(existing.team || "").trim()) {
      pushTeamHistory(existing, { previousTeam: "", newTeam: team, source: "auto-backfill", requestId: rec.requestId || rec.uid });
      existing.team = team;
      saveRecord("employees", existing);
      logAction("Saved employee team (auto, from Asset Request)", `${name} — ${team} (via ${rec.requestId || rec.uid})`);
    }
    return null;
  }
  const newEmp = {
    uid: uid(),
    id: (rec.employeeCode || "").trim(),
    name,
    department: rec.department || "",
    team,
    phone: "", email: "",
  };
  if (team) pushTeamHistory(newEmp, { previousTeam: "", newTeam: team, source: "auto-backfill", requestId: rec.requestId || rec.uid });
  DB.employees.push(newEmp);
  saveRecord("employees", newEmp);
  logAction(isAdmin() ? "Added employee (auto, from Asset Request)" : "Added employee (auto, by Team Lead's Asset Request)",
    `${name}${rec.department ? " — " + rec.department : ""} (via ${rec.requestId || rec.uid})`);
  return newEmp;
}

// Called once some (or all) of an Approved/Partially Fulfilled request's assets
// have actually been handed over via openAssignForm (see its `requestPrefill`
// param). `picks` is the same {assetName, qty} list openAssignForm just created
// real assignment records for — rolled into each item's givenQuantity, capped at
// what was still outstanding. Items nobody ticked this time (or that stock
// couldn't cover) simply stay Pending; the request becomes Fulfilled only once
// every item's full quantity has been given, otherwise Partially Fulfilled —
// admin can come back and run Assign Asset again later for the rest.
function fulfillRequestFromAssignment(requestPrefill, picks, newRecords) {
  const rec = DB.requests.find(r => r.uid === requestPrefill.requestUid);
  if (!rec) return;
  const items = getRequestItems(rec);
  picks.forEach(({ assetName, qty }) => {
    const item = items.find(i => i.assetType === assetName && requestItemRemaining(i) > 0);
    if (item) item.givenQuantity = Math.min(item.quantity || 1, (item.givenQuantity || 0) + qty);
  });
  rec.items = items;

  const from = rec.status;
  const allGiven = items.every(i => requestItemRemaining(i) <= 0);
  rec.status = allGiven ? "Fulfilled" : "Partially Fulfilled";
  if (allGiven) rec.fulfilledAt = nowISO();
  rec.updatedAt = nowISO();

  const tagList = newRecords.map(r => r.assetTagNo).filter(Boolean);
  rec.assignedAssetUid = newRecords[0] ? newRecords[0].uid : rec.assignedAssetUid;
  rec.assignedAssetTagNo = [rec.assignedAssetTagNo, tagList.join(", ")].filter(Boolean).join(", ");
  rec.assignedUnits = [...(rec.assignedUnits || []), ...newRecords.map(r => ({ assignmentUid: r.uid, assetTagNo: r.assetTagNo || "", assetName: r.assetName }))];

  const givenSummary = newRecords.map(r => `${r.assetName}${r.assetTagNo ? ` (${r.assetTagNo})` : ""}`).join(", ");
  rec.history = [...(rec.history || []), {
    ts: nowISO(), email: (fauth.currentUser || {}).email || "", role: isAdmin() ? "admin" : "teamlead",
    action: allGiven ? "All items given" : "Partially given",
    fromStatus: from, toStatus: rec.status, comment: givenSummary,
  }];
  saveRecord("requests", rec);
  logAction(allGiven ? "Fulfilled asset request" : "Partially fulfilled asset request",
    `${rec.requestId || rec.uid} — ${givenSummary} → ${rec.employeeName}`);
  toast(allGiven ? `Request ${rec.requestId} fulfilled` : `Request ${rec.requestId} partially fulfilled — remaining items stay Pending`);
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
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" onclick="deleteInv('${r.uid}')">🗑️</button>` : ""}
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
    if (!requireSuperAdminOrWarn() || invSelected.size === 0) return;
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
    if (!requireSuperAdminOrWarn()) return;
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
  if (!requireSuperAdminOrWarn()) return;
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

// Every distinct "Team" value already saved on an employee — powers the
// autocomplete suggestion list on both the Add/Edit Employee form and the
// Asset Request form's Team field, so it fills in from what's already on
// file instead of everyone retyping the same team names from scratch.
function distinctEmployeeTeams() {
  return [...new Set(DB.employees.map(e => (e.team || "").trim()).filter(Boolean))].sort();
}

// Audit trail for every change to an employee's master Team — who changed it,
// from what to what, where the value came from, and (for admin-made changes)
// why. Appended to the employee's own record so it travels with them; every
// entry also goes through logAction() for visibility in the shared Activity
// Log, same as everything else in the app.
function pushTeamHistory(emp, { previousTeam, newTeam, source, requestId, reason }) {
  emp.teamHistory = [...(emp.teamHistory || []), {
    ts: nowISO(),
    byEmail: (fauth.currentUser || {}).email || "",
    previousTeam: previousTeam || "",
    newTeam: newTeam || "",
    source, // "auto-backfill" | "admin-conflict-resolution" | "manual-edit"
    requestId: requestId || "",
    reason: reason || "",
  }];
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
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" onclick="deleteEmp('${e.uid}')">🗑️</button>` : ""}
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
    if (!requireSuperAdminOrWarn() || empSelected.size === 0) return;
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
    if (!requireSuperAdminOrWarn()) return;
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
  const teams = distinctEmployeeTeams();
  openModal(editing ? "Edit Employee" : "Add Employee", `
    <div class="field-row">
      <div class="field"><label>Employee ID</label><input type="text" id="f_id" value="${escapeHtml(editing ? editing.id || "" : "")}"></div>
      <div class="field"><label>Name</label><input type="text" id="f_name" value="${escapeHtml(editing ? editing.name : "")}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Department</label>
        <select id="f_dept"><option value="">—</option>${depts.map(d => `<option ${editing && editing.department === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Team <span class="muted" style="font-weight:500;">(sub-team within the department, optional)</span></label>
        <input type="text" id="f_team" list="empTeamList" value="${escapeHtml(editing ? editing.team || "" : "")}">
        <datalist id="empTeamList">${teams.map(t => `<option value="${escapeHtml(t)}">`).join("")}</datalist>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Phone</label><input type="text" id="f_phone" value="${escapeHtml(editing ? editing.phone || "" : "")}"></div>
      <div class="field"><label>Email</label><input type="email" id="f_email" value="${escapeHtml(editing ? editing.email || "" : "")}"></div>
    </div>
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
        team: document.getElementById("f_team").value.trim(),
        phone: document.getElementById("f_phone").value.trim(),
        email: document.getElementById("f_email").value.trim(),
      };
      if (editing) {
        const prevTeam = (editing.team || "").trim();
        if (prevTeam !== rec.team) pushTeamHistory(editing, { previousTeam: prevTeam, newTeam: rec.team, source: "manual-edit" });
        Object.assign(editing, rec); saveRecord("employees", editing); logAction("Edited employee", `${rec.name}${rec.id ? " (" + rec.id + ")" : ""}`); toast("Employee updated");
      } else {
        const newRec = { uid: uid(), ...rec };
        if (rec.team) pushTeamHistory(newRec, { previousTeam: "", newTeam: rec.team, source: "manual-edit" });
        DB.employees.push(newRec); saveRecord("employees", newRec); logAction("Added employee", `${rec.name}${rec.id ? " (" + rec.id + ")" : ""}`); toast("Employee added");
      }
      closeModal(); paintEmpTable();
    };
  });
}

function deleteEmp(uidVal) {
  if (!requireSuperAdminOrWarn()) return;
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
              <td>${escapeHtml(a.assetName)}${a.sourceRequestId ? `<div class="muted" style="font-size:11px;margin-top:2px;">📋 from ${escapeHtml(a.sourceRequestId)}</div>` : ""}${a.reassignedFromEmployee ? `<div class="muted" style="font-size:11px;margin-top:2px;">🔁 reassigned from ${escapeHtml(a.reassignedFromEmployee)}</div>` : ""}</td>
              <td>${a.assetTagNo ? escapeHtml(a.assetTagNo) : "—"}</td>
              <td>${statusBadge(a.status)}</td>
              <td>${escapeHtml(a.assignedBy || "—")}</td>
              <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}${a.returnCondition ? `<br>${conditionBadge(a.returnCondition)}` : ""}</td>
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
// Spells out exactly which numbers produced a negative Available, right
// where you're looking — instead of having to reconstruct the arithmetic by
// hand (or ask someone) every time a category goes negative. Only shown for
// negative rows; a healthy positive number doesn't need explaining.
function stockShortfallBreakdown(r) {
  if (r.available >= 0) return "";
  return `Total ${r.total} − Assigned ${r.assigned} − Under Repair ${r.underRepair} = ${r.available}`;
}

function renderStock() {
  const content = document.getElementById("content");
  const rows = computeStockSummary();
  const admin = isAdmin();
  content.innerHTML = `
    ${viewerNotice()}
    <div class="card">
      <div class="card-header">
        <div><h2>Stock Summary</h2><div class="sub">Auto-calculated from Asset Assignment + Stock Refill Log + Asset Transfers. Repair / Faulty / Lost / Scrap and Threshold are editable${admin ? "" : " (Admin only)"}.</div></div>
        <button class="btn btn-secondary btn-sm" onclick="goto('transfers')">Asset Transfers →</button>
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
              <td>${r.total}${r.receivedTotal ? `<div class="muted" style="font-size:11px;">incl. ${r.receivedTotal} received</div>` : ""}</td>
              <td>${r.assigned}${r.sentTotal ? `<div class="muted" style="font-size:11px;">${r.assignedToEmployees} to employees + ${r.sentTotal} sent to other offices</div>` : ""}</td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="underRepair" value="${r.underRepair}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="faulty" value="${r.faulty}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="lost" value="${r.lost}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="scrap" value="${r.scrap}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><strong style="${r.available < 0 ? "color:var(--red)" : ""}">${r.available}</strong></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="threshold" value="${r.threshold}" ${admin ? "" : "disabled"} style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td>${statusBadge(r.low ? "⚠ Low Stock" : "OK")}</td>
            </tr>
            ${r.available < 0 ? `<tr><td></td><td colspan="9" class="muted" style="font-size:11.5px;color:var(--red);padding-top:0;">${stockShortfallBreakdown(r)}</td></tr>` : ""}
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
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" onclick="deleteRefill('${r.uid}')">🗑️</button>` : `<span class="muted">—</span>`}
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
    if (!requireSuperAdminOrWarn() || refillSelected.size === 0) return;
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
    if (!requireSuperAdminOrWarn()) return;
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
  if (!requireSuperAdminOrWarn()) return;
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
   ASSET TRANSFERS — inter-office Sent/Received log
   Each office logs its own side independently (no cross-office write —
   offices are completely separate in this app, same as everywhere else).
   Sending Mount Road → Supreme means: log a "Sent" entry while viewing
   Mount Road, and separately log a "Received" entry while viewing Supreme.
   Folded into Stock Summary automatically — see computeStockSummary().
   ========================================================= */
let transferSelected = new Set();
let transferFilter = { direction: "" };

function transferDirectionBadge(direction) {
  const cls = direction === "Received" ? "badge-green" : "badge-amber";
  const icon = direction === "Received" ? "⬇️" : "⬆️";
  return `<span class="badge ${cls}">${icon} ${escapeHtml(direction)}</span>`;
}

function renderTransfers() {
  transferSelected = new Set();
  const content = document.getElementById("content");
  const all = [...DB.transfers].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const sentTotal = all.filter(t => t.direction === "Sent").reduce((s, t) => s + (Number(t.quantity) || 0), 0);
  const receivedTotal = all.filter(t => t.direction === "Received").reduce((s, t) => s + (Number(t.quantity) || 0), 0);
  const officesInvolved = new Set(all.map(t => (t.otherOffice || "").trim().toLowerCase()).filter(Boolean)).size;

  content.innerHTML = `
    ${viewerNotice()}
    <div class="stat-grid" style="margin-bottom:18px">
      ${[
        { icon: "🔀", cls: "icon-blue", value: all.length, label: "Total Transfers" },
        { icon: "⬆️", cls: "icon-amber", value: sentTotal, label: "Units Sent Out" },
        { icon: "⬇️", cls: "icon-teal", value: receivedTotal, label: "Units Received" },
        { icon: "🏢", cls: "icon-purple", value: officesInvolved, label: "Offices Involved" },
      ].map(c => `
        <div class="stat-card">
          <div class="stat-top"><div class="stat-icon ${c.cls}">${c.icon}</div><div class="stat-label">${c.label}</div></div>
          <div class="stat-value">${c.value}</div>
        </div>
      `).join("")}
    </div>
    <div class="card">
      <div class="card-header">
        <div><h2>Asset Transfers</h2><div class="sub" id="transferCountSub">${all.length} transfer${all.length === 1 ? "" : "s"} — Sent updates leave the current office, Received brings stock in</div></div>
        ${isAdmin() ? `<button class="btn btn-primary" id="addTransferBtn">+ Log Transfer</button>` : ""}
      </div>
      <div class="toolbar">
        <select class="filter-select" id="transferDirFilter">
          <option value="">All directions</option>
          <option value="Sent" ${transferFilter.direction === "Sent" ? "selected" : ""}>Sent</option>
          <option value="Received" ${transferFilter.direction === "Received" ? "selected" : ""}>Received</option>
        </select>
        <div id="transferBulkBar" style="margin-left:auto"></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? `<th class="ck-col"><input type="checkbox" class="select-ck" id="transferSelectAll"></th>` : ""}
          <th>Date</th><th>Direction</th><th>Office</th><th>Asset</th><th>Qty</th><th>Tags / Serials</th><th>Handled By</th><th>Remarks</th>${isAdmin() ? "<th></th>" : ""}
        </tr></thead>
        <tbody id="transferTbody"></tbody>
      </table></div>
    </div>
  `;
  if (isAdmin()) document.getElementById("addTransferBtn").onclick = () => openTransferForm();
  document.getElementById("transferDirFilter").onchange = (e) => { transferFilter.direction = e.target.value; paintTransferTable(); };
  paintTransferTable();
}

function getFilteredTransfers() {
  let rows = [...DB.transfers].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (transferFilter.direction) rows = rows.filter(t => t.direction === transferFilter.direction);
  return rows;
}

function paintTransferTable() {
  const tbody = document.getElementById("transferTbody");
  if (!tbody) return;
  const rows = getFilteredTransfers();
  const admin = isAdmin();

  tbody.innerHTML = rows.length ? rows.map(t => `
    <tr>
      ${admin ? `<td class="ck-col"><input type="checkbox" class="select-ck row-ck" data-uid="${t.uid}" ${transferSelected.has(t.uid) ? "checked" : ""}></td>` : ""}
      <td>${fmtDate(t.date)}</td>
      <td>${transferDirectionBadge(t.direction)}</td>
      <td>${escapeHtml(t.otherOffice || "—")}</td>
      <td>${escapeHtml(t.assetType || "—")}</td>
      <td><strong>${t.direction === "Received" ? "+" : "−"}${t.quantity}</strong></td>
      <td>${escapeHtml(t.assetTags || "—")}</td>
      <td>${escapeHtml(t.handledBy || "—")}</td>
      <td>${escapeHtml(t.remarks || "—")}</td>
      ${admin ? `<td>
        <div class="row-actions">
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" onclick="deleteTransfer('${t.uid}')">🗑️</button>` : `<span class="muted">—</span>`}
        </div>
      </td>` : ""}
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="${admin ? 9 : 8}">No transfers logged yet — click "+ Log Transfer" to record assets sent to or received from another office.</td></tr>`;

  document.getElementById("transferBulkBar").innerHTML = bulkToolbarHtml(transferSelected.size, rows.length);
  wireTransferBulk(rows);
}

function wireTransferBulk(rows) {
  if (!isAdmin()) return;
  const selectAll = document.getElementById("transferSelectAll");
  if (selectAll) {
    selectAll.checked = rows.length > 0 && rows.every(r => transferSelected.has(r.uid));
    selectAll.onchange = (e) => {
      rows.forEach(r => e.target.checked ? transferSelected.add(r.uid) : transferSelected.delete(r.uid));
      paintTransferTable();
    };
  }
  document.querySelectorAll("#transferTbody .row-ck").forEach(ck => {
    ck.onchange = () => {
      ck.checked ? transferSelected.add(ck.dataset.uid) : transferSelected.delete(ck.dataset.uid);
      document.getElementById("transferBulkBar").innerHTML = bulkToolbarHtml(transferSelected.size, rows.length);
      wireTransferBulk(rows);
    };
  });
  const delSel = document.getElementById("deleteSelectedBtn");
  if (delSel) delSel.onclick = () => {
    if (!requireSuperAdminOrWarn() || transferSelected.size === 0) return;
    confirmBulkDelete(transferSelected.size, "transfer entries", () => {
      const idsToDelete = [...transferSelected];
      const n = idsToDelete.length;
      DB.transfers = DB.transfers.filter(t => !transferSelected.has(t.uid));
      transferSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "transfers", type: "delete", uid: u })));
      logAction("Bulk deleted transfer entries", `Deleted ${n} selected entr${n === 1 ? "y" : "ies"}`); toast("Selected entries deleted"); paintTransferTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireSuperAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "transfer entries", () => {
      const idsToDelete = DB.transfers.map(t => t.uid);
      const n = idsToDelete.length;
      DB.transfers = [];
      transferSelected = new Set();
      batchWrite(idsToDelete.map(u => ({ kind: "transfers", type: "delete", uid: u })));
      logAction("Bulk deleted transfer entries", `Deleted all ${n} transfer log entries`); toast("All transfer entries deleted"); paintTransferTable();
    });
  };
}

function openTransferForm() {
  if (!requireAdminOrWarn()) return;
  const cats = DB.categories.map(c => c.name);
  const otherOffices = OFFICES.filter(o => o.id !== currentOfficeId);
  openModal("Log Asset Transfer", `
    <div class="field-row">
      <div class="field"><label class="required">Direction</label>
        <select id="f_direction">
          <option value="Sent">Sent — leaving this office</option>
          <option value="Received">Received — arriving at this office</option>
        </select>
      </div>
      <div class="field"><label>Date</label><input type="date" id="f_date" value="${todayISO()}"></div>
    </div>
    <div class="field">
      <label class="required" id="f_officeLabel">Sent To</label>
      <input type="text" id="f_office" list="transferOfficeList" placeholder="Office name">
      <datalist id="transferOfficeList">${otherOffices.map(o => `<option value="${escapeHtml(o.name)}">`).join("")}</datalist>
    </div>
    <div class="field-row">
      <div class="field"><label class="required">Asset Type <span class="muted" style="font-weight:500;">(must be an existing category — Stock Summary is calculated per category)</span></label>
        <select id="f_assetType">
          <option value="">—</option>
          ${cats.map(c => `<option>${escapeHtml(c)}</option>`).join("")}
        </select>
      </div>
      <div class="field"><label class="required">Quantity</label><input type="number" min="1" id="f_qty" value="1"></div>
    </div>
    <div class="field"><label>Asset Tags / Serials <span class="muted" style="font-weight:500;">(optional — comma-separated if tracking specific units)</span></label><input type="text" id="f_tags" placeholder="e.g. PHN-0012, PHN-0013"></div>
    <div class="field-row">
      <div class="field"><label>Handled By</label><input type="text" id="f_handledBy" value="${escapeHtml((fauth.currentUser || {}).email || "")}"></div>
      <div class="field"><label>Remarks</label><input type="text" id="f_remarks"></div>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
      <button class="btn btn-primary" id="saveBtn">Log Transfer</button>
    </div>
  `, () => {
    document.getElementById("modal").classList.add("modal-wide");
    const dirSel = document.getElementById("f_direction");
    const officeLabel = document.getElementById("f_officeLabel");
    const syncDirection = () => { officeLabel.textContent = dirSel.value === "Received" ? "Received From" : "Sent To"; };
    dirSel.addEventListener("change", syncDirection);
    syncDirection();

    const assetSel = document.getElementById("f_assetType");

    document.getElementById("cancelBtn").onclick = closeModal;
    document.getElementById("saveBtn").onclick = () => {
      const direction = dirSel.value;
      const otherOffice = document.getElementById("f_office").value.trim();
      const assetType = assetSel.value;
      const qty = Number(document.getElementById("f_qty").value);
      if (!otherOffice) { toast(direction === "Received" ? "Enter which office it came from" : "Enter which office it's going to", "err"); return; }
      if (!assetType) { toast("Select an asset type", "err"); return; }
      if (!qty || qty <= 0) { toast("Enter a valid quantity", "err"); return; }
      const newRec = {
        uid: uid(), id: DB.transfers.length + 1,
        date: document.getElementById("f_date").value || todayISO(),
        direction, otherOffice,
        assetType,
        quantity: qty,
        assetTags: document.getElementById("f_tags").value.trim(),
        handledBy: document.getElementById("f_handledBy").value.trim(),
        remarks: document.getElementById("f_remarks").value.trim(),
      };
      DB.transfers.push(newRec);
      saveRecord("transfers", newRec);
      logAction(`Logged asset transfer (${direction})`, `${direction === "Received" ? "+" : "−"}${qty} ${assetType} ${direction === "Received" ? "from" : "to"} ${otherOffice}`);
      closeModal();
      toast("Transfer logged");
      paintTransferTable();
      if (currentPage === "stock") renderStock();
      if (currentPage === "dashboard") renderDashboard();
    };
  });
}

function deleteTransfer(uidVal) {
  if (!requireSuperAdminOrWarn()) return;
  const rec = DB.transfers.find(t => t.uid === uidVal);
  openModal("Delete transfer entry?", `
    <p class="muted" style="margin-top:0">This will change Total Stock / Available for that category on Stock Summary.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.transfers = DB.transfers.filter(t => t.uid !== uidVal);
      transferSelected.delete(uidVal);
      deleteRecord("transfers", uidVal);
      logAction("Deleted transfer entry", rec ? `${rec.direction} ${rec.quantity} ${rec.assetType} ${rec.direction === "Received" ? "from" : "to"} ${rec.otherOffice}` : uidVal);
      closeModal(); toast("Transfer entry deleted"); paintTransferTable();
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
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete (Super Admin only)" onclick="deleteCat('${c.uid}')">🗑️</button>` : ""}
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
    if (!requireSuperAdminOrWarn() || catSelected.size === 0) return;
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
    if (!requireSuperAdminOrWarn()) return;
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
  if (!requireSuperAdminOrWarn()) return;
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
    case "assignment": return DB.assignments.map(a => ({ "Date": a.date || "", "Asset": a.assetName || "", "Asset Tag": a.assetTagNo || "", "Employee": a.employeeName || "", "Employee ID": a.employeeId || "", "Department": a.department || "", "Assigned By": a.assignedBy || "", "Return Date": a.returnDate || "", "Status": a.status || "", "Condition on Return": a.returnCondition || "", "Outcome": a.returnOutcome || "", "Remarks": a.remarks || "", "Linked Asset Request": a.sourceRequestId || "", "Reassigned From": a.reassignedFromEmployee || "" }));
    case "returns": return getReturnedAssignments().map(a => ({ "Return Date": a.returnDate || "", "Asset": a.assetName || "", "Asset Tag": a.assetTagNo || "", "Returned By": a.employeeName || "", "Employee ID": a.employeeId || "", "Department": a.department || "", "Condition on Return": a.returnCondition || "", "Outcome": a.returnOutcome || "", "Remarks": a.remarks || "" }));
    case "inventory": return DB.inventory.map(r => ({ "Asset ID": r.assetId || "", "Asset Name": r.assetName || "", "Brand": r.brand || "", "Model": r.model || "", "Serial": r.serial || "", "Purchase Date": r.purchaseDate || "", "Status": r.status || "", "Assigned To": r.assignedTo || "", "Floor": r.floor || "", "Condition": r.condition || "" }));
    case "stock": return stock.map(r => ({ "Category": r.category, "Total Stock": r.total, "Assigned": r.assigned, "Under Repair": r.underRepair, "Faulty": r.faulty, "Lost": r.lost, "Scrap": r.scrap, "Available": r.available, "Threshold": r.threshold, "Alert": r.low ? "Low Stock" : "OK" }));
    case "refill": return DB.refills.map(r => ({ "Date": r.date || "", "Category": r.category || "", "Quantity Added": r.quantity || 0, "Added By": r.addedBy || "", "Source / Remarks": r.source || "" }));
    case "transfers": return DB.transfers.map(t => ({ "Date": t.date || "", "Direction": t.direction || "", "Other Office": t.otherOffice || "", "Asset Type": t.assetType || "", "Quantity": t.quantity || 0, "Tags / Serials": t.assetTags || "", "Handled By": t.handledBy || "", "Remarks": t.remarks || "" }));
    case "categories": return DB.categories.map(c => ({ "Category": c.name || "", "Notes": c.notes || "" }));
    case "activityLog": return activityLogCache.map(l => ({ "When": fmtDateTime(l.ts), "User": l.email || "", "Action": l.action || "", "Details": l.details || "" }));
    case "requests": return (DB.requests || []).map(r => ({
      "Request ID": r.requestId || "(draft)", "Requested By": r.requestedBy || "", "Department": r.department || "",
      "Employee": r.employeeName || "", "Employee Code": r.employeeCode || "", "Assets": requestItemsSummary(r),
      "Total Quantity": getRequestItems(r).reduce((s, i) => s + (i.quantity || 1), 0),
      "Request Type": r.requestType || "", "Priority": r.priority || "",
      "Status": r.status || "", "Required By": r.requiredBy || "", "Created": fmtDateTime(r.createdAt),
    }));
    default: return [];
  }
}

function renderReports() {
  const content = document.getElementById("content");
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "office";
  const modules = [
    { kind: "employees", label: "Employees", sheet: "Employees", icon: "👥" },
    { kind: "assignment", label: "Asset Assignment", sheet: "Asset Assignment", icon: "🗂️" },
    { kind: "returns", label: "Asset Returns", sheet: "Asset Returns", icon: "↩️" },
    { kind: "requests", label: "Asset Requests", sheet: "Asset Requests", icon: "📋" },
    { kind: "inventory", label: "Master Inventory", sheet: "Master Inventory", icon: "💻" },
    { kind: "stock", label: "Stock Summary", sheet: "Stock Summary", icon: "📦" },
    { kind: "refill", label: "Stock Refill Log", sheet: "Stock Refill Log", icon: "➕" },
    { kind: "transfers", label: "Asset Transfers", sheet: "Asset Transfers", icon: "🔀" },
    { kind: "categories", label: "Asset Categories", sheet: "Asset Categories", icon: "🏷️" },
  ];

  content.innerHTML = `
    <div class="card" style="margin-bottom:18px">
      <div class="card-header">
        <div><h2>Backup This Office</h2><div class="sub">A raw JSON snapshot — restorable exactly via the admin-tools restore script, unlike the Excel exports below</div></div>
        <button class="btn btn-primary btn-sm" id="jsonBackupBtn">⬇ Download Backup (JSON)</button>
      </div>
      <p class="muted" style="margin-top:0">For real ongoing "automated" backups (not just whenever someone remembers to click this), see
      <code>admin-tools_DO_NOT_UPLOAD/backup-firestore.js</code> — it can be scheduled to run on its own.</p>
    </div>

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

  document.getElementById("jsonBackupBtn").onclick = async () => {
    await loadActivityLog();
    const snapshot = {
      generatedAt: new Date().toISOString(),
      info: OFFICES.find(o => o.id === currentOfficeId) || { id: currentOfficeId },
      lists: DB.lists, stockManual: DB.stockManual,
      employees: DB.employees, assignments: DB.assignments, inventory: DB.inventory,
      refills: DB.refills, categories: DB.categories, transfers: DB.transfers, logs: activityLogCache,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${safeFileBit(officeName)}_backup_${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    logAction("Downloaded backup", `Manual JSON backup for ${officeName}`);
    toast("Backup downloaded");
  };

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
      <strong>Team Lead</strong>: can submit and track their own Asset Requests for one office — nothing else (granted in "Office Access" above).
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
            <button class="btn btn-secondary btn-sm btn-icon role-edit-btn" title="Change role" data-email="${escapeHtml(r.email)}" data-role="${escapeHtml(r.role)}">✏️</button>
            <button class="btn btn-danger btn-sm btn-icon role-del-btn" title="Remove access" data-email="${escapeHtml(r.email)}">🗑️</button>
          </div>
        </td>
      </tr>
    `).join("") : `<tr class="empty-row"><td colspan="3">Nobody's been granted access yet — add someone above (must match a Firebase Authentication login exactly).</td></tr>`;
    // Wired via data-attributes + addEventListener (not inline onclick="...('${email}')") so an
    // email containing a stray quote can never break out of a hand-built JS string in the HTML.
    tbody.querySelectorAll(".role-edit-btn").forEach(btn => {
      btn.onclick = () => openRoleForm(btn.dataset.email, btn.dataset.role);
    });
    tbody.querySelectorAll(".role-del-btn").forEach(btn => {
      btn.onclick = () => removeRole(btn.dataset.email);
    });
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
// Labels/badges shared by the office-access list and the office picker's role chip.
function officeRoleLabel(role) {
  return role === "admin" ? "Admin" : role === "teamlead" ? "Team Lead" : "Viewer";
}
function officeRoleBadgeClass(role) {
  return role === "admin" ? "badge-blue" : role === "teamlead" ? "badge-purple" : "badge-grey";
}

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
        <td><span class="badge ${officeRoleBadgeClass(r.role)}">${officeRoleLabel(r.role)}</span>${r.role === "teamlead" && r.team ? `<div class="muted" style="font-size:11px;margin-top:2px;">${escapeHtml(r.team)}</div>` : ""}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-secondary btn-sm btn-icon oa-edit-btn" title="Change role" data-email="${escapeHtml(r.email)}" data-role="${escapeHtml(r.role)}" data-team="${escapeHtml(r.team || "")}">✏️</button>
            <button class="btn btn-danger btn-sm btn-icon oa-del-btn" title="Remove access" data-email="${escapeHtml(r.email)}">🗑️</button>
          </div>
        </td>
      </tr>
    `).join("") : `<tr class="empty-row"><td colspan="3">Nobody has office-specific access yet — Super Admins can already edit here.</td></tr>`;
    tbody.querySelectorAll(".oa-edit-btn").forEach(btn => {
      btn.onclick = () => openOfficeAccessForm(btn.dataset.email, btn.dataset.role, btn.dataset.team);
    });
    tbody.querySelectorAll(".oa-del-btn").forEach(btn => {
      btn.onclick = () => removeOfficeAccess(btn.dataset.email);
    });
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3">Couldn't load access list.</td></tr>`;
  }
}

function openOfficeAccessForm(existingEmail, existingRole, existingTeam) {
  if (!requireSuperAdminOrWarn()) return;
  const editing = !!existingEmail;
  const officeName = (OFFICES.find(o => o.id === currentOfficeId) || {}).name || "this office";
  const teams = distinctEmployeeTeams();
  openModal(editing ? "Change Office Access" : "Grant Office Access", `
    ${editing ? "" : `<p class="muted" style="margin-top:0">Grants access to <strong>${escapeHtml(officeName)}</strong> only. The email must exactly match a login already created in Firebase → Authentication → Users.</p>`}
    <div class="field"><label>Email</label><input type="email" id="f_oaEmail" value="${escapeHtml(existingEmail || "")}" ${editing ? "disabled" : ""} placeholder="person@company.com"></div>
    <div class="field"><label>Role</label>
      <select id="f_oaRole">
        <option value="viewer" ${existingRole === "viewer" ? "selected" : ""}>Viewer — view only</option>
        <option value="teamlead" ${existingRole === "teamlead" ? "selected" : ""}>Team Lead — submit &amp; track their own Asset Requests</option>
        <option value="admin" ${existingRole === "admin" ? "selected" : ""}>Admin — can edit this office</option>
      </select>
    </div>
    <div class="field" id="f_oaTeamWrap" style="display:none">
      <label>Team <span class="muted" style="font-weight:500;">(which team this Team Lead's dashboard shows — matches employees' Team field)</span></label>
      <input type="text" id="f_oaTeam" list="oaTeamList" value="${escapeHtml(existingTeam || "")}">
      <datalist id="oaTeamList">${teams.map(t => `<option value="${escapeHtml(t)}">`).join("")}</datalist>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelOA">Cancel</button>
      <button class="btn btn-primary" id="saveOA">${editing ? "Save" : "Grant Access"}</button>
    </div>
  `, () => {
    const emailInp = document.getElementById("f_oaEmail");
    const roleSel = document.getElementById("f_oaRole");
    const teamWrap = document.getElementById("f_oaTeamWrap");
    const syncTeamWrap = () => { teamWrap.style.display = roleSel.value === "teamlead" ? "" : "none"; };
    roleSel.addEventListener("change", syncTeamWrap);
    syncTeamWrap();
    document.getElementById("cancelOA").onclick = closeModal;
    document.getElementById("saveOA").onclick = async () => {
      const email = emailInp.value.trim().toLowerCase();
      const role = roleSel.value;
      const team = role === "teamlead" ? document.getElementById("f_oaTeam").value.trim() : "";
      if (!email) { toast("Enter an email", "err"); return; }
      try {
        await docRef().collection("access").doc(email).set({ email, role, team, updatedAt: new Date().toISOString() }, { merge: true });
        logAction(editing ? "Changed office access" : "Granted office access", `${email} → ${officeRoleLabel(role)}${team ? ` (${team})` : ""}`);
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
  const superAdmin = isSuperAdmin();
  el.innerHTML = items.length ? items.map(v => `
    <span class="tag-chip">${escapeHtml(v)} ${superAdmin ? `<span class="chip-remove" style="cursor:pointer;color:var(--red)" title="Delete (Super Admin only)" data-key="${escapeHtml(key)}" data-val="${escapeHtml(v)}">✕</span>` : ""}</span>
  `).join("") : `<p class="muted" style="font-size:12.5px">No values yet</p>`;
  // data-attributes + addEventListener, not an inline onclick built from the value itself —
  // a list value containing a quote (or anything) can't break out of a hand-built JS string.
  el.querySelectorAll(".chip-remove").forEach(chip => {
    chip.onclick = () => removeListItem(chip.dataset.key, chip.dataset.val);
  });
}

function removeListItem(key, val) {
  if (!requireSuperAdminOrWarn()) return;
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
      : `<span class="office-role-badge ${role}">${officeRoleLabel(role)}</span>`;
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
    dataBootstrapped = true;
  } catch (err) {
    console.error(err);
    hideLoadingScreen();
    if (err && err.code === "permission-denied") {
      // A real access boundary, not a setup problem — send them back to pick
      // a different office instead of the developer-facing "connect Firebase" screen.
      currentOfficeId = null;
      toast("You don't have access to that office — ask an Admin to grant it", "err");
      showOfficeSelectScreen();
      return;
    }
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
  stopDataSync();
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
      stopDataSync();
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

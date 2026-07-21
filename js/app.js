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
let currentPage = "dashboard";
let fbApp = null, fdb = null, fauth = null;
const FIRESTORE_COLLECTION = "assetTracker";
const FIRESTORE_DOC = "data";

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
  return fdb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
}

/* ---------------- Role management (Firebase Auth) ---------------- */
// Viewer = not signed in (read-only, live data). Admin = signed in with an
// email/password account you create yourself in the Firebase console under
// Authentication > Users. Actual write protection is enforced server-side by
// your Firestore Security Rules (see README.txt) — not just this UI.
function isAdmin() {
  return !!(fauth && fauth.currentUser);
}
function paintRoleUI() {
  const badge = document.getElementById("roleBadge");
  const btn = document.getElementById("roleSwitchBtn");
  if (!badge || !btn) return;
  const admin = isAdmin();
  badge.textContent = admin ? (fauth.currentUser.email || "Admin") : "Viewer";
  badge.className = "role-badge " + (admin ? "admin" : "viewer");
  btn.textContent = admin ? "Sign Out" : "Admin Sign In";
}
document.getElementById("roleSwitchBtn").addEventListener("click", () => {
  if (!fauth) { toast("Still connecting to Firebase — try again in a moment", "info"); return; }
  if (isAdmin()) {
    fauth.signOut();
    toast("Signed out — Viewer mode");
    return;
  }
  openModal("Admin Sign In", `
    <p class="muted" style="margin-top:0">Sign in with an admin account (created in your Firebase console under
    Authentication → Users → Add user) to add, edit, delete or import data.</p>
    <div class="field"><label>Email</label><input type="email" id="f_email" placeholder="admin@example.com" autocomplete="username"></div>
    <div class="field"><label>Password</label><input type="password" id="f_pw" placeholder="Password" autocomplete="current-password"></div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelPw">Cancel</button>
      <button class="btn btn-primary" id="confirmPw">Sign In</button>
    </div>
  `, () => {
    const emailInp = document.getElementById("f_email");
    const pwInp = document.getElementById("f_pw");
    emailInp.focus();
    const attempt = () => {
      const email = emailInp.value.trim();
      const pw = pwInp.value;
      if (!email || !pw) { toast("Enter email and password", "err"); return; }
      fauth.signInWithEmailAndPassword(email, pw)
        .then(() => { closeModal(); toast("Signed in as Admin"); })
        .catch(err => toast(err.message.replace(/^Firebase:\s*/, ""), "err"));
    };
    document.getElementById("cancelPw").onclick = closeModal;
    document.getElementById("confirmPw").onclick = attempt;
    [emailInp, pwInp].forEach(inp => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); }));
  });
});

function viewerNotice() {
  if (isAdmin()) return "";
  return `<div class="viewer-note">👁️ You're viewing live shared data in <strong>read-only</strong> mode — sign in as Admin from the sidebar to make changes.</div>`;
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
  toast("Switch to Admin mode to make changes", "err");
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
  settings: { title: "Settings", render: renderSettings },
};

function goto(page) {
  currentPage = page;
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
document.getElementById("resetDataBtn").addEventListener("click", () => {
  if (!requireAdminOrWarn()) return;
  openModal("Reset all data?", `
    <p class="muted" style="margin-top:0">This restores the dashboard, assignments, employees and logs back to the
    original uploaded sheet — for <strong>everyone</strong> viewing this app, since data is shared live via Firebase.
    Anything anyone has added or edited will be lost.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelReset">Cancel</button>
      <button class="btn btn-danger" id="confirmReset">Yes, reset data for everyone</button>
    </div>
  `, () => {
    document.getElementById("cancelReset").onclick = closeModal;
    document.getElementById("confirmReset").onclick = () => {
      DB = seedFromSource();
      saveDB();
      closeModal();
      toast("Data reset to original sheet");
      goto(currentPage);
    };
  });
});

/* =========================================================
   DASHBOARD
   ========================================================= */
function renderDashboard() {
  const s = computeDashboard();
  const content = document.getElementById("content");

  const cards = [
    { label: "Asset Categories", value: s.categories, icon: "🏷️", cls: "icon-indigo", foot: "Tracked categories" },
    { label: "Total Inventory", value: s.total, icon: "📦", cls: "icon-blue", foot: "Units added via refills" },
    { label: "Available", value: s.available, icon: "🟢", cls: "icon-teal", foot: "Ready to assign" },
    { label: "Assigned", value: s.assigned, icon: "🔵", cls: "icon-purple", foot: "Currently in use" },
    { label: "Under Repair", value: s.underRepair, icon: "🟡", cls: "icon-amber", foot: "Being serviced" },
    { label: "Faulty", value: s.faulty, icon: "🔴", cls: "icon-red", foot: "Needs attention" },
    { label: "Lost", value: s.lost, icon: "✖", cls: "icon-grey", foot: "Unaccounted" },
    { label: "Scrap", value: s.scrap, icon: "⚫", cls: "icon-grey", foot: "Decommissioned" },
  ];

  const recentAssignments = [...DB.assignments].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 6);
  const lowStockRows = s.rows.filter(r => r.low);

  content.innerHTML = `
    ${viewerNotice()}
    <div class="stat-grid">
      ${cards.map(c => `
        <div class="stat-card">
          <div class="stat-top">
            <div class="stat-icon ${c.cls}">${c.icon}</div>
            <div class="stat-label">${c.label}</div>
          </div>
          <div class="stat-value">${c.value}</div>
          <div class="stat-foot">${c.foot}</div>
        </div>
      `).join("")}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div><h2>Recent Assignments</h2><div class="sub">Latest activity from the assignment log</div></div>
          <button class="btn btn-secondary btn-sm" onclick="goto('assignment')">View all →</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Asset</th><th>Employee</th><th>Dept</th><th>Status</th></tr></thead>
            <tbody>
              ${recentAssignments.length ? recentAssignments.map(a => `
                <tr>
                  <td>${fmtDate(a.date)}</td>
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
          <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
            <div>
              <div style="font-weight:600">${escapeHtml(r.category)}</div>
              <div class="muted" style="font-size:12px">Available: ${r.available} · Threshold: ${r.threshold}</div>
            </div>
            ${statusBadge("⚠ Low Stock")}
          </div>
        `).join("") : `<p class="muted">All categories are healthily stocked. ✅</p>`}
      </div>
    </div>

    <p class="footer-note">Speelfinance · Asset Management Tracker — last updated ${fmtDate(todayISO())}</p>
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
        <div><h2>Asset Assignment</h2><div class="sub">${DB.assignments.length} records</div></div>
        ${isAdmin() ? `<button class="btn btn-primary" id="addAssignBtn">+ New Assignment</button>` : ""}
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="assignSearch" placeholder="Search employee, asset, assigned by..." /></div>
        <select class="filter-select" id="assignStatusFilter">
          <option value="">All statuses</option>
          ${(DB.lists.assignmentStatus || []).map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>
        <select class="filter-select" id="assignDeptFilter">
          <option value="">All departments</option>
          ${depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")}
        </select>
        <div id="assignBulkBar"></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${isAdmin() ? `<th class="ck-col"><input type="checkbox" class="select-ck" id="assignSelectAll"></th>` : ""}
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

  paintAssignTable();
}

function getFilteredAssignments() {
  let rows = [...DB.assignments].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
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

  tbody.innerHTML = rows.length ? rows.map(a => `
    <tr>
      ${admin ? `<td class="ck-col"><input type="checkbox" class="select-ck row-ck" data-uid="${a.uid}" ${assignSelected.has(a.uid) ? "checked" : ""}></td>` : ""}
      <td>${fmtDate(a.date)}</td>
      <td>${escapeHtml(a.assetName)}</td>
      <td>${escapeHtml(a.employeeName)}</td>
      <td>${escapeHtml(a.department || "—")}</td>
      <td>${escapeHtml(a.assignedBy || "—")}</td>
      <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${escapeHtml(a.remarks || "—")}</td>
      ${admin ? `<td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" title="Edit" onclick="openAssignForm('${a.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" title="Delete" onclick="deleteAssignment('${a.uid}')">🗑️</button>
        </div>
      </td>` : ""}
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="10">No matching records</td></tr>`;

  document.getElementById("assignBulkBar").innerHTML = bulkToolbarHtml(assignSelected.size, rows.length);
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
      DB.assignments = DB.assignments.filter(a => !assignSelected.has(a.uid));
      assignSelected = new Set();
      saveDB(); toast("Selected assignments deleted"); paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "assignments (matching current filters)", () => {
      const idsToDelete = new Set(rows.map(r => r.uid));
      DB.assignments = DB.assignments.filter(a => !idsToDelete.has(a.uid));
      assignSelected = new Set();
      saveDB(); toast("All matching assignments deleted"); paintAssignTable();
      if (currentPage === "dashboard") renderDashboard();
    });
  };
}

function openAssignForm(uidVal) {
  if (!requireAdminOrWarn()) return;
  const editing = uidVal ? DB.assignments.find(a => a.uid === uidVal) : null;
  const cats = DB.categories.map(c => c.name);
  const depts = DB.lists.department || [];
  const statuses = DB.lists.assignmentStatus || ["Assigned", "Returned", "Overdue"];

  openModal(editing ? "Edit Assignment" : "New Assignment", `
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" id="f_date" value="${editing ? editing.date || "" : todayISO()}"></div>
      <div class="field"><label>Asset</label>
        <select id="f_asset">${cats.map(c => `<option ${editing && editing.assetName === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
      </div>
    </div>
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
    // Auto-fill Employee ID + Department when a known employee name is entered/selected
    const empInput = document.getElementById("f_emp");
    const autofillFromName = () => {
      const typed = empInput.value.trim().toLowerCase();
      if (!typed) return;
      const match = DB.employees.find(e => (e.name || "").trim().toLowerCase() === typed);
      if (match) {
        document.getElementById("f_empid").value = match.id || "";
        const deptSel = document.getElementById("f_dept");
        if (match.department && [...deptSel.options].some(o => o.value === match.department)) {
          deptSel.value = match.department;
        }
      }
    };
    empInput.addEventListener("input", autofillFromName);
    empInput.addEventListener("change", autofillFromName);
    if (!editing) autofillFromName();

    document.getElementById("cancelBtn").onclick = closeModal;
    document.getElementById("saveBtn").onclick = () => {
      const empName = document.getElementById("f_emp").value.trim();
      if (!empName) { toast("Employee name is required", "err"); return; }
      const rec = {
        date: document.getElementById("f_date").value,
        assetName: document.getElementById("f_asset").value,
        employeeName: empName,
        employeeId: document.getElementById("f_empid").value.trim(),
        department: document.getElementById("f_dept").value,
        assignedBy: document.getElementById("f_by").value.trim(),
        status: document.getElementById("f_status").value,
        returnDate: document.getElementById("f_return").value,
        remarks: document.getElementById("f_remarks").value.trim(),
      };
      if (editing) {
        Object.assign(editing, rec);
        toast("Assignment updated");
      } else {
        DB.assignments.push({ uid: uid(), id: DB.assignments.length + 1, ...rec });
        toast("Assignment added");
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
  openModal("Delete assignment?", `
    <p class="muted" style="margin-top:0">This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.assignments = DB.assignments.filter(a => a.uid !== uidVal);
      assignSelected.delete(uidVal);
      saveDB(); closeModal(); toast("Assignment deleted"); paintAssignTable();
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
  let rows = [...DB.inventory];
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
      DB.inventory = DB.inventory.filter(r => !invSelected.has(r.uid));
      invSelected = new Set();
      saveDB(); toast("Selected assets deleted"); paintInvTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "assets (matching current search)", () => {
      const idsToDelete = new Set(rows.map(r => r.uid));
      DB.inventory = DB.inventory.filter(r => !idsToDelete.has(r.uid));
      invSelected = new Set();
      saveDB(); toast("All matching assets deleted"); paintInvTable();
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
      if (editing) { Object.assign(editing, rec); toast("Asset updated"); }
      else { DB.inventory.push({ uid: uid(), ...rec }); toast("Asset added"); }
      saveDB(); closeModal(); paintInvTable();
    };
  });
}

function deleteInv(uidVal) {
  if (!requireAdminOrWarn()) return;
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
      saveDB(); closeModal(); toast("Asset deleted"); paintInvTable();
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
      DB.employees = DB.employees.filter(e => !empSelected.has(e.uid));
      empSelected = new Set();
      saveDB(); toast("Selected employees deleted"); paintEmpTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "employees (matching current search)", () => {
      const idsToDelete = new Set(rows.map(r => r.uid));
      DB.employees = DB.employees.filter(e => !idsToDelete.has(e.uid));
      empSelected = new Set();
      saveDB(); toast("All matching employees deleted"); paintEmpTable();
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
      if (editing) { Object.assign(editing, rec); toast("Employee updated"); }
      else { DB.employees.push({ uid: uid(), ...rec }); toast("Employee added"); }
      saveDB(); closeModal(); paintEmpTable();
    };
  });
}

function deleteEmp(uidVal) {
  if (!requireAdminOrWarn()) return;
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
      saveDB(); closeModal(); toast("Employee removed"); paintEmpTable();
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
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
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
              <td>${fmtDate(a.date)}</td>
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
      DB.refills = DB.refills.filter(r => !refillSelected.has(r.uid));
      refillSelected = new Set();
      saveDB(); toast("Selected entries deleted"); paintRefillTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "refill entries", () => {
      DB.refills = [];
      refillSelected = new Set();
      saveDB(); toast("All refill entries deleted"); paintRefillTable();
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
      DB.refills.push({
        uid: uid(), id: DB.refills.length + 1,
        date: document.getElementById("f_date").value,
        category: document.getElementById("f_cat").value,
        quantity: qty,
        addedBy: document.getElementById("f_by").value.trim(),
        source: document.getElementById("f_source").value.trim(),
      });
      saveDB(); closeModal(); toast("Refill logged"); paintRefillTable();
    };
  });
}

function deleteRefill(uidVal) {
  if (!requireAdminOrWarn()) return;
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
      saveDB(); closeModal(); toast("Refill entry deleted"); paintRefillTable();
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
      DB.categories = DB.categories.filter(c => !catSelected.has(c.uid));
      catSelected = new Set();
      saveDB(); toast("Selected categories deleted"); paintCatTable();
    });
  };
  const delAll = document.getElementById("deleteAllBtn");
  if (delAll) delAll.onclick = () => {
    if (!requireAdminOrWarn()) return;
    confirmBulkDelete(rows.length, "categories", () => {
      DB.categories = [];
      catSelected = new Set();
      saveDB(); toast("All categories deleted"); paintCatTable();
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
        toast("Category updated");
      } else {
        DB.categories.push({ uid: uid(), name, notes: document.getElementById("f_notes").value.trim() });
        DB.stockManual[name] = { underRepair: 0, faulty: 0, lost: 0, scrap: 0, threshold: 5 };
        toast("Category added");
      }
      saveDB(); closeModal(); paintCatTable();
    };
  });
}

function deleteCat(uidVal) {
  if (!requireAdminOrWarn()) return;
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
      saveDB(); closeModal(); toast("Category deleted"); paintCatTable();
    };
  });
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
    <div class="card">
      <div class="card-header"><div><h2>Access</h2><div class="sub">Who can make changes</div></div></div>
      <p class="muted" style="margin-top:0"><strong>Viewer</strong> mode: browse everything, no edits. <strong>Admin</strong> mode: add / edit / delete / bulk-delete / import data. Switch modes from the sidebar (admin requires the password).</p>
      <p class="muted">Everything is stored in your Cloud Firestore database and synced live to everyone viewing this app. Use <strong>Reset Data</strong> in the sidebar to restore the original sheet contents for everyone at any time.</p>
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
        saveDB(); input.value = ""; paintChips(key); toast("Added");
      };
    });
  }
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
  const shell = document.querySelector(".app-shell");
  if (shell) shell.style.display = "";
}
function showFirebaseSetupScreen(isError) {
  const shell = document.querySelector(".app-shell");
  if (shell) shell.style.display = "none";
  document.getElementById("signInGateScreen")?.classList.remove("show");
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
  const el = document.getElementById("signInGateScreen");
  if (el) el.classList.add("show");
  const note = document.getElementById("gateErrorNote");
  if (note) {
    if (errorMsg) { note.textContent = errorMsg; note.style.display = "block"; }
    else { note.style.display = "none"; }
  }
}

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
    paintRoleUI();

    if (!user) {
      detachRealtimeListener();
      DB = null;
      dataBootstrapped = false;
      hideLoadingScreen();
      showSignInGate();
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
    goto(currentPage);
  });
}
document.addEventListener("DOMContentLoaded", init);

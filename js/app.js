/* =========================================================
   Mount Road Office — Asset Management System
   Pure client-side app. Data persists in localStorage.
   Mirrors the logic of the original Excel workbook:
     - Total Stock (auto)      = SUM of Stock Refill Log qty per category
     - Assigned / In Use (auto)= COUNT of assignments with status "Assigned"
     - Available (auto)        = Total - Assigned - Repair - Faulty - Lost - Scrap
     - Stock Alert              = "Low Stock" when Available <= Threshold
   ========================================================= */

const DB_KEY = "mountRoadAssetDB_v1";
let DB = null;
let currentPage = "dashboard";

/* ---------------- Persistence ---------------- */
function loadDB() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fall through to seed */ }
  }
  return seedFromSource();
}

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

function saveDB() {
  localStorage.setItem(DB_KEY, JSON.stringify(DB));
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
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
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
}
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});

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
  openModal("Reset all data?", `
    <p class="muted" style="margin-top:0">This restores the dashboard, assignments, employees and logs back to the
    original uploaded sheet. Anything you've added or edited in this browser will be lost.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelReset">Cancel</button>
      <button class="btn btn-danger" id="confirmReset">Yes, reset data</button>
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

    <p class="footer-note">Mount Road Office · Asset Management Tracker — last updated ${fmtDate(todayISO())}</p>
  `;
}

/* =========================================================
   ASSET ASSIGNMENT
   ========================================================= */
let assignFilter = { q: "", status: "", dept: "" };

function renderAssignment() {
  const content = document.getElementById("content");
  const depts = DB.lists.department || [];
  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h2>Asset Assignment</h2><div class="sub">${DB.assignments.length} records</div></div>
        <button class="btn btn-primary" id="addAssignBtn">+ New Assignment</button>
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
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Date</th><th>Asset</th><th>Employee</th><th>Dept</th><th>Assigned By</th>
          <th>Return Date</th><th>Status</th><th>Remarks</th><th></th>
        </tr></thead>
        <tbody id="assignTbody"></tbody>
      </table></div>
    </div>
  `;

  document.getElementById("addAssignBtn").onclick = () => openAssignForm();
  document.getElementById("assignSearch").oninput = (e) => { assignFilter.q = e.target.value.toLowerCase(); paintAssignTable(); };
  document.getElementById("assignStatusFilter").onchange = (e) => { assignFilter.status = e.target.value; paintAssignTable(); };
  document.getElementById("assignDeptFilter").onchange = (e) => { assignFilter.dept = e.target.value; paintAssignTable(); };

  paintAssignTable();
}

function paintAssignTable() {
  const tbody = document.getElementById("assignTbody");
  if (!tbody) return;
  let rows = [...DB.assignments].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (assignFilter.q) {
    rows = rows.filter(a => [a.employeeName, a.assetName, a.assignedBy, a.remarks].join(" ").toLowerCase().includes(assignFilter.q));
  }
  if (assignFilter.status) rows = rows.filter(a => a.status === assignFilter.status);
  if (assignFilter.dept) rows = rows.filter(a => a.department === assignFilter.dept);

  tbody.innerHTML = rows.length ? rows.map(a => `
    <tr>
      <td>${fmtDate(a.date)}</td>
      <td>${escapeHtml(a.assetName)}</td>
      <td>${escapeHtml(a.employeeName)}</td>
      <td>${escapeHtml(a.department || "—")}</td>
      <td>${escapeHtml(a.assignedBy || "—")}</td>
      <td>${a.returnDate ? fmtDate(a.returnDate) : "—"}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${escapeHtml(a.remarks || "—")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" title="Edit" onclick="openAssignForm('${a.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" title="Delete" onclick="deleteAssignment('${a.uid}')">🗑️</button>
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="9">No matching records</td></tr>`;
}

function openAssignForm(uidVal) {
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
        <input type="text" id="f_emp" list="empList" value="${escapeHtml(editing ? editing.employeeName : "")}" placeholder="Type or pick a name">
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
  openModal("Delete assignment?", `
    <p class="muted" style="margin-top:0">This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.assignments = DB.assignments.filter(a => a.uid !== uidVal);
      saveDB(); closeModal(); toast("Assignment deleted"); paintAssignTable();
    };
  });
}

/* =========================================================
   MASTER INVENTORY
   ========================================================= */
let invFilter = { q: "" };

function renderInventory() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h2>Master Inventory</h2><div class="sub">${DB.inventory.length} individual assets tracked by Asset ID</div></div>
        <button class="btn btn-primary" id="addInvBtn">+ Add Asset</button>
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="invSearch" placeholder="Search asset ID, brand, serial, assignee..." /></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Asset ID</th><th>Asset Name</th><th>Brand</th><th>Model</th><th>Serial</th>
          <th>Purchase Date</th><th>Status</th><th>Assigned To</th><th>Floor</th><th>Condition</th><th></th>
        </tr></thead>
        <tbody id="invTbody"></tbody>
      </table></div>
    </div>
  `;
  document.getElementById("addInvBtn").onclick = () => openInvForm();
  document.getElementById("invSearch").oninput = (e) => { invFilter.q = e.target.value.toLowerCase(); paintInvTable(); };
  paintInvTable();
}

function paintInvTable() {
  const tbody = document.getElementById("invTbody");
  if (!tbody) return;
  let rows = [...DB.inventory];
  if (invFilter.q) {
    rows = rows.filter(r => Object.values(r).join(" ").toLowerCase().includes(invFilter.q));
  }
  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
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
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openInvForm('${r.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteInv('${r.uid}')">🗑️</button>
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="11">No assets yet — click "Add Asset" to register individual items (PCs, phones, etc.) beyond the category-level stock counts.</td></tr>`;
}

function openInvForm(uidVal) {
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
  openModal("Delete asset?", `
    <p class="muted" style="margin-top:0">This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.inventory = DB.inventory.filter(r => r.uid !== uidVal);
      saveDB(); closeModal(); toast("Asset deleted"); paintInvTable();
    };
  });
}

/* =========================================================
   EMPLOYEES
   ========================================================= */
let empFilter = { q: "", dept: "" };

function renderEmployees() {
  const content = document.getElementById("content");
  const depts = [...new Set(DB.employees.map(e => e.department).filter(Boolean))].sort();
  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h2>Employees</h2><div class="sub">${DB.employees.length} employees</div></div>
        <button class="btn btn-primary" id="addEmpBtn">+ Add Employee</button>
      </div>
      <div class="toolbar">
        <div class="search-box"><input type="text" id="empSearch" placeholder="Search name or ID..." /></div>
        <select class="filter-select" id="empDeptFilter">
          <option value="">All departments</option>
          ${depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")}
        </select>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Employee ID</th><th>Name</th><th>Department</th><th>Email</th><th>Phone</th><th></th></tr></thead>
        <tbody id="empTbody"></tbody>
      </table></div>
    </div>
  `;
  document.getElementById("addEmpBtn").onclick = () => openEmpForm();
  document.getElementById("empSearch").oninput = (e) => { empFilter.q = e.target.value.toLowerCase(); paintEmpTable(); };
  document.getElementById("empDeptFilter").onchange = (e) => { empFilter.dept = e.target.value; paintEmpTable(); };
  paintEmpTable();
}

function paintEmpTable() {
  const tbody = document.getElementById("empTbody");
  if (!tbody) return;
  let rows = [...DB.employees];
  if (empFilter.q) rows = rows.filter(e => `${e.id} ${e.name}`.toLowerCase().includes(empFilter.q));
  if (empFilter.dept) rows = rows.filter(e => e.department === empFilter.dept);

  tbody.innerHTML = rows.length ? rows.map(e => `
    <tr>
      <td>${escapeHtml(e.id || "—")}</td>
      <td>${escapeHtml(e.name)}</td>
      <td>${escapeHtml(e.department || "—")}</td>
      <td>${escapeHtml(e.email || "—")}</td>
      <td>${escapeHtml(e.phone || "—")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openEmpForm('${e.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteEmp('${e.uid}')">🗑️</button>
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="6">No employees found</td></tr>`;
}

function openEmpForm(uidVal) {
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
  openModal("Remove employee?", `
    <p class="muted" style="margin-top:0">This action can't be undone.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Remove</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.employees = DB.employees.filter(e => e.uid !== uidVal);
      saveDB(); closeModal(); toast("Employee removed"); paintEmpTable();
    };
  });
}

/* =========================================================
   STOCK SUMMARY
   ========================================================= */
function renderStock() {
  const content = document.getElementById("content");
  const rows = computeStockSummary();
  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h2>Stock Summary</h2><div class="sub">Auto-calculated from Asset Assignment + Stock Refill Log. Repair / Faulty / Lost / Scrap and Threshold are editable.</div></div>
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
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="underRepair" value="${r.underRepair}" style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="faulty" value="${r.faulty}" style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="lost" value="${r.lost}" style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="scrap" value="${r.scrap}" style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td><strong style="color:${r.available <= 0 ? 'var(--red)' : 'var(--text)'}">${r.available}</strong></td>
              <td><input type="number" min="0" class="stock-edit" data-cat="${escapeHtml(r.category)}" data-field="threshold" value="${r.threshold}" style="width:64px;padding:5px 7px;border-radius:6px;border:1px solid var(--border)"></td>
              <td>${statusBadge(r.low ? "⚠ Low Stock" : "OK")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table></div>
    </div>
  `;
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

/* =========================================================
   STOCK REFILL LOG
   ========================================================= */
function renderRefill() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h2>Stock Refill Log</h2><div class="sub">Every entry here increases "Total Stock" on the Stock Summary page</div></div>
        <button class="btn btn-primary" id="addRefillBtn">+ Log Refill</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Category</th><th>Quantity Added</th><th>Added By</th><th>Source / Remarks</th><th></th></tr></thead>
        <tbody id="refillTbody"></tbody>
      </table></div>
    </div>
  `;
  document.getElementById("addRefillBtn").onclick = () => openRefillForm();
  paintRefillTable();
}

function paintRefillTable() {
  const tbody = document.getElementById("refillTbody");
  if (!tbody) return;
  const rows = [...DB.refills].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${fmtDate(r.date)}</td>
      <td>${escapeHtml(r.category)}</td>
      <td><strong>+${r.quantity}</strong></td>
      <td>${escapeHtml(r.addedBy || "—")}</td>
      <td>${escapeHtml(r.source || "—")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteRefill('${r.uid}')">🗑️</button>
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="6">No refill entries yet</td></tr>`;
}

function openRefillForm() {
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
  openModal("Delete refill entry?", `
    <p class="muted" style="margin-top:0">This will reduce Total Stock for that category.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.refills = DB.refills.filter(r => r.uid !== uidVal);
      saveDB(); closeModal(); toast("Refill entry deleted"); paintRefillTable();
    };
  });
}

/* =========================================================
   ASSET CATEGORIES
   ========================================================= */
function renderCategories() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h2>Asset Categories</h2><div class="sub">Categories power dropdowns across Assignment, Inventory and Stock Summary</div></div>
        <button class="btn btn-primary" id="addCatBtn">+ Add Category</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Category</th><th>Description / Notes</th><th></th></tr></thead>
        <tbody id="catTbody"></tbody>
      </table></div>
    </div>
  `;
  document.getElementById("addCatBtn").onclick = () => openCatForm();
  paintCatTable();
}

function paintCatTable() {
  const tbody = document.getElementById("catTbody");
  if (!tbody) return;
  tbody.innerHTML = DB.categories.length ? DB.categories.map(c => `
    <tr>
      <td><strong>${escapeHtml(c.name)}</strong></td>
      <td>${escapeHtml(c.notes || "—")}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-secondary btn-sm btn-icon" onclick="openCatForm('${c.uid}')">✏️</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCat('${c.uid}')">🗑️</button>
        </div>
      </td>
    </tr>
  `).join("") : `<tr class="empty-row"><td colspan="3">No categories yet</td></tr>`;
}

function openCatForm(uidVal) {
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
  openModal("Delete category?", `
    <p class="muted" style="margin-top:0">Existing assignments and refill entries referencing it will keep their history but stop appearing in dropdowns.</p>
    <div class="form-actions">
      <button class="btn btn-secondary" id="cancelDel">Cancel</button>
      <button class="btn btn-danger" id="confirmDel">Delete</button>
    </div>`, () => {
    document.getElementById("cancelDel").onclick = closeModal;
    document.getElementById("confirmDel").onclick = () => {
      DB.categories = DB.categories.filter(c => c.uid !== uidVal);
      saveDB(); closeModal(); toast("Category deleted"); paintCatTable();
    };
  });
}

/* =========================================================
   SETTINGS — manage dropdown lists
   ========================================================= */
function renderSettings() {
  const content = document.getElementById("content");
  const listDefs = [
    { key: "department", label: "Departments" },
    { key: "floor", label: "Floors" },
    { key: "condition", label: "Asset Conditions" },
    { key: "status", label: "Asset Statuses" },
    { key: "assignmentStatus", label: "Assignment Statuses" },
  ];

  content.innerHTML = `
    <div class="card" style="margin-bottom:18px">
      <div class="card-header"><div><h2>Dropdown Lists</h2><div class="sub">These values populate the selectors throughout the app</div></div></div>
      <div class="grid-2" id="listsGrid" style="grid-template-columns:1fr 1fr"></div>
    </div>
    <div class="card">
      <div class="card-header"><div><h2>Data</h2><div class="sub">Everything is stored only in this browser (localStorage) — nothing is sent to a server</div></div></div>
      <p class="muted">Use the <strong>Reset Data</strong> button in the sidebar to restore the original sheet contents at any time.</p>
    </div>
  `;

  const grid = document.getElementById("listsGrid");
  grid.innerHTML = listDefs.map(ld => `
    <div>
      <div class="section-title" style="margin-top:0">${ld.label}</div>
      <div id="chips_${ld.key}"></div>
      <div class="list-editor">
        <input type="text" id="add_${ld.key}" placeholder="Add new ${ld.label.toLowerCase().slice(0,-1)}...">
        <button class="btn btn-secondary btn-sm" data-key="${ld.key}">Add</button>
      </div>
    </div>
  `).join("");

  listDefs.forEach(ld => paintChips(ld.key));

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

function paintChips(key) {
  const el = document.getElementById(`chips_${key}`);
  if (!el) return;
  const items = DB.lists[key] || [];
  el.innerHTML = items.length ? items.map(v => `
    <span class="tag-chip">${escapeHtml(v)} <span style="cursor:pointer;color:var(--red)" onclick="removeListItem('${key}','${encodeURIComponent(v)}')">✕</span></span>
  `).join("") : `<p class="muted" style="font-size:12.5px">No values yet</p>`;
}

function removeListItem(key, encodedVal) {
  const val = decodeURIComponent(encodedVal);
  DB.lists[key] = (DB.lists[key] || []).filter(v => v !== val);
  saveDB();
  paintChips(key);
  toast("Removed");
}

/* =========================================================
   INIT
   ========================================================= */
function init() {
  DB = loadDB();
  if (!DB.inventory) DB.inventory = [];
  saveDB();
  goto("dashboard");
}
document.addEventListener("DOMContentLoaded", init);

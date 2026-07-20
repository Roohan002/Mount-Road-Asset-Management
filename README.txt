MOUNT ROAD OFFICE — ASSET MANAGEMENT WEB APP
=============================================

HOW TO RUN
-----------
1. Unzip this folder anywhere on your computer.
2. Double-click "index.html" to open it in your browser (Chrome/Edge recommended).
   That's it — no installation, no internet connection required.

WHAT'S INSIDE (mirrors your original Excel workbook)
------------------------------------------------------
- Dashboard          -> same live counters as your "Dashboard" sheet
- Asset Assignment   -> same table/fields as "Asset Assignment" sheet
- Master Inventory   -> individual asset register (Asset ID, brand, serial, warranty, etc.)
- Employees          -> same list as "Employees" sheet
- Stock Summary      -> auto-calculated exactly like your formulas:
                           Total Stock      = SUM of Stock Refill Log quantities
                           Assigned/In Use  = COUNT of "Assigned" rows in Asset Assignment
                           Available        = Total - Assigned - Repair - Faulty - Lost - Scrap
                           Stock Alert      = "Low Stock" when Available <= Threshold
- Stock Refill Log   -> add stock; it automatically raises Total Stock above
- Asset Categories   -> manage the categories used everywhere else
- Settings           -> edit the dropdown lists (Departments, Floors, Conditions, Statuses)

DATA
----
All your original sheet data (241 employees, 50 assignments, 9 categories,
9 refill log entries) is pre-loaded the first time you open the app.

From then on, everything you add, edit or delete is saved automatically in your
browser's local storage — it stays on your machine only, nothing is uploaded
anywhere. If you want to wipe your changes and go back to the original sheet
data, click "Reset Data" in the bottom-left of the sidebar.

NOTE: Because data lives in the browser's local storage, it is tied to that
specific browser on that specific computer. If you open index.html in a
different browser or on a different PC, it will start again from the original
sheet data. If you'd like a version with shared/cloud data everyone on your
team can access, let me know and I can help set that up.

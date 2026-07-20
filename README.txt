MOUNT ROAD OFFICE — ASSET MANAGEMENT WEB APP
=============================================
Now backed by Firebase, so data is stored online and anyone with the link
can view it live — signed-in admins can edit it.

------------------------------------------------------------
PART 1 — CONNECT THE APP TO YOUR OWN FIREBASE PROJECT
------------------------------------------------------------
This is a one-time setup, ~10 minutes.

1. Go to https://console.firebase.google.com and sign in with a Google
   account. Click "Add project" (the free "Spark" plan is enough for this).

2. Once the project is created, on the project Overview page click the
   </> icon ("Web") to register a web app. Give it any nickname (e.g.
   "asset-tracker") — you do NOT need to tick "Firebase Hosting" here.

3. Firebase will show you a code block containing a `firebaseConfig`
   object with values like apiKey, authDomain, projectId, etc.
   Open js/firebase-config.js in this folder with a text editor and
   paste those values in, replacing the YOUR_... placeholders. Save.

4. Back in the Firebase console, in the left sidebar under "Build":
     a) Firestore Database -> "Create database" -> start in
        PRODUCTION mode -> pick any region -> Enable.
     b) Authentication -> "Get started" -> Sign-in method tab ->
        enable "Email/Password" -> Save.
     c) Authentication -> Users tab -> "Add user" -> enter an email
        and password. This is your ADMIN LOGIN for the app (you can
        add more admin users the same way any time).

5. Still in Firestore Database, go to the "Rules" tab, delete the
   existing text, and paste in the contents of firestore.rules
   (included in this folder). Click "Publish".
   These rules mean: anyone can VIEW the data, but only someone
   signed in (an admin you added in step 4c) can change it.

6. Open index.html in your browser. The first time it runs, it will
   automatically create the data in Firestore using the original
   sheet contents. From then on, every visitor sees that same live
   data, and it updates in real time as admins make changes.

If you see a "Connect this app to Firebase" screen, it means step 3
still has placeholder values, or steps 4/5 aren't complete yet.

------------------------------------------------------------
PART 2 — LET ANYONE VIEW IT ONLINE (put it on the web)
------------------------------------------------------------
Right now, opening index.html only shows it on your own computer.
To give people a link, host the files somewhere. The easiest option,
since you're already using Firebase, is Firebase Hosting (also free):

1. Install Node.js from https://nodejs.org if you don't have it.
2. Open a terminal in this folder and run:
     npm install -g firebase-tools
     firebase login
     firebase init hosting
       - choose "Use an existing project" -> pick the project from Part 1
       - public directory: type "." (a single dot, meaning this folder)
       - configure as a single-page app: No
       - don't overwrite index.html when asked
3. Deploy:
     firebase deploy --only hosting
4. Firebase will print a URL like https://your-project.web.app —
   share that link with anyone you want to be able to view (or, if
   they sign in as admin, edit) the tracker.

(Alternatives if you'd rather not use Firebase Hosting: any static
host works the same way — Netlify, Vercel, GitHub Pages, etc. — just
upload the whole folder including js/firebase-config.js.)

------------------------------------------------------------
WHAT'S INSIDE (mirrors your original Excel workbook)
------------------------------------------------------------
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

ADMIN vs VIEWER MODE
---------------------
The app opens in VIEWER mode — anyone with the link can browse and search,
but add / edit / delete / import buttons are hidden and Stock Summary fields
are locked.

To make changes, click "Admin Sign In" at the bottom of the sidebar and sign
in with an admin email/password you created in Part 1, step 4c. Click
"Sign Out" to go back to Viewer mode. You can add as many admin accounts as
you like from Authentication > Users in the Firebase console — no code
changes needed.

Security note: the actual write protection is enforced by your Firestore
Rules (Part 1, step 5) on Google's servers, not just by this webpage — so
this is real access control, not just a UI toggle.

BULK DELETE
-----------
On Asset Assignment, Master Inventory, Employees, Stock Refill Log and Asset
Categories (Admin mode), each row has a checkbox. Tick the ones you want and
click "Delete Selected", use "Select All" in the header to tick everything
currently shown, or click "Delete All" to clear every row matching your
current search/filter in one go.

AUTO-FILL ON ASSET ASSIGNMENT
------------------------------
When you type or pick an Employee Name (Admin mode, "+ New Assignment"), if
that name matches someone in your Employees list, their Employee ID and
Department fields fill in automatically.

BULK-IMPORT EMPLOYEES
----------------------
On the Employees page (Admin mode), click "Upload CSV / Excel" and choose a
.csv, .xlsx or .xls file. Expected columns (any order, case-insensitive):
Employee ID, Employee Name, Department, Email, Phone — extra columns are
ignored. Rows are matched to existing employees by ID (or by name+department)
and updated; anything new is added. You'll see a summary of how many were
added/updated/skipped after the import.

DATA & LIVE SYNC
-----------------
All data (241 employees, 50 assignments, 9 categories, 9 refill log entries)
is loaded into your Firestore database automatically the very first time the
app connects. After that, everyone who opens the link — whether Viewer or
Admin — sees the same live data, and any change an admin makes appears on
every other open browser within a second or two, no refresh needed.

"Reset Data" in the sidebar (Admin mode) restores everyone's view back to
the original sheet contents — use it carefully, since it affects all users.

TROUBLESHOOTING
-----------------
- "Connect this app to Firebase" screen -> js/firebase-config.js still has
  placeholder values, or Firestore/Authentication aren't enabled yet.
- Spinner never finishes -> check your Firestore Rules are published
  (Part 1, step 5) and that you have an internet connection.
- "Missing or insufficient permissions" when signed in as admin -> the
  Rules weren't published, or you're signed into the wrong Firebase project.
- Forgot the admin password -> Firebase console > Authentication > Users >
  select the user > Reset password (or just add a new admin user).

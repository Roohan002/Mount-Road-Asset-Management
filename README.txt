SPEELFINANCE — ASSET MANAGEMENT WEB APP
=============================================
Backed by Firebase — data is stored online and private: nobody can view or
edit anything unless they sign in with an account you create for them, and
only Admins (not Viewers) can make changes — see "ADMIN vs VIEWER" below.

IF YOUR APP IS ALREADY LIVE: this update adds real Admin/Viewer roles.
You MUST (1) re-publish firestore.rules (Part 1, step 5) and (2) do the
one-time "ONE-TIME SETUP STEP" under "ADMIN vs VIEWER" below to grant
yourself Admin again — otherwise everyone, including you, will only be
able to view, not edit, until that's done.

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
        and password for EVERYONE who should be able to open this app
        at all (there's no public/guest view — see "LOGIN REQUIRED"
        below). Add yourself first; add more people the same way any time.

5. Still in Firestore Database, go to the "Rules" tab, delete the
   existing text, and paste in the contents of firestore.rules
   (included in this folder). Click "Publish".
   These rules mean: nobody can view OR change the data unless they're
   signed in with an account you added in step 4c.

6. Open index.html in your browser. You'll be asked to sign in. The
   first time anyone signs in, the app automatically creates the data
   in Firestore using the original sheet contents. From then on, every
   signed-in visitor sees that same live data, updating in real time.

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
   share that link with anyone you've added a login for in step 4c.
   Nobody else will be able to see any data — they'll just get a
   sign-in screen.

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

LOGIN REQUIRED — NOBODY CAN VIEW WITHOUT SIGNING IN
-----------------------------------------------------
This app shows nothing at all until you sign in. Opening the link (or
index.html) always presents a "Sign in required" screen first. Only people
you've added under Authentication > Users in the Firebase console (Part 1,
step 4c) can sign in at all — but signing in only gets you as far as
Viewer access (read-only) unless you've also been given the Admin role
(see the next section).

Click "Sign Out" at the bottom of the sidebar to leave; you'll be dropped
straight back to the sign-in screen. Removing someone from Authentication >
Users instantly cuts off their access completely (they can no longer even
sign in) — no code changes needed.

Security note: this is enforced by your Firestore Rules (Part 1, step 5) on
Google's servers, not just by this webpage — so it's real access control,
not just a UI toggle. Someone without a login cannot see your data even if
they inspect the page's code, and a Viewer genuinely cannot write data even
if they inspect the page's code.

ADMIN vs VIEWER — WHO CAN EDIT
---------------------------------
There are now three levels:
  - Viewer: can sign in, browse, and search every office. No add / edit /
    delete / import / reset buttons.
  - Office Admin: full edit access, but for ONE specific office only.
    Granted per-office from Settings > "Office Access" (while that office
    is open) — Super Admin only to grant.
  - Super Admin: full edit access everywhere, plus can create/delete
    offices and grant Office Admin/Viewer access to anyone, anywhere.
    Managed from Settings > "Super Admins" (Super Admin only).

Change or remove someone's access any time — it takes effect immediately,
even on devices where they're already signed in. Everyone signed in can
still browse and search every office regardless of role (only editing is
restricted) — that keeps things simple and avoids anyone getting locked
out of viewing by accident.

*** ONE-TIME SETUP STEP — DO THIS OR NOBODY CAN EDIT ANYTHING ***
Settings itself requires being a Super Admin to manage roles — a
chicken-and-egg problem for the very first person. To grant yourself
Super Admin the first time, do this once directly in the Firebase console:

  1. Firebase console > Build > Firestore Database > Data tab.
  2. Click "Start collection". Collection ID: roles
  3. Document ID: type your exact login email (e.g. you@company.com).
  4. Add a field: name "role", type "string", value "admin". Save.
  5. Reload index.html and sign in — you're now a Super Admin, and can
     grant access to everyone else from Settings instead of repeating
     this console step.

If you update firestore.rules on an app that was already live and skip
this step, every existing user (including you) drops to Viewer-only
until you complete it once.

CONCURRENT EDITS — SAFE BY DESIGN
------------------------------------
Employees, Assignments, Inventory, the Refill Log, and Categories are each
stored as individual documents in Firestore, not one shared file. Two
Admins editing DIFFERENT records at the same time can never overwrite
each other's work — only two edits to the exact same record at the exact
same instant fall back to normal last-write-wins, same as any database.
(Dropdown Lists and Stock Summary's manual repair/faulty/lost/scrap/
threshold numbers still share one small settings document per office,
since those change far less often — a much smaller residual risk.)

If an office still has its older, single-document data from before this
update, the app converts it automatically and safely the next time
anyone opens that office — no action needed on your part.

YOUR REAL EMPLOYEE DATA IS NO LONGER IN THE PUBLIC WEBSITE FILES
--------------------------------------------------------------------
Previously, js/data.js — a file that loads in every visitor's browser
before any login check — contained your actual employee names, IDs,
departments, and assignment history in plain text. Anyone could open
Chrome DevTools > Sources and read it, no account needed. That's now
fixed: js/data.js only contains generic, non-sensitive defaults (category
names like "PC"/"Headphone", dropdown option lists, stock thresholds).
Your real data lives only in Firestore, behind the sign-in wall.

Your original data isn't lost — it's saved in
admin-tools_DO_NOT_UPLOAD/seed-data.json, alongside a Node.js script to
re-seed a Firestore office from it if you ever need to (see that folder's
own README). As the folder name says: never upload that folder to your
website — keep it on your own computer only.

ABOUT THE FIREBASE API KEY BEING VISIBLE
--------------------------------------------
If you've inspected js/firebase-config.js and noticed the apiKey is
readable — that's expected and not a security bug. Unlike a password or
a server secret key, a Firebase Web API key isn't meant to be secret; it
just tells your browser which Firebase project to talk to. Every
Firebase web app in existence ships this the same way (Google's own
docs confirm this). Your actual protection is:
  - Firestore Security Rules (firestore.rules) — nobody can read or
    write data without being signed in, exactly as before.
  - Firebase Authentication — only accounts you create can sign in.

Two optional extra hardening steps if you want to be extra cautious:
  1. Restrict the API key to your domain: Google Cloud Console
     (console.cloud.google.com) > APIs & Services > Credentials > click
     your Firebase API key > "Application restrictions" > "Websites" >
     add your Netlify domain (and localhost if you test locally).
     This stops the key from being usable from any other website.
  2. Enable Firebase App Check (Firebase console > Build > App Check)
     for an extra layer against automated abuse of your project.
Neither is required for your data to be safe — Firestore Rules already
handle that — but both are good practice once you're comfortable.

ASSET HANDOVER SLIPS (PDF)
-------------------------------
On the Asset Assignment page, click the 📄 icon on any row to generate a
signed PDF handover slip — asset + employee details, a declaration of
receipt, and an optional on-screen signature (draw with mouse or finger)
embedded into the PDF. Downloads straight to your device; every slip
generated is recorded in the Activity Log.

REPORTS — EXPORT TO EXCEL
-----------------------------
The "Reports" page lets you export any module (Employees, Assignments,
Inventory, Stock Summary, Refill Log, Categories, Activity Log) as its own
.xlsx file, or click "Export Full Workbook" for one Excel file with every
module as its own sheet — handy for sharing a snapshot with someone
outside the app, or for your own backups.

ACTIVITY LOG — TRACE WHO DID WHAT
------------------------------------
Since multiple people can sign in, every add, edit, delete, import, and
reset is recorded to the "Activity Log" page in the sidebar — showing the
timestamp, the signed-in email that did it, the action, and what changed.
Search and filter by user to trace down a specific mistake.

Each office keeps its own completely separate activity log, matching how
each office's data is separate — actions in "Andheri Branch" never show up
in "Main Office"'s log, and vice versa.

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
app connects. After that, everyone who signs in sees the same live data, and
any change one person makes appears on every other signed-in browser within a second or two, no refresh needed.

"Reset Data" in the sidebar restores everyone's view back to the original
sheet contents — use it carefully, since it affects all users. As an extra
safety net, it now also asks for a confirmation password before it will run:

    Confirmation password: reset123

You can change this yourself by opening js/app.js, finding the line
`const RESET_CONFIRM_PASSWORD = "reset123";` near the Reset Data button
handler, and editing the text between the quotes.

MULTIPLE OFFICES / LOCATIONS
-----------------
This app supports multiple offices (e.g. different branches/cities), each
with its own completely separate, independent data — nothing syncs between
offices.

- After signing in, you'll see an "Select an Office" screen. Click an office
  to open its dashboard, or click "+ Add New Office" to create a new one
  (enter an Office Name and City — a brand-new office starts empty).
- Use "Switch Office" at the bottom of the sidebar at any time to go back to
  this screen and open a different office without signing out.
- Every office's data lives in its own Firestore document, so edits, resets,
  and imports in one office never affect any other office.
- To remove an office entirely (and permanently delete all its data), hover
  its card on the "Select an Office" screen and click the ✕ button. You can't
  delete the last remaining office.
- The original data from this download becomes the first office automatically
  (named "Mount Road" / "Mumbai" by default) — you can rename this later by
  deleting it and re-adding your preferred name once you've moved any data
  you want to keep, or just leave it as-is and add new offices alongside it.

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

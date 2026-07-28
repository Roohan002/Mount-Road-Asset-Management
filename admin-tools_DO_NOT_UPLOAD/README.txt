ADMIN-ONLY SEEDING TOOL — DO NOT UPLOAD THIS FOLDER TO YOUR WEBSITE
======================================================================

WHY THIS EXISTS
------------------------------------------------------------
Previously, js/data.js (part of the public website) contained your
real employee names, IDs, departments, asset categories, and
assignment history in plain text. That file loads in every visitor's
browser the instant they open the site — before any login check runs.
Anyone could open DevTools > Sources and read it, no account needed.

That data has now been removed from the public website. This folder
holds it instead, safely, for one purpose only: seeding Firestore
directly using the Firebase Admin SDK, which runs on your own
computer — never in a visitor's browser.

FILES IN THIS FOLDER
------------------------------------------------------------
- seed-data.json        Your original employees / categories /
                         assignments / refills / dropdown lists.
- seed-firestore.js      Node.js script that pushes seed-data.json
                         into Firestore using an admin service account.
- serviceAccountKey.json You provide this yourself (see setup below).
                         NEVER share or upload this file — it grants
                         full read/write access to your Firestore data.

DO YOU EVEN NEED TO RUN THIS?
------------------------------------------------------------
Almost certainly not right now. If your app is already live and your
"Mount Road" (or other) office already shows real data when you sign
in, that data is already sitting safely in Firestore — the app reads
it from there, not from data.js. Removing data.js's contents doesn't
touch what's already in your database.

Use this script only if:
- You're setting up a brand-new Firebase project from scratch and
  want it pre-loaded with the original dataset, or
- You need to restore an office's data from this backup.

SETUP (one time)
------------------------------------------------------------
1. Firebase Console > Project Settings > Service Accounts >
   "Generate new private key". Save the downloaded file in this
   folder as serviceAccountKey.json.
2. In this folder, run:
     npm install firebase-admin

USAGE
------------------------------------------------------------
   node seed-firestore.js <office-id>
   node seed-firestore.js <office-id> --force   (to overwrite existing data)

Example, matching your existing office id:
   node seed-firestore.js data

The script refuses to overwrite an office that already has data,
unless you pass --force — so it's safe to run without double-checking
first.

AFTER YOU'RE DONE
------------------------------------------------------------
Keep this whole folder somewhere private (your own computer, a
password manager's file storage, or a private git repo — never a
public one). Delete serviceAccountKey.json when you're not actively
using it, and regenerate a new one from the Firebase Console if you
ever think it's been exposed.

BACKUPS — backup-firestore.js / restore-firestore.js
------------------------------------------------------------
These two are separate from seed-firestore.js above, and are the ones
you actually want for ongoing safety:

- backup-firestore.js exports every office's live data (or just one,
  if you name it) into a timestamped JSON file under ./backups/.
  Run it any time with:
      node backup-firestore.js
      node backup-firestore.js <office-id>

- restore-firestore.js puts a backup file back into Firestore for one
  office. It refuses to overwrite an office that already has data
  unless you pass --force:
      node restore-firestore.js backups/backup_all_2026-07-27T....json mount-road --force

For these to be genuinely "automated" rather than something you have
to remember to run, schedule backup-firestore.js:
  Windows: Task Scheduler > Create Basic Task > Daily trigger >
    Action = start node.exe with argument backup-firestore.js,
    "Start in" set to this folder.
  Mac/Linux: crontab -e, add a line like
    0 2 * * * cd /path/to/this/folder && node backup-firestore.js
    (runs every night at 2am)

A local-only backup doesn't help if the computer running it dies —
periodically copy the backups/ folder somewhere else too (a cloud
drive, an external disk, wherever).

For a quick one-off snapshot without touching a terminal at all, the
web app itself also has a "Download Backup (JSON)" button on the
Reports page — handy in the moment, but it only runs when someone
clicks it, so it's not a substitute for the scheduled script above.

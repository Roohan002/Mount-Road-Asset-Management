/**
 * backup-firestore.js
 * ------------------------------------------------------------------
 * ONE-TIME-PER-RUN, LOCAL-ONLY script that exports every office's
 * complete data (employees, assignments, inventory, refill log,
 * categories, dropdown lists, stock summary settings, and the
 * activity log) out of Firestore into a single timestamped JSON file
 * on your own computer.
 *
 * This never runs in the browser and is never part of the deployed
 * website. Run it on your own machine (or a server you control) with
 * a service account key that has read access, on whatever schedule
 * you like — that's what makes it "automated backups": Firestore
 * itself doesn't back things up for you on the free plan, so this
 * script is your safety net.
 *
 * SETUP (one time, same as seed-firestore.js)
 * -----------------------------------------------
 * 1. Firebase Console > Project Settings > Service Accounts >
 *    "Generate new private key" > save as serviceAccountKey.json in
 *    this same folder. Never share or upload this file anywhere.
 * 2. npm install firebase-admin
 *
 * USAGE
 * -----
 *   node backup-firestore.js                 backs up every office
 *   node backup-firestore.js <office-id>      backs up just one office
 *
 * Output goes to ./backups/backup_<office-id-or-all>_<timestamp>.json
 *
 * SCHEDULING IT ("automated")
 * -------------------------------
 * Windows: Task Scheduler > Create Basic Task > Trigger: Daily >
 *   Action: Start a program > Program: node.exe >
 *   Arguments: backup-firestore.js > Start in: this folder's path.
 * Mac/Linux: crontab -e, then add a line like:
 *   0 2 * * * cd /path/to/admin-tools_DO_NOT_UPLOAD && /usr/local/bin/node backup-firestore.js
 *   (runs every day at 2am)
 * Either way, also back up the whole "backups" folder itself
 * somewhere off this computer occasionally (a cloud drive, an
 * external disk) — a local-only backup doesn't help if this
 * computer is the thing that fails.
 *
 * RESTORING A BACKUP
 * -----------------------
 * See restore-firestore.js in this same folder.
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const FIRESTORE_COLLECTION = "assetTracker"; // must match FIRESTORE_COLLECTION in js/app.js
const OFFICES_DOC_ID = "_offices";
const SUBCOLLECTIONS = ["employees", "assignments", "inventory", "refills", "categories", "logs"];

async function readCollection(ref, name) {
  const snap = await ref.collection(name).get();
  const items = [];
  snap.forEach(doc => items.push(doc.data()));
  return items;
}

async function main() {
  const onlyOfficeId = process.argv[2];

  const keyPath = path.join(__dirname, "serviceAccountKey.json");
  if (!fs.existsSync(keyPath)) {
    console.error(
      "Missing serviceAccountKey.json in this folder.\n" +
      "Download it from Firebase Console > Project Settings > Service Accounts > Generate new private key."
    );
    process.exit(1);
  }

  let admin;
  try {
    admin = require("firebase-admin");
  } catch {
    console.error('Missing dependency. Run "npm install firebase-admin" in this folder first.');
    process.exit(1);
  }

  const serviceAccount = require(keyPath);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const officesDoc = await db.collection(FIRESTORE_COLLECTION).doc(OFFICES_DOC_ID).get();
  const officeList = (officesDoc.exists && Array.isArray(officesDoc.data().offices)) ? officesDoc.data().offices : [];
  const targets = onlyOfficeId ? officeList.filter(o => o.id === onlyOfficeId) : officeList;

  if (!targets.length) {
    console.error(onlyOfficeId ? `No office found with id "${onlyOfficeId}".` : "No offices found in the directory — nothing to back up.");
    process.exit(1);
  }

  const backup = { generatedAt: new Date().toISOString(), officeDirectory: officeList, offices: {} };

  for (const office of targets) {
    console.log(`Backing up "${office.name}" (${office.id})...`);
    const ref = db.collection(FIRESTORE_COLLECTION).doc(office.id);
    const metaSnap = await ref.get();
    const meta = metaSnap.exists ? metaSnap.data() : {};

    const officeBackup = { info: office, lists: meta.lists || {}, stockManual: meta.stockManual || {} };
    for (const sub of SUBCOLLECTIONS) {
      officeBackup[sub] = await readCollection(ref, sub);
    }
    backup.offices[office.id] = officeBackup;

    console.log(
      `  ${officeBackup.employees.length} employees, ${officeBackup.assignments.length} assignments, ` +
      `${officeBackup.inventory.length} inventory, ${officeBackup.refills.length} refills, ` +
      `${officeBackup.categories.length} categories, ${officeBackup.logs.length} log entries.`
    );
  }

  const outDir = path.join(__dirname, "backups");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `backup_${onlyOfficeId || "all"}_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(backup, null, 2));

  console.log(`\n✔ Backup saved to ${outFile}`);
  process.exit(0);
}

main().catch(err => {
  console.error("Backup failed:", err);
  process.exit(1);
});

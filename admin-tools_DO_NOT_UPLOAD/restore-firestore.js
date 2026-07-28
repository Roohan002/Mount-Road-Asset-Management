/**
 * restore-firestore.js
 * ------------------------------------------------------------------
 * ONE-TIME, LOCAL-ONLY script that restores one office's data from a
 * JSON file produced by backup-firestore.js back into Firestore.
 *
 * By default this REFUSES to touch an office that already has data,
 * to stop you from accidentally wiping something. Pass --force if
 * you really do want to overwrite it (e.g. recovering from a mistake).
 *
 * SETUP: same as backup-firestore.js (serviceAccountKey.json +
 * npm install firebase-admin), run from this same folder.
 *
 * USAGE
 * -----
 *   node restore-firestore.js <backup-file.json> <office-id>
 *   node restore-firestore.js <backup-file.json> <office-id> --force
 *
 * Example:
 *   node restore-firestore.js backups/backup_all_2026-07-27T10-00-00-000Z.json mount-road --force
 *
 * <office-id> must be a key inside the backup file's "offices" object
 * (the script will list the available ones if you get it wrong).
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const FIRESTORE_COLLECTION = "assetTracker"; // must match FIRESTORE_COLLECTION in js/app.js
const OFFICES_DOC_ID = "_offices";
const SUBCOLLECTIONS = ["employees", "assignments", "inventory", "refills", "categories", "logs"];

async function clearCollection(ref, name) {
  const snap = await ref.collection(name).get();
  if (snap.empty) return;
  const batch = ref.firestore.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

async function writeCollection(ref, name, items) {
  if (!items.length) return;
  for (let i = 0; i < items.length; i += 400) {
    const batch = ref.firestore.batch();
    items.slice(i, i + 400).forEach(item => {
      if (!item.uid) return; // logs use auto-ids, not "uid" — handled separately below
      batch.set(ref.collection(name).doc(item.uid), item);
    });
    await batch.commit();
  }
}

async function main() {
  const backupFile = process.argv[2];
  const officeId = process.argv[3];
  const force = process.argv.includes("--force");

  if (!backupFile || !officeId) {
    console.error("Usage: node restore-firestore.js <backup-file.json> <office-id> [--force]");
    process.exit(1);
  }

  const keyPath = path.join(__dirname, "serviceAccountKey.json");
  if (!fs.existsSync(keyPath)) {
    console.error("Missing serviceAccountKey.json in this folder — see the comment at the top of backup-firestore.js for setup steps.");
    process.exit(1);
  }
  const backupPath = path.isAbsolute(backupFile) ? backupFile : path.join(__dirname, backupFile);
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup file not found: ${backupPath}`);
    process.exit(1);
  }

  let admin;
  try {
    admin = require("firebase-admin");
  } catch {
    console.error('Missing dependency. Run "npm install firebase-admin" in this folder first.');
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const officeBackup = backup.offices && backup.offices[officeId];
  if (!officeBackup) {
    console.error(`"${officeId}" isn't in this backup file. Offices available: ${Object.keys(backup.offices || {}).join(", ") || "(none)"}`);
    process.exit(1);
  }

  const serviceAccount = require(keyPath);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const ref = db.collection(FIRESTORE_COLLECTION).doc(officeId);
  const existingSnap = await ref.get();
  const hasExistingEmployees = (await ref.collection("employees").limit(1).get()).size > 0;
  if ((existingSnap.exists || hasExistingEmployees) && !force) {
    console.error(
      `Office "${officeId}" already has data in Firestore. Nothing was changed.\n` +
      `Re-run with --force if you really want to overwrite it with the backup.`
    );
    process.exit(1);
  }

  if (force) {
    console.log("Clearing existing data for this office first...");
    for (const sub of SUBCOLLECTIONS) await clearCollection(ref, sub);
  }

  console.log(`Restoring "${officeBackup.info ? officeBackup.info.name : officeId}"...`);
  await ref.set({ lists: officeBackup.lists || {}, stockManual: officeBackup.stockManual || {} });
  for (const sub of SUBCOLLECTIONS) {
    if (sub === "logs") {
      // Logs use Firestore auto-generated ids, not a "uid" field — add them individually
      // instead of via the uid-keyed writeCollection helper used for everything else.
      const items = officeBackup.logs || [];
      for (let i = 0; i < items.length; i += 400) {
        const batch = db.batch();
        items.slice(i, i + 400).forEach(item => batch.set(ref.collection("logs").doc(), item));
        await batch.commit();
      }
    } else {
      await writeCollection(ref, sub, officeBackup[sub] || []);
    }
  }

  // Make sure the office still appears in the directory (in case it was deleted there too).
  const officesRef = db.collection(FIRESTORE_COLLECTION).doc(OFFICES_DOC_ID);
  const officesSnap = await officesRef.get();
  const officeList = (officesSnap.exists && Array.isArray(officesSnap.data().offices)) ? officesSnap.data().offices : [];
  if (!officeList.some(o => o.id === officeId) && officeBackup.info) {
    officeList.push(officeBackup.info);
    await officesRef.set({ offices: officeList });
    console.log("  Re-added this office to the office directory.");
  }

  console.log(`\n✔ Restored "${officeId}" from ${path.basename(backupPath)}.`);
  process.exit(0);
}

main().catch(err => {
  console.error("Restore failed:", err);
  process.exit(1);
});

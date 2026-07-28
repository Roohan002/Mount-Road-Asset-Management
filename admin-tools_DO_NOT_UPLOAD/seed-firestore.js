/**
 * seed-firestore.js
 * ------------------------------------------------------------------
 * ONE-TIME, LOCAL-ONLY script to push the original Excel-derived data
 * (employees, categories, assignments, refills, dropdown lists) into
 * Firestore using the Admin SDK.
 *
 * This never runs in the browser and is never part of the deployed
 * website — that's the whole point. It runs on your own machine (or
 * a trusted server) with a service account key that has full write
 * access, and pushes the data straight into Firestore. The public
 * site then just reads that data after users sign in, the same way
 * it already does today.
 *
 * WHEN TO USE THIS
 * -----------------
 * - You are standing up a brand-new Firebase project for this app
 *   and want it pre-loaded with the original dataset, OR
 * - You need to restore/re-seed an office's data from this backup.
 *
 * You do NOT need this for your existing "Mount Road" office if it
 * already has data in Firestore — this script will refuse to
 * overwrite an office document that already exists, unless you pass
 * --force.
 *
 * SETUP (one time)
 * -----------------
 * 1. In the Firebase Console: Project Settings > Service Accounts >
 *    "Generate new private key". Save the downloaded JSON file as
 *    serviceAccountKey.json in this same folder.
 *    ⚠️ Never commit this file to git or upload it anywhere public —
 *    it grants full admin access to your Firestore database.
 * 2. Install the Admin SDK:
 *      npm install firebase-admin
 *
 * USAGE
 * -----
 *   node seed-firestore.js <office-id>
 *   node seed-firestore.js <office-id> --force
 *
 * Example (matches the office id already used by the deployed app):
 *   node seed-firestore.js data
 *
 * The script writes to:  assetTracker/<office-id>
 * (adjust FIRESTORE_COLLECTION below if your app.js uses a different
 * top-level collection name — check the FIRESTORE_COLLECTION
 * constant near the top of js/app.js in the web app).
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const FIRESTORE_COLLECTION = "assetTracker"; // must match FIRESTORE_COLLECTION in js/app.js

function uid() {
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

async function main() {
  const officeId = process.argv[2];
  const force = process.argv.includes("--force");

  if (!officeId) {
    console.error("Usage: node seed-firestore.js <office-id> [--force]");
    process.exit(1);
  }

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

  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-data.json"), "utf8"));

  const docRef = db.collection(FIRESTORE_COLLECTION).doc(officeId);
  const existing = await docRef.get();
  if (existing.exists && !force) {
    console.error(
      `Office "${officeId}" already has data in Firestore. Nothing was changed.\n` +
      `Re-run with --force if you really want to overwrite it.`
    );
    process.exit(1);
  }

  const officeData = {
    employees: seed.employees.map(e => ({ ...e, uid: uid() })),
    categories: seed.categories.map(c => ({ ...c, uid: uid() })),
    lists: seed.lists,
    assignments: seed.assignments.map(a => ({ ...a, uid: uid() })),
    refills: seed.refills.map(r => ({ ...r, uid: uid() })),
    inventory: [],
    stockManual: seed.stockManual,
  };

  await docRef.set(officeData);

  console.log(`✔ Seeded office "${officeId}" in Firestore collection "${FIRESTORE_COLLECTION}".`);
  console.log(
    `  ${officeData.employees.length} employees, ${officeData.categories.length} categories, ` +
    `${officeData.assignments.length} assignments, ${officeData.refills.length} refill entries.`
  );
  process.exit(0);
}

main().catch(err => {
  console.error("Seeding failed:", err);
  process.exit(1);
});

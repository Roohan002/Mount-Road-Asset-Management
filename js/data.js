/**
 * data.js
 * ------------------------------------------------------------------
 * This file used to ship the app's real employee names, asset
 * categories, and assignment history directly in the page source —
 * which meant anyone visiting the site could read that data in
 * DevTools, before ever signing in.
 *
 * That data has been removed from here. Nothing in the app broke by
 * removing it: real data for every existing office already lives in
 * Firestore (see js/app.js -> loadInitialData / docRef), which is
 * what the app actually reads from after sign-in, protected by
 * firestore.rules.
 *
 * SEED_DATA below is now just a safe, empty starting skeleton. It's
 * still used in two places in js/app.js:
 *   1. emptyOfficeDB() — creating a brand-new office starts blank,
 *      but still gets the same dropdown option lists (status,
 *      condition, floor, department) so the forms work immediately.
 *   2. seedFromSource() — the one-time fallback if this app is ever
 *      pointed at a completely fresh Firestore project with no data
 *      in it yet. It will now seed an empty office rather than any
 *      real records.
 *
 * If you want to restore or re-seed real historical data (the
 * original employee/category/assignment records), use the one-time
 * admin script in the separate admin-tools/ folder — it runs locally
 * with the Firebase Admin SDK and writes straight to Firestore. It is
 * NOT part of this website and should never be uploaded to it.
 * ------------------------------------------------------------------
 */
const SEED_DATA = {
  "employees": [],
  "categories": [],
  "lists": {
    "status": [
      "Available",
      "Assigned",
      "Under Repair",
      "Faulty",
      "Lost",
      "Scrap"
    ],
    "condition": [
      "New",
      "Good",
      "Fair",
      "Poor",
      "Damaged"
    ],
    "floor": [
      "Ground Floor",
      "1st Floor",
      "2nd Floor",
      "3rd Floor",
      "4th Floor",
      "5th Floor"
    ],
    "department": [
      "VKYC",
      "KYC",
      "QA-KYC",
      "NS",
      "Salaried",
      "Support",
      "IT",
      "HR",
      "Finance",
      "Operations",
      "Sales",
      "Admin",
      "VKYC Audit",
      "Marketing",
      "Compliance",
      "Management"
    ],
    "assignmentStatus": [
      "Assigned",
      "Returned",
      "Overdue"
    ]
  },
  "assignments": [],
  "refills": [],
  "inventoryHeaders": [],
  "stockManual": {}
};

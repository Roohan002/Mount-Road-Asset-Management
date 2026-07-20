/* ============================================================
   FIREBASE CONFIGURATION — fill this in with YOUR project's values
   ============================================================
   1. Go to https://console.firebase.google.com and create a project
      (the free "Spark" plan is enough for this app).
   2. In your project: click the </> ("Web") icon to register a web app
      (any nickname is fine — you don't need Firebase Hosting for this step).
   3. Firebase will show you a firebaseConfig object. Copy each value
      into the object below, replacing the placeholder text.
   4. In the left sidebar of the Firebase console, turn on:
        Build > Firestore Database  -> "Create database" (start in
                                        production mode, pick any region)
        Build > Authentication > Sign-in method -> enable "Email/Password"
        Build > Authentication > Users -> "Add user" -> this becomes
                                        your admin login (email + password)
   5. In Build > Firestore Database > Rules, paste the rules shown in
      README.txt and click "Publish".
   6. Save this file and reload index.html — the app will connect
      automatically and load your data into Firestore the first time.
   ============================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyBQi_TMB9nniBAkOQ59DxC1YHAoDiGGm5g",
  authDomain: "mount-road-asset-management.firebaseapp.com",
  projectId: "mount-road-asset-management",
  storageBucket: "mount-road-asset-management.firebasestorage.app",
  messagingSenderId: "540107656369",
  appId: "1:540107656369:web:42120a3a6bd9805a406690"
};

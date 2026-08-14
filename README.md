# Spark & Ember — Fireworks Storefront

A single-page fireworks catalog with a customer cart/checkout and an admin panel for adding products (with image upload) and viewing submitted orders. Backend: **Firebase** (Firestore + Authentication) — free tier is enough for this.

## 1. Create the Firebase project (~5 min)

1. Go to https://console.firebase.google.com → **Add project** → name it (e.g. `wounderpyrotech`) → finish the wizard.
2. In the left sidebar: **Build → Firestore Database → Create database** → start in **Production mode** → pick any region → Enable.
3. **Build → Authentication → Get started → Sign-in method** → enable **Email/Password**.
4. **Authentication → Users → Add user** → create yourself an admin login (email + password). This is the account you'll use to log into the Admin panel on the live site.
5. **Project settings (gear icon) → General → Your apps → Add app → Web (`</>`)** → register it (no need for Firebase Hosting) → copy the `firebaseConfig` object it gives you.

## 2. Paste your config into the site

Open `index.html`, find this block near the top of the `<script>` section, and replace the placeholder values with the ones Firebase gave you:

```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

These values are safe to expose in client-side code (that's how Firebase web apps work) — access is controlled by the security rules below, not by hiding the keys.

## 3. Set Firestore security rules

In Firebase Console → **Firestore Database → Rules**, replace the contents with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /products/{productId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    match /orders/{orderId} {
      allow create: if true;
      allow read, update, delete: if request.auth != null;
    }
  }
}
```

This means: anyone can browse products and place an order, but only a signed-in admin can add/edit/delete products or read the order list. Click **Publish**.

## 4. Push to GitHub

From this folder:

```bash
git init
git add index.html README.md
git commit -m "Fireworks storefront with Firebase backend"
git branch -M main
git remote add origin https://github.com/sivamuruganszi/WounderPyroTech.git
git push -u origin main
```

If the repo already has commits/files, use instead:

```bash
git clone https://github.com/sivamuruganszi/WounderPyroTech.git
cp index.html README.md WounderPyroTech/
cd WounderPyroTech
git add .
git commit -m "Add fireworks storefront with Firebase backend"
git push
```

## 5. Turn on GitHub Pages

In the repo on GitHub: **Settings → Pages → Source → Deploy from a branch → Branch: `main`, folder: `/ (root)`** → Save.

Your site will be live in a minute or two at:
`https://sivamuruganszi.github.io/WounderPyroTech/`

## 6. Using it

- **Customers**: browse, add items to the box, submit the order form. Orders land in Firestore's `orders` collection instantly.
- **Admin**: click "Admin login" in the footer, sign in with the email/password you created in step 1.4. Add a product with an image — it's compressed client-side and saved straight to Firestore, and appears in the public catalog immediately for everyone.

## Notes & limits

- Product images are stored as compressed base64 JPEGs directly in each product's Firestore document (kept under ~480px / 60% quality to stay well within Firestore's 1MB-per-document limit). For a large catalog with many high-res photos, migrating to **Firebase Storage** (a proper file bucket) would scale better — ask if you'd like that swapped in.
- Firestore's free (Spark) tier includes 50K reads / 20K writes per day and 1GB storage — plenty for a small storefront, but worth knowing about if traffic grows.
- The public write rule on `orders` (`allow create: if true`) means anyone can submit an order form — this is intentional (that's the checkout), but there's no spam/rate protection. Consider adding Firebase App Check later if abuse becomes a problem.
- Only create admin accounts you trust in Authentication → Users — anyone signed in can add/delete products and read all customer orders.

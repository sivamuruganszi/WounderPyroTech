# Order WhatsApp notifications (Cloudflare Worker)

Sends a WhatsApp message via Twilio to the customer and to the store owner
right after a customer checks out on the site. Free to run (Cloudflare
Workers' free plan — no credit card needed), unlike the Firebase Cloud
Functions version this replaces.

## One-time setup

Run these from a terminal on your own machine, inside `worker/`. None of
this needs me — it's your Cloudflare account and your Twilio credentials,
entered only into your own terminal.

```bash
cd worker
npm install                 # installs wrangler (Cloudflare's CLI), local to this folder
npx wrangler login          # opens a browser to sign into (or create) your free Cloudflare account

# Store secrets (prompted, hidden input — use the values already in application.env):
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_WHATSAPP_FROM      # e.g. whatsapp:+14155238886
npx wrangler secret put OWNER_WHATSAPP_NUMBER     # e.g. +917708450260
npx wrangler secret put SITE_KEY
# ^ when prompted for SITE_KEY, paste this exact value: 92YXnpOoVajVqdYfWBM3lvj1K5oifai3
#   (a random string I generated — not a real credential, just enough to stop
#   casual/automated hits on the endpoint. It must match WHATSAPP_SITE_KEY in index.html.)

npx wrangler deploy
```

The last command prints your Worker's live URL, something like:
`https://wonderpyrotech-whatsapp.<your-subdomain>.workers.dev`

## Wire it up to the site

Open `index.html`, find this line (search for `WHATSAPP_NOTIFY_URL`):

```js
const WHATSAPP_NOTIFY_URL = 'PASTE_YOUR_WORKER_URL_HERE';
```

Replace it with the URL `wrangler deploy` printed. Push that change to
GitHub the same way as before (upload `index.html` through the GitHub web
UI, or ask me to do it).

## Before this works

- **Twilio WhatsApp sender**: `TWILIO_WHATSAPP_FROM` must be a number
  approved for WhatsApp — either Twilio's sandbox number (only reaches
  numbers that joined your sandbox) or your own Twilio number after
  WhatsApp Business approval.
- **Customer numbers**: the checkout form doesn't collect a country code,
  so the Worker assumes a 10-digit number is Indian and prefixes `+91`.
  Adjust `toE164()` in `src/index.js` if you ever sell outside India.
- **Abuse**: the `SITE_KEY` header check is a light deterrent, not real
  security — anything shipped to the browser is visible to anyone who
  inspects the page. This matches the risk level already accepted by
  `firestore.rules` (`orders` already accepts public writes). If spam ever
  becomes a real problem, look at Cloudflare's rate limiting rules (free
  plan includes a basic version) or Firebase App Check.

## After deploying

Place a test order on the live site and check `npx wrangler tail` (streams
live logs) for `[whatsapp] sent to ...` / `[whatsapp] Twilio error ...`
lines.

## The old Firebase Cloud Function

`functions/index.js`, `firebase.json`'s `functions` block, and `.firebaserc`
from the earlier setup are no longer used now that this Worker handles
notifications — they don't need Blaze billing enabled, and you can delete
the `functions/` folder whenever convenient. `firestore.rules` is still
used (it documents your Firestore security rules) and `firebase.json` has
been trimmed to just that.

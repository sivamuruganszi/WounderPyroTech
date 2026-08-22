# Order notifications (Cloudflare Worker)

Notifies the store owner of every new order — via WhatsApp (Twilio, sandbox
workaround, see below) and via SMS (textbee.dev, using a spare Android
phone as the SMS gateway) — right after a customer checks out on the site.
Free to run (Cloudflare Workers' free plan — no credit card needed).

## One-time setup

Run these from a terminal on your own machine, inside `worker/`. None of
this needs me — it's your Cloudflare account, Twilio credentials, and
textbee API key, entered only into your own terminal.

```bash
cd worker
npm install                 # installs wrangler (Cloudflare's CLI), local to this folder
npx wrangler login          # opens a browser to sign into (or create) your free Cloudflare account

# Store secrets (prompted, hidden input — use the values already in application.env):
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_WHATSAPP_FROM      # e.g. whatsapp:+14155238886
npx wrangler secret put OWNER_WHATSAPP_NUMBER     # e.g. +917708450260 (also used as the SMS recipient)
npx wrangler secret put SITE_KEY
# ^ when prompted for SITE_KEY, paste this exact value: 92YXnpOoVajVqdYfWBM3lvj1K5oifai3
#   (a random string I generated — not a real credential, just enough to stop
#   casual/automated hits on the endpoint. It must match WHATSAPP_SITE_KEY in index.html.)

# textbee.dev SMS — see "Setting up textbee" below for how to get this key
npx wrangler secret put TEXTBEE_API_KEY

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

## Setting up textbee (SMS)

textbee.dev turns a spare Android phone (needs a SIM card and a data/wifi
connection — it can just sit on a shelf) into an SMS gateway with a free
REST API. No template approval, no sandbox join step — unlike the WhatsApp
path below, it just sends.

1. On the Android phone, install the **textbee** app (from the Play Store,
   or sideload the APK — see textbee.dev for the current install link) and
   sign up for a free account inside the app (or at textbee.dev).
2. In the app, register the device. This links it to your account and
   keeps it as the SMS gateway (the phone must stay powered on and
   connected to the internet to send messages).
3. From your textbee.dev dashboard, copy your **API Key**. That's the only
   value this Worker needs — paste it when `wrangler secret put
   TEXTBEE_API_KEY` prompts you.
4. Free tier: 1 linked device, 50 SMS/day, 300 SMS/month — plenty for a
   small storefront. No credit card required.

(Optional: if you ever link more than one Android device to your textbee
account, set `npx wrangler secret put TEXTBEE_DEVICE_ID` to pin which one
sends — otherwise it uses your default/most recently active device.)

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
live logs) for `[whatsapp] sent to ...` / `[whatsapp] Twilio error ...` and
`[sms] sent to ...` / `[sms] textbee error ...` lines. The two channels are
independent (`Promise.allSettled`) — if one fails the other still goes
through, and the order itself is always saved to Firestore regardless of
whether either notification succeeds.

## The old Firebase Cloud Function

`functions/index.js`, `firebase.json`'s `functions` block, and `.firebaserc`
from the earlier setup are no longer used now that this Worker handles
notifications — they don't need Blaze billing enabled, and you can delete
the `functions/` folder whenever convenient. `firestore.rules` is still
used (it documents your Firestore security rules) and `firebase.json` has
been trimmed to just that.

# Order notifications (Cloudflare Worker)

Notifies the store owner of every new order — via WhatsApp (Twilio, sandbox
workaround, see below) and via SMS (SMS Gateway for Android, using a spare
Android phone as the SMS relay) — right after a customer checks out on the
site. Free to run (Cloudflare Workers' free plan — no credit card needed).

## One-time setup

Run these from a terminal on your own machine, inside `worker/`. None of
this needs me — it's your Cloudflare account, Twilio credentials, and SMS
Gateway app credentials, entered only into your own terminal.

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

# SMS Gateway for Android — see "Setting up SMS Gateway for Android" below
npx wrangler secret put SMS_GATEWAY_USERNAME
npx wrangler secret put SMS_GATEWAY_PASSWORD

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

## Setting up SMS Gateway for Android

[SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway)
turns a spare Android phone (needs a SIM card and an internet connection)
into an SMS relay with a free REST API. No template approval, no sandbox
join step — but see the important note below about keeping it reliable.

1. Install the **SMS Gateway for Android** app on the phone (Play Store, or
   sideload the APK — see [sms-gate.app](https://sms-gate.app/) for the
   current link).
2. In the app, open **Settings → Cloud Server** and set a username and
   password (you choose these — they're not tied to any account, just used
   for API auth). Enable Cloud Server mode.
3. Use that same username/password when `wrangler secret put
   SMS_GATEWAY_USERNAME` / `SMS_GATEWAY_PASSWORD` prompt you.

### Important: stop the app from going stale (this is what broke textbee)

This app — like every "phone as SMS gateway" app — relies on Android's
push notification system (Firebase Cloud Messaging) to wake up and send.
If the phone's battery optimization kills it in the background, sends
silently fail even though the Worker call itself succeeds. This is exactly
what happened with the previous SMS gateway (textbee): `FCM_TOKEN_NOT_REGISTERED`.

To prevent it from happening again on this app too:

- On the phone: **Settings → Apps → SMS Gateway for Android → Battery →
  Unrestricted** (exact wording varies by Android version/manufacturer;
  look for "battery optimization" or "background activity" and allow it).
- Keep the phone plugged in / charged and connected to wifi or mobile data
  at all times — it's acting as always-on infrastructure now, the same as
  a small server.
- Open the app itself occasionally to confirm it still shows "connected" —
  if it doesn't, reopening it usually re-registers the push token.

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
`[sms] queued for ...` / `[sms] SMS Gateway error ...` lines. The two
channels are independent (`Promise.allSettled`) — if one fails the other
still goes through, and the order itself is always saved to Firestore
regardless of whether either notification succeeds. Note that `[sms]
queued for ...` only means the Worker's request to the SMS Gateway API
succeeded — actual delivery still depends on the phone being online and
the app not having been killed in the background (see above).

## The old Firebase Cloud Function

`functions/index.js`, `firebase.json`'s `functions` block, and `.firebaserc`
from the earlier setup are no longer used now that this Worker handles
notifications — they don't need Blaze billing enabled, and you can delete
the `functions/` folder whenever convenient. `firestore.rules` is still
used (it documents your Firestore security rules) and `firebase.json` has
been trimmed to just that.

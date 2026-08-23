# Order notifications (Cloudflare Worker)

Sends an SMS and a WhatsApp message — both via Fast2SMS (fast2sms.com) — to
the store owner right after a customer checks out on the site. Free to run
(Cloudflare Workers' free plan — no credit card needed), unlike the Firebase
Cloud Functions version this replaces.

Two earlier SMS attempts (textbee.dev, then SMS Gateway for Android) relied
on a spare Android phone as the SMS relay and both failed for phone-side
reasons (a stale push token, then no cellular signal at send time). Fast2SMS
is different in kind — it's a real Indian bulk SMS/WhatsApp gateway that
sends directly from its own infrastructure, so there's no phone, no app, and
no push-token dependency involved.

WhatsApp used to go through Twilio's Sandbox but that broke (error 21655,
"ContentSid Invalid") and needed its own separate account/template to fix.
Both channels now run through Fast2SMS instead — one vendor, one API key.

## One-time setup

Run these from a terminal on your own machine, inside `worker/`. None of
this needs me — it's your Cloudflare account and your Fast2SMS API key,
entered only into your own terminal.

```bash
cd worker
npm install                 # installs wrangler (Cloudflare's CLI), local to this folder
npx wrangler login          # opens a browser to sign into (or create) your free Cloudflare account

# Store secrets (prompted, hidden input):
npx wrangler secret put OWNER_WHATSAPP_NUMBER     # e.g. +917708450260
npx wrangler secret put SITE_KEY
# ^ when prompted for SITE_KEY, paste this exact value: 92YXnpOoVajVqdYfWBM3lvj1K5oifai3
#   (a random string I generated — not a real credential, just enough to stop
#   casual/automated hits on the endpoint. It must match WHATSAPP_SITE_KEY in index.html.)

npx wrangler secret put FAST2SMS_API_KEY
# ^ get this from https://www.fast2sms.com/dashboard/dev-api after signing
#   up. Copy the API key shown there and paste it when prompted. Note: the
#   API (both SMS and WhatsApp) needs at least one real wallet recharge of
#   ₹100+ in your Fast2SMS account before it will send anything — the ₹50
#   signup credit only works through their website/dashboard, not the API.

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

## Enabling WhatsApp (SMS works without this)

SMS (Quick SMS route) works as soon as `FAST2SMS_API_KEY` is set and your
wallet has a ₹100+ recharge — no extra setup. WhatsApp needs two more
one-time steps in your Fast2SMS dashboard, and until you do them WhatsApp
sending is simply skipped (logged, not an error) — SMS keeps working either
way:

1. **Connect a WhatsApp Business number.** In the Fast2SMS panel, go to the
   WhatsApp API section and connect/register a WABA (WhatsApp Business
   Account) number. This gives you a `phone_number_id`.
2. **Create and get a template approved.** Create a WhatsApp message
   template with **exactly one variable** in its body — for example:
   `New order alert: {{1}}`. Submit it for approval (this isn't instant;
   Fast2SMS/Meta review it). Once approved, the panel shows a numeric
   `message_id` for it.
3. **Set both as vars and redeploy.** Open `worker/wrangler.toml`, fill in:
   ```toml
   FAST2SMS_WHATSAPP_MESSAGE_ID = "your message_id here"
   FAST2SMS_WHATSAPP_PHONE_NUMBER_ID = "your phone_number_id here"
   ```
   (These aren't secrets — like the old Twilio ContentSid, they just
   identify a template/number, not a credential — so they live in
   `wrangler.toml`, not as a `wrangler secret`.) Then run `npx wrangler
   deploy` again. Send me the two values if you'd rather I fill them in and
   push the file for you.

## Before this works

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
live logs) for these lines:
- `[sms] sent to ..., request_id: ...` / `[sms] Fast2SMS error ...`
- `[whatsapp] sent to ..., request_id: ...` / `[whatsapp] Fast2SMS error ...`
- `[whatsapp] Fast2SMS WhatsApp not configured yet ..., skipping` — expected
  until you've done the WhatsApp setup above; SMS is unaffected.

Each notification channel is independent — one failing or being unconfigured
never blocks the other.

## The old Firebase Cloud Function

`functions/index.js`, `firebase.json`'s `functions` block, and `.firebaserc`
from the earlier setup are no longer used now that this Worker handles
notifications — they don't need Blaze billing enabled, and you can delete
the `functions/` folder whenever convenient. `firestore.rules` is still
used (it documents your Firestore security rules) and `firebase.json` has
been trimmed to just that.

// worker/src/index.js
//
// Cloudflare Worker: notifies the store owner of a new order — via SMS and
// WhatsApp, both through Fast2SMS (fast2sms.com) — called directly from
// index.html right after an order is saved to Firestore (see
// notifyWhatsApp() in index.html's handleOrderSubmit).
//
// --- Why Fast2SMS for both channels ---
// Two earlier SMS attempts (textbee.dev, then SMS Gateway for Android) both
// used a spare Android phone as the SMS relay, and both failed the same
// way: they depend on Firebase Cloud Messaging push notifications to wake
// the phone's app, and on the phone actually having cellular signal at
// that moment. Fast2SMS is different in kind, not just a different brand —
// it's a real telecom-grade SMS/WhatsApp gateway (an Indian provider) that
// sends directly from its own infrastructure. There's no phone, no app, no
// battery optimization setting, no FCM token to go stale.
//
// WhatsApp here used to go through Twilio's WhatsApp Sandbox with a
// repurposed built-in template, but that setup broke (error 21655,
// "ContentSid Invalid" — the sandbox's template SID stopped resolving) and
// needed its own separate Twilio account/ContentSid to fix. Consolidating
// onto Fast2SMS means one vendor, one API key, for both SMS and WhatsApp.
//
// SMS uses the "Quick SMS" route (route=q), which needs no DLT (India's SMS
// regulatory registration) sender-ID/template approval — plain text, works
// immediately after signup. See sendSmsViaFast2SMS() below; this part is
// unchanged and already working once FAST2SMS_API_KEY is set.
//
// WhatsApp is template-based (same requirement WhatsApp always has for
// business-initiated messages) and needs two one-time setup steps in your
// Fast2SMS panel that this code can't do for you:
//   1. Connect a WhatsApp Business number (WABA) — WhatsApp API section of
//      the dashboard.
//   2. Create and get approved a template with exactly ONE variable in its
//      body, e.g.: "New order alert: {{1}}" (approval isn't instant).
// Once approved, the panel shows a numeric message_id for that template and
// a phone_number_id for your connected WABA number — set those as
// FAST2SMS_WHATSAPP_MESSAGE_ID / FAST2SMS_WHATSAPP_PHONE_NUMBER_ID (see
// worker/README.md). Until both are set, sendWhatsAppViaFast2SMS() just
// skips — it's fully independent of the SMS send, so SMS keeps working
// whether or not WhatsApp is configured yet.
// Docs: https://docs.fast2sms.com/reference/sendwhatsappmessage
//
// Why a Worker instead of a Firebase Cloud Function: Firebase's Firestore
// triggers only run on the Blaze (pay-as-you-go) billing plan, which
// requires adding a card to the Firebase project even though usage here
// would stay well within the free quota. Cloudflare Workers' free plan
// needs no card and comfortably covers a small storefront (100,000
// requests/day; outbound calls to Fast2SMS aren't metered separately).
//
// Trade-off vs. the Firestore-trigger approach: this only fires because
// index.html calls it right after saving the order. If a customer's
// browser/tab closes in the instant between "order saved" and "this
// request sent", that one order's notifications would be missed (the
// order itself is still safely in Firestore either way).

function toE164(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith("91")) return `+${cleaned}`;
  return `+${cleaned}`;
}

// Fast2SMS's "numbers" param wants a bare 10-digit Indian mobile number —
// no "+91", no leading zero, no separators. Reuses toE164()'s cleanup then
// strips back down to the last 10 digits.
function toIndianNational(raw) {
  const e164 = toE164(raw);
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  return digits.slice(-10);
}

// Fast2SMS's WhatsApp "numbers" param wants the number WITH country code
// but no "+" (e.g. "919999999999"), unlike the SMS route above.
function toFast2SMSWhatsAppNumber(raw) {
  const e164 = toE164(raw);
  if (!e164) return null;
  return e164.replace(/^\+/, "");
}

function money(n) {
  return `₹${Number(n || 0).toLocaleString("en-IN")}`;
}

// WhatsApp template variables can't contain newlines/tabs and have a
// practical length limit, so keep each one short and single-line.
function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Fast2SMS "Quick SMS" route (route=q) — plain text, no DLT sender-ID
// template registration needed, works immediately after signup. Docs:
// https://docs.fast2sms.com/reference/quick-sms
async function sendSmsViaFast2SMS(env, toPhoneNumber, message) {
  if (!toPhoneNumber) return { skipped: true };
  if (!env.FAST2SMS_API_KEY) {
    console.error("[sms] FAST2SMS_API_KEY not set, skipping");
    return { ok: false, error: "missing_api_key" };
  }

  const nationalNumber = toIndianNational(toPhoneNumber);
  const url = new URL("https://www.fast2sms.com/dev/bulkV2");
  url.searchParams.set("authorization", env.FAST2SMS_API_KEY);
  url.searchParams.set("route", "q");
  url.searchParams.set("message", message);
  url.searchParams.set("numbers", nationalNumber);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: env.FAST2SMS_API_KEY },
  });

  const json = await resp.json().catch(() => null);

  // Fast2SMS returns HTTP 200 even on failure — the real signal is the
  // `return` boolean in the JSON body, not resp.ok.
  if (!resp.ok || !json || json.return !== true) {
    console.error("[sms] Fast2SMS error", resp.status, JSON.stringify(json));
    return { ok: false, status: resp.status, response: json };
  }
  console.log(`[sms] sent to ${nationalNumber}, request_id: ${json.request_id}`);
  return { ok: true, requestId: json.request_id };
}

// Fast2SMS WhatsApp Template Message API. See the header comment above for
// the one-time panel setup (WABA connection + approved template) this
// depends on. Reuses FAST2SMS_API_KEY — no separate credential needed.
// Docs: https://docs.fast2sms.com/reference/sendwhatsappmessage
async function sendWhatsAppViaFast2SMS(env, toPhoneNumber, messageText) {
  if (!toPhoneNumber) return { skipped: true };
  if (!env.FAST2SMS_API_KEY) {
    console.error("[whatsapp] FAST2SMS_API_KEY not set, skipping");
    return { ok: false, error: "missing_api_key" };
  }
  if (!env.FAST2SMS_WHATSAPP_MESSAGE_ID || !env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID) {
    // Not configured yet — this is expected until the WABA number + template
    // are approved in the Fast2SMS panel. Not an error; SMS is unaffected.
    console.log("[whatsapp] Fast2SMS WhatsApp not configured yet (missing message_id/phone_number_id), skipping");
    return { skipped: true };
  }

  const whatsappNumber = toFast2SMSWhatsAppNumber(toPhoneNumber);
  const url = new URL("https://www.fast2sms.com/dev/whatsapp");
  url.searchParams.set("message_id", env.FAST2SMS_WHATSAPP_MESSAGE_ID);
  url.searchParams.set("phone_number_id", env.FAST2SMS_WHATSAPP_PHONE_NUMBER_ID);
  url.searchParams.set("numbers", whatsappNumber);
  url.searchParams.set("variables_values", messageText);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: env.FAST2SMS_API_KEY },
  });

  const json = await resp.json().catch(() => null);

  // Fast2SMS's documented success field for this endpoint is `status`
  // (unlike bulkV2's `return`) — checking resp.ok too as a fallback since
  // Fast2SMS's docs are thin on the exact error shape here.
  if (!resp.ok || !json || (json.status !== true && json.return !== true)) {
    console.error("[whatsapp] Fast2SMS error", resp.status, JSON.stringify(json));
    return { ok: false, status: resp.status, response: json };
  }
  console.log(`[whatsapp] sent to ${whatsappNumber}, request_id: ${json.request_id}`);
  return { ok: true, requestId: json.request_id };
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Site-Key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    // Lightweight abuse deterrent, not a real secret — anything shipped to
    // the browser is visible to anyone who looks. It just filters out
    // casual/automated hits on this URL; it can't stop a determined caller.
    // The Firestore `orders` collection already accepts public writes
    // (see firestore.rules), so this endpoint doesn't introduce a new class
    // of risk beyond "someone could spam fake orders and WhatsApp sends" —
    // which is already true today via the site's checkout form.
    if (env.SITE_KEY && request.headers.get("X-Site-Key") !== env.SITE_KEY) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    let order;
    try {
      order = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
    }

    if (
      !order ||
      !order.customer ||
      typeof order.customer.mobile !== "string" ||
      !Array.isArray(order.items) ||
      typeof order.total !== "number"
    ) {
      return new Response("Invalid order payload", { status: 400, headers: corsHeaders });
    }

    const itemsSummary = order.items.map((it) => `${it.qty}x ${it.name}`).join(", ");
    const totalFormatted = money(order.total);

    // Shared order-summary text for both channels. SMS sends this as
    // plain text; WhatsApp passes it as the single {{1}} variable of the
    // approved template (see the header comment for that template's
    // expected shape).
    const orderMessage = truncate(
      `New order: ${itemsSummary}. Total ${totalFormatted}. From ${order.customer.name || "Customer"} (${order.customer.mobile || "N/A"}).`,
      600
    );

    const results = await Promise.allSettled([
      sendSmsViaFast2SMS(env, env.OWNER_WHATSAPP_NUMBER, orderMessage),
      sendWhatsAppViaFast2SMS(env, env.OWNER_WHATSAPP_NUMBER, orderMessage),
    ]);

    return new Response(
      JSON.stringify({ ok: true, results: results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false })) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  },
};

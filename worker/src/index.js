// worker/src/index.js
//
// Cloudflare Worker: notifies the store owner of a new order — via WhatsApp
// (Twilio) and SMS (Fast2SMS, fast2sms.com) — called directly from
// index.html right after an order is saved to Firestore (see
// notifyWhatsApp() in index.html's handleOrderSubmit).
//
// --- Why Fast2SMS, alongside WhatsApp ---
// Two earlier SMS attempts (textbee.dev, then SMS Gateway for Android) both
// used a spare Android phone as the SMS relay, and both failed the same
// way: they depend on Firebase Cloud Messaging push notifications to wake
// the phone's app, and on the phone actually having cellular signal at
// that moment. Fast2SMS is different in kind, not just a different brand —
// it's a real telecom-grade SMS gateway (an Indian bulk SMS provider) that
// sends directly over the phone network from their own infrastructure.
// There's no phone, no app, no battery optimization setting, no FCM token
// to go stale. This should be materially more reliable than the previous
// two attempts.
//
// Uses the "Quick SMS" route (route=q), which needs no DLT (India's SMS
// regulatory registration) sender-ID/template approval — plain text,
// works immediately after signup. Docs: https://docs.fast2sms.com/
//
// Why a Worker instead of a Firebase Cloud Function: Firebase's Firestore
// triggers only run on the Blaze (pay-as-you-go) billing plan, which
// requires adding a card to the Firebase project even though usage here
// would stay well within the free quota. Cloudflare Workers' free plan
// needs no card and comfortably covers a small storefront (100,000
// requests/day; outbound calls to Twilio aren't metered at all).
//
// Trade-off vs. the Firestore-trigger approach: this only fires because
// index.html calls it right after saving the order. If a customer's
// browser/tab closes in the instant between "order saved" and "this
// request sent", that one order's WhatsApp notification would be missed
// (the order itself is still safely in Firestore either way).
//
// --- Why this uses a template instead of plain text ---
// WhatsApp requires any business-initiated message (one the customer didn't
// ask for by messaging first) to use a pre-approved template — plain text
// gets rejected with error 21654 "ContentSid Required". Getting a *custom*
// template approved requires registering a real WhatsApp Sender, which
// means connecting a Meta Business Manager account and going through
// Meta's business verification — that can take a while.
//
// As a stopgap, this uses Twilio's WhatsApp *Sandbox* (a free testing
// environment, no Meta approval needed) and one of its built-in
// pre-approved templates ("Order Notifications"):
//   "Thank you for your order. Your delivery is scheduled for {{1}} at {{2}}."
// Two catches with the sandbox:
//   1. It only delivers to phone numbers that have manually sent the
//      sandbox's "join <code>" message on WhatsApp first — fine for
//      notifying yourself as the owner, not usable for real customers.
//      That's why this only sends to OWNER_WHATSAPP_NUMBER for now.
//   2. The template's only two variables were designed for a delivery
//      date/time, not order details — they're repurposed below to carry a
//      compact order summary instead of their literal date/time meaning.
//
// Once a real WhatsApp Sender is approved (see worker/README.md), swap
// WHATSAPP_TEMPLATE_SID for your own custom template's SID, update the
// ContentVariables below to match its real variables, set
// TWILIO_WHATSAPP_FROM back to your approved number, and re-enable sending
// to the customer too.

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

async function sendWhatsAppTemplate(env, toPhoneNumber, contentVariables) {
  if (!toPhoneNumber) return { skipped: true };

  const from = env.TWILIO_WHATSAPP_FROM.startsWith("whatsapp:")
    ? env.TWILIO_WHATSAPP_FROM
    : `whatsapp:${env.TWILIO_WHATSAPP_FROM}`;

  const body = new URLSearchParams({
    From: from,
    To: `whatsapp:${toPhoneNumber}`,
    ContentSid: env.WHATSAPP_TEMPLATE_SID,
    ContentVariables: JSON.stringify(contentVariables),
  });

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[whatsapp] Twilio error", resp.status, errText);
    return { ok: false, status: resp.status };
  }
  const json = await resp.json();
  console.log(`[whatsapp] sent to ${toPhoneNumber}, SID: ${json.sid}`);
  return { ok: true, sid: json.sid };
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

    // Repurposing the sandbox "Order Notifications" template's two
    // variables (originally meant for a delivery date/time) to carry a
    // compact order summary instead, since it's the only pre-approved
    // template available without a full WhatsApp Sender registration.
    const ownerPhone = toE164(env.OWNER_WHATSAPP_NUMBER);
    const ownerContentVariables = {
      "1": truncate(`${order.customer.name || "Customer"} — ${itemsSummary}`, 120),
      "2": truncate(`${totalFormatted} — ${order.customer.mobile || "N/A"}`, 80),
    };

    // Plain-text SMS body for Fast2SMS (no template/variable constraints
    // like WhatsApp's sandbox template has).
    const smsMessage = truncate(
      `New order: ${itemsSummary}. Total ${totalFormatted}. From ${order.customer.name || "Customer"} (${order.customer.mobile || "N/A"}).`,
      600
    );

    const results = await Promise.allSettled([
      sendWhatsAppTemplate(env, ownerPhone, ownerContentVariables),
      sendSmsViaFast2SMS(env, env.OWNER_WHATSAPP_NUMBER, smsMessage),
    ]);

    return new Response(
      JSON.stringify({ ok: true, results: results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false })) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  },
};

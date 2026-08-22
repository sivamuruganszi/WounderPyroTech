// worker/src/index.js
//
// Cloudflare Worker: notifies the store owner of a new order — via WhatsApp
// (Twilio) and SMS (SMS Gateway for Android, github.com/capcom6/android-sms-gateway)
// — called directly from index.html right after an order is saved to
// Firestore (see notifyWhatsApp() in index.html's handleOrderSubmit).
//
// --- Why SMS Gateway for Android, alongside WhatsApp ---
// The WhatsApp path below only works because of the Twilio Sandbox
// workaround (see comment further down) — a stopgap, not something
// guaranteed to keep working. SMS Gateway for Android turns a spare
// Android phone into an SMS relay via a REST API — simpler auth (plain
// HTTP Basic, no template/approval process) than the WhatsApp path.
//
// Heads up: like every "phone as SMS gateway" app (this one included), it
// depends on Firebase Cloud Messaging push notifications to wake the app
// and trigger the send. If the phone's battery optimization kills the app
// in the background, sends silently fail (see worker/README.md for the
// fix). This was the exact failure mode hit with a previous SMS gateway
// (textbee.dev) — this integration doesn't remove that class of risk, it's
// just a different, better-documented gateway app. That's also why this
// runs *alongside* WhatsApp rather than replacing it — if one channel goes
// stale, the other still gets through.
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

function money(n) {
  return `₹${Number(n || 0).toLocaleString("en-IN")}`;
}

// WhatsApp template variables can't contain newlines/tabs and have a
// practical length limit, so keep each one short and single-line.
function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
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

// SMS Gateway for Android (capcom6/android-sms-gateway): plain SMS via a
// linked Android phone, relayed through the project's free public cloud
// API. Auth is HTTP Basic using the username/password set in the Android
// app itself (Settings → Cloud Server in the app). No templates, no
// approval process. Docs: https://docs.sms-gate.app/integration/api/
async function sendSmsViaGateway(env, toPhoneNumber, message) {
  if (!toPhoneNumber) return { skipped: true };
  if (!env.SMS_GATEWAY_USERNAME || !env.SMS_GATEWAY_PASSWORD) {
    return { skipped: true, reason: "no SMS_GATEWAY_USERNAME/PASSWORD set" };
  }

  const resp = await fetch("https://api.sms-gate.app/3rdparty/v1/messages", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.SMS_GATEWAY_USERNAME}:${env.SMS_GATEWAY_PASSWORD}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumbers: [toPhoneNumber],
      textMessage: { text: message },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[sms] SMS Gateway error", resp.status, errText);
    return { ok: false, status: resp.status };
  }
  const json = await resp.json();
  console.log(`[sms] queued for ${toPhoneNumber}, id: ${json.id}`);
  return { ok: true, id: json.id };
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

    // SMS has no template restriction, so it can carry the full order
    // summary as plain text. Sent to the same owner number as WhatsApp
    // (OWNER_WHATSAPP_NUMBER doubles as the owner's SMS number here).
    const ownerSmsMessage =
      `New order — Wonder Pyro Tech\n` +
      `Customer: ${order.customer.name || "N/A"}\n` +
      `Mobile: ${order.customer.mobile || "N/A"}\n` +
      `Address: ${order.customer.address || ""}, ${order.customer.city || ""}` +
      `${order.customer.state ? ", " + order.customer.state : ""}\n` +
      `Items: ${itemsSummary}\n` +
      `Total: ${totalFormatted}`;

    const results = await Promise.allSettled([
      sendWhatsAppTemplate(env, ownerPhone, ownerContentVariables),
      sendSmsViaGateway(env, ownerPhone, ownerSmsMessage),
    ]);

    return new Response(
      JSON.stringify({ ok: true, results: results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false })) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  },
};

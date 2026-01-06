// api/stripe-webhook.js
import Stripe from "stripe";
import { Resend } from "resend";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const resend = new Resend(process.env.RESEND_API_KEY);

// Read raw request body (required for Stripe signature verification)
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function money(amount, currency) {
  const c = (currency || "usd").toUpperCase();
  const n = typeof amount === "number" ? amount : Number(amount || 0);
  return `${(n / 100).toFixed(2)} ${c}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendOrderEmail({ subject, html }) {
  const fromEmail = process.env.ORDER_NOTIFY_FROM_EMAIL; // orders@kelleyscandles.com
  const to = process.env.ORDER_NOTIFY_TO_EMAIL;          // your inbox

  // Safer "From" format (helps deliverability + some providers require a name)
  const from = fromEmail ? `Kelley's Candles <${fromEmail}>` : "";

  if (!process.env.RESEND_API_KEY || !fromEmail || !to) {
    console.log("[email] missing env vars", {
      hasResendKey: !!process.env.RESEND_API_KEY,
      fromEmail,
      to,
    });
    return { skipped: true, reason: "missing env vars" };
  }

  try {
    const result = await resend.emails.send({
      from,
      to,
      subject,
      html,
    });

    console.log("[email] sent", result);
    return result;
  } catch (err) {
    // Resend errors often include useful fields
    console.error("[email] resend send failed:", {
      message: err?.message,
      name: err?.name,
      statusCode: err?.statusCode,
      response: err?.response,
    });
    throw err;
  }
}


export default async function handler(req, res) {
  // Stripe webhooks must be POST
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing Stripe signature");
  }

  let event;
  let rawBody;

  try {
    rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[webhook] signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Pull richer details
      const sessionId = session.id;
      const total = session.amount_total;
      const currency = session.currency;
      const paymentStatus = session.payment_status;
      const customerEmail = session.customer_details?.email || "";
      const customerName = session.customer_details?.name || "";
      const customerPhone = session.customer_details?.phone || "";
      const shipping = session.shipping_details;

      // Fetch line items (more reliable than metadata)
      let itemsText = "";
      let itemsHtml = "";
      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
          limit: 100,
        });

        const lines = (lineItems.data || []).map((li) => {
          const qty = li.quantity ?? 1;
          const name = li.description || li.price?.product?.name || "Item";
          const lineTotal = li.amount_total ?? (li.amount_subtotal ?? 0);
          return {
            qty,
            name,
            lineTotal,
          };
        });

        itemsText = lines.map((l) => `${l.qty}x ${l.name}`).join(", ");
        itemsHtml = lines
          .map(
            (l) =>
              `<li>${escapeHtml(l.qty)} × ${escapeHtml(l.name)} — ${escapeHtml(
                money(l.lineTotal, currency)
              )}</li>`
          )
          .join("");
      } catch (e) {
        // fallback to your metadata if present
        itemsText = session.metadata?.items || "(no line items)";
        itemsHtml = `<li>${escapeHtml(itemsText)}</li>`;
        console.warn("[webhook] could not fetch line items:", e.message);
      }

      console.log("[webhook] checkout.session.completed", {
        id: sessionId,
        amount_total: total,
        currency,
        payment_status: paymentStatus,
        customer_email: customerEmail,
        customer_name: customerName,
        items: itemsText || session.metadata?.items,
      });

      const shipBlock = shipping
        ? `
          <h3>Shipping</h3>
          <p>
            <strong>Name:</strong> ${escapeHtml(shipping.name || "")}<br/>
            <strong>Address:</strong>
            ${escapeHtml(shipping.address?.line1 || "")}
            ${escapeHtml(shipping.address?.line2 || "")}<br/>
            ${escapeHtml(shipping.address?.city || "")},
            ${escapeHtml(shipping.address?.state || "")}
            ${escapeHtml(shipping.address?.postal_code || "")}<br/>
            ${escapeHtml(shipping.address?.country || "")}
          </p>
        `
        : "";

      const subject = `New paid order — ${itemsText || "Checkout"} — ${money(total, currency)}`;

      const html = `
        <div style="font-family: Arial, sans-serif; line-height: 1.4;">
          <h2>New Paid Order</h2>
          <p><strong>Total:</strong> ${escapeHtml(money(total, currency))}</p>
          <p><strong>Payment status:</strong> ${escapeHtml(paymentStatus)}</p>

          <h3>Customer</h3>
          <p>
            <strong>Name:</strong> ${escapeHtml(customerName)}<br/>
            <strong>Email:</strong> ${escapeHtml(customerEmail)}<br/>
            <strong>Phone:</strong> ${escapeHtml(customerPhone)}
          </p>

          <h3>Items</h3>
          <ul>${itemsHtml || "<li>(no items)</li>"}</ul>

          ${shipBlock}

          <h3>Stripe</h3>
          <p>
            <strong>Checkout session:</strong> ${escapeHtml(sessionId)}<br/>
            <strong>Mode:</strong> ${escapeHtml(session.mode || "")}
          </p>
        </div>
      `;

      // 🔥 Send the email
      await sendOrderEmail({ subject, html });
    }

    // Always return 200 quickly so Stripe stops retrying
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[webhook] handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }
}

// api/stripe-webhook.js
export const config = { runtime: "nodejs" };
import Stripe from "stripe";
import { Resend } from "resend";
import { createShipment } from "./lib/easypost.js";

// ─────────────────────────────────────────────────────────────
// Stripe key — same resolution logic as the other two routes.
// Previous code used: STRIPE_SECRET_KEY || STRIPE_LIVE_KEY
//   • No NODE_ENV check → could silently use a test key in prod
//   • Priority was reversed vs create-checkout → inconsistent
// ─────────────────────────────────────────────────────────────
const STRIPE_KEY =
  process.env.NODE_ENV === "production"
    ? process.env.STRIPE_LIVE_KEY
    : process.env.STRIPE_SECRET_KEY;

if (!STRIPE_KEY) {
  throw new Error(
    `[stripe-webhook] Missing Stripe key. ` +
    `NODE_ENV=${process.env.NODE_ENV} — ` +
    `set STRIPE_LIVE_KEY (production) or STRIPE_SECRET_KEY (development).`
  );
}

const stripe = new Stripe(STRIPE_KEY, {
  apiVersion: "2024-06-20",
});

// ─────────────────────────────────────────────────────────────
// Webhook signing secret — also environment-aware now.
// Previously hardcoded to STRIPE_LIVE_WEBHOOK_SECRET only,
// which meant local dev / test webhooks would always fail
// signature verification.
// ─────────────────────────────────────────────────────────────
const WEBHOOK_SECRET =
  process.env.NODE_ENV === "production"
    ? process.env.STRIPE_LIVE_WEBHOOK_SECRET
    : process.env.STRIPE_TEST_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error(
    `[stripe-webhook] Missing webhook secret. ` +
    `NODE_ENV=${process.env.NODE_ENV} — ` +
    `set STRIPE_LIVE_WEBHOOK_SECRET (production) or STRIPE_TEST_WEBHOOK_SECRET (development).`
  );
}


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

function moneyPretty(amount, currency = "usd") {
  const cents = typeof amount === "number" ? amount : Number(amount || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format(cents / 100);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAddress(addr) {
  if (!addr) return "N/A";
  const line1 = addr.line1 || "";
  const line2 = addr.line2 || "";
  const city = addr.city || "";
  const state = addr.state || "";
  const postal = addr.postal_code || "";
  const country = addr.country || "";
  const parts = [
    line1,
    line2,
    `${city}${city ? "," : ""} ${state} ${postal}`.trim(),
    country,
  ].filter(Boolean);
  return parts.join("\n");
}

async function sendEmail({ to, from, subject, html, replyTo }) {
  if (!process.env.RESEND_API_KEY || !from || !to) {
    console.log("[email] missing env vars", {
      hasResendKey: !!process.env.RESEND_API_KEY,
      from,
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
      replyTo: replyTo || "kelleysfarmcandles@gmail.com",

    });
    console.log("[email] sent", result);
    return result;
  } catch (err) {
    console.error("[email] resend send failed:", {
      message: err?.message,
      name: err?.name,
      statusCode: err?.statusCode,
      response: err?.response,
    });
    return { error: true };
  }
}


function buildItemsTable(lines, currency) {
  const rows = (lines || [])
    .map((l) => {
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee;">${escapeHtml(l.name)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:center;">${escapeHtml(
            String(l.qty)
          )}</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(
            moneyPretty(l.unit, currency)
          )}</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(
            moneyPretty(l.line, currency)
          )}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:10px 0;border-bottom:2px solid #ddd;">Item</th>
          <th style="text-align:center;padding:10px 0;border-bottom:2px solid #ddd;">Qty</th>
          <th style="text-align:right;padding:10px 0;border-bottom:2px solid #ddd;">Unit</th>
          <th style="text-align:right;padding:10px 0;border-bottom:2px solid #ddd;">Line</th>
        </tr>
      </thead>
      <tbody>${rows || ""}</tbody>
    </table>
  `;
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
      WEBHOOK_SECRET   // ← was hardcoded env var; now uses the resolved const
    );
  } catch (err) {
    console.error("[webhook] signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      // NOTE: event.data.object is "lite". Retrieve full session for shipping rate name & totals.
      const liteSession = event.data.object;
      const sessionId = liteSession.id;

      // Retrieve expanded session so we can show shipping method name
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["shipping_cost.shipping_rate"],
      });

      const currency = session.currency || "usd";
      const paymentStatus = session.payment_status;

      const customerEmail = session.customer_details?.email || session.customer_email || "";
      const customerName = session.customer_details?.name || "";
      const customerPhone = session.customer_details?.phone || "";

      const shippingDetails = session.shipping_details;
      const shippingAddressText = formatAddress(shippingDetails?.address);

      const shippingMethod =
        session.shipping_cost?.shipping_rate?.display_name || "Shipping";

      const subtotal = session.amount_subtotal ?? 0;
      const shippingCost = session.shipping_cost?.amount_total ?? 0;
      const tax = session.total_details?.amount_tax ?? 0;
      const total = session.amount_total ?? 0;

      // Fetch line items (more reliable than metadata)
      let itemsText = "";
      let itemsHtml = "";
      let lines = [];
      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
          limit: 100,
          expand: ["data.price.product"],
        });

        lines = (lineItems.data || []).map((li) => {
          const qty = li.quantity ?? 1;
          const name = li.description || "Item";

          // Prefer unit_amount when available; fall back safely
          const unit =
            li.price?.unit_amount ??
            Math.round((li.amount_subtotal ?? 0) / Math.max(1, qty));

          const line = li.amount_subtotal ?? unit * qty;

          return { qty, name, unit, line };
        });

        itemsText = lines.map((l) => `${l.qty}x ${l.name}`).join(", ");
        itemsHtml = buildItemsTable(lines, currency);
      } catch (e) {
        // fallback to your metadata if present
        itemsText = session.metadata?.items || "(no line items)";
        itemsHtml = `
          <div style="padding:12px;border:1px solid #eee;border-radius:12px;">
            ${escapeHtml(itemsText)}
          </div>`;
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
        shipping_method: shippingMethod,
      });

      // ─────────────────────────────────────────────────────────────
      // CREATE SHIPPING LABEL (EasyPost)
      // ─────────────────────────────────────────────────────────────
      let trackingCode = null;
      let trackingUrl = null;
      let labelUrl = null;
      let shippingError = null;

      try {
        // Parse items from line items for weight calculation
        const itemsForShipping = lines.map((l) => ({
          // Extract size from item name (e.g., "Apple Pie • 12 oz" → "12 oz")
          size: l.name.match(/(\d+\s*oz)/i)?.[1] || "12 oz",
          qty: l.qty,
          scent: l.name.split("•")[0]?.trim() || l.name,
        }));

        console.log("[webhook] Creating EasyPost shipment", {
          orderId: sessionId,
          items: itemsForShipping,
        });

        const shipmentResult = await createShipment({
          toAddress: {
            name: shippingDetails?.name || customerName,
            line1: shippingDetails?.address?.line1 || "",
            line2: shippingDetails?.address?.line2 || "",
            city: shippingDetails?.address?.city || "",
            state: shippingDetails?.address?.state || "",
            postal_code: shippingDetails?.address?.postal_code || "",
            country: shippingDetails?.address?.country || "US",
            phone: customerPhone,
          },
          items: itemsForShipping,
          orderId: sessionId,
        });

        if (shipmentResult.success) {
          trackingCode = shipmentResult.trackingCode;
          trackingUrl = shipmentResult.trackingUrl;
          labelUrl = shipmentResult.labelUrl;

          console.log("[webhook] Shipping label created", {
            trackingCode,
            carrier: shipmentResult.carrier,
            service: shipmentResult.service,
            cost: shipmentResult.cost,
          });
        } else {
          shippingError = shipmentResult.error;
          console.error("[webhook] Shipping label creation failed:", shippingError);
        }
      } catch (err) {
        shippingError = err.message;
        console.error("[webhook] EasyPost error:", err);
      }
      // ─────────────────────────────────────────────────────────────

      const shippingHtml = `
        <h3 style="margin:18px 0 8px;">Shipping</h3>
        <div style="background:#fff;border:1px solid #eee;border-radius:12px;padding:12px;">
          <p style="margin:0 0 6px;"><strong>Method:</strong> ${escapeHtml(shippingMethod)}</p>
          <p style="margin:0 0 6px;"><strong>Name:</strong> ${escapeHtml(shippingDetails?.name || customerName || "")}</p>
          <p style="margin:0 0 6px;"><strong>Phone:</strong> ${escapeHtml(customerPhone || "")}</p>
          <pre style="white-space:pre-wrap;margin:0;font-family:inherit;">${escapeHtml(
            shippingAddressText
          )}</pre>
        </div>
      `;

      // ----- STORE EMAIL (keep your env var names) -----
      const storeTo = process.env.ORDER_NOTIFY_TO_EMAIL;
      const storeFromEmail = process.env.ORDER_NOTIFY_FROM_EMAIL;
      const storeFrom = storeFromEmail ? `Kelley's Candles <${storeFromEmail}>` : "";

      const storeSubject = `New paid order — ${itemsText || "Checkout"} — ${money(total, currency)}`;

      const storeHtml = `
        <div style="font-family: Arial, sans-serif; line-height: 1.4; max-width:680px;">
          <h2 style="margin:0 0 8px;">New Paid Order</h2>

          <div style="padding:12px 14px; background:#f7f7f7; border-radius:12px; margin:12px 0;">
            <p style="margin:0 0 6px;"><strong>Order ID:</strong> ${escapeHtml(sessionId)}</p>
            <p style="margin:0;"><strong>Total:</strong> ${escapeHtml(moneyPretty(total, currency))}</p>
          </div>

          <p style="margin:0 0 10px;"><strong>Payment status:</strong> ${escapeHtml(paymentStatus)}</p>

          <h3 style="margin:18px 0 8px;">Customer</h3>
          <p style="margin:0;">
            <strong>Name:</strong> ${escapeHtml(customerName)}<br/>
            <strong>Email:</strong> ${escapeHtml(customerEmail)}<br/>
            <strong>Phone:</strong> ${escapeHtml(customerPhone)}
          </p>

          <h3 style="margin:18px 0 8px;">Items</h3>
          ${itemsHtml || "<p>(no items)</p>"}

          <h3 style="margin:18px 0 8px;">Totals</h3>
          <div style="font-size:14px;">
            <div style="display:flex;justify-content:space-between;padding:6px 0;">
              <span>Subtotal</span><span>${escapeHtml(moneyPretty(subtotal, currency))}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;">
              <span>Shipping</span><span>${escapeHtml(moneyPretty(shippingCost, currency))}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;">
              <span>Tax</span><span>${escapeHtml(moneyPretty(tax, currency))}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:10px 0;border-top:2px solid #ddd;font-weight:bold;">
              <span>Total</span><span>${escapeHtml(moneyPretty(total, currency))}</span>
            </div>
          </div>

          ${shippingHtml}

          <h3 style="margin:18px 0 8px;">Stripe</h3>
          <p style="margin:0;">
            <strong>Checkout session:</strong> ${escapeHtml(sessionId)}<br/>
            <strong>Mode:</strong> ${escapeHtml(session.mode || "")}
          </p>

          ${
            trackingCode
              ? `
          <h3 style="margin:18px 0 8px;">Shipping Label</h3>
          <div style="background:#f0f9ff;border:1px solid #0ea5e9;border-radius:12px;padding:12px;">
            <p style="margin:0 0 6px;"><strong>Tracking:</strong> ${escapeHtml(trackingCode)}</p>
            ${trackingUrl ? `<p style="margin:0 0 6px;"><a href="${escapeHtml(trackingUrl)}" style="color:#0ea5e9;">Track Package</a></p>` : ""}
            ${labelUrl ? `<p style="margin:0;"><a href="${escapeHtml(labelUrl)}" style="color:#0ea5e9;">Download Label</a></p>` : ""}
          </div>
          `
              : shippingError
              ? `
          <h3 style="margin:18px 0 8px;">Shipping Label</h3>
          <div style="background:#fef2f2;border:1px solid #ef4444;border-radius:12px;padding:12px;">
            <p style="margin:0;color:#991b1b;"><strong>Label creation failed:</strong> ${escapeHtml(shippingError)}</p>
            <p style="margin:6px 0 0;font-size:12px;color:#7f1d1d;">Create label manually in EasyPost dashboard.</p>
          </div>
          `
              : ""
          }
        </div>
      `;

      // ----- CUSTOMER EMAIL (POLISHED) -----
      const customerTo = customerEmail;
      const customerFromEmail =
        process.env.CUSTOMER_CONFIRM_FROM_EMAIL || process.env.ORDER_NOTIFY_FROM_EMAIL;
      const customerFrom = customerFromEmail ? `Kelley's Candles <${customerFromEmail}>` : "";

      const orderShort = sessionId ? sessionId.slice(-8) : "";
      const customerSubject = `Order confirmed — Kelley's Candles (${orderShort})`;

      const customerHtml = `
        <div style="font-family: Arial, sans-serif; line-height: 1.5; max-width:680px; margin:0 auto; color:#111;">
          <h2 style="margin:0 0 8px;">Thanks for your order${customerName ? `, ${escapeHtml(customerName)}` : ""}!</h2>
          <p style="margin:0 0 14px;">
            We received your order and will start preparing it for shipment.
          </p>

          <div style="padding:12px 14px; background:#f7f7f7; border-radius:12px; margin:14px 0;">
            <p style="margin:0 0 6px;"><strong>Order ID:</strong> ${escapeHtml(sessionId)}</p>
            <p style="margin:0;"><strong>Status:</strong> Paid</p>
          </div>

          <h3 style="margin:18px 0 8px;">Order summary</h3>
          ${itemsHtml || "<p>(no items)</p>"}

          <h3 style="margin:18px 0 8px;">Totals</h3>
          <div style="font-size:14px;">
            <div style="display:flex;justify-content:space-between;padding:6px 0;">
              <span>Subtotal</span><span>${escapeHtml(moneyPretty(subtotal, currency))}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;">
              <span>Shipping</span><span>${escapeHtml(moneyPretty(shippingCost, currency))}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;">
              <span>Tax</span><span>${escapeHtml(moneyPretty(tax, currency))}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:10px 0;border-top:2px solid #ddd;font-weight:bold;">
              <span>Total paid</span><span>${escapeHtml(moneyPretty(total, currency))}</span>
            </div>
          </div>

          ${shippingHtml}

          <h3 style="margin:18px 0 8px;">What happens next</h3>
          <ul style="margin:0; padding-left:18px;">
            <li>We'll begin preparing your candles for shipment.</li>
            <li>When your order ships, you'll receive a shipping update (and tracking if available).</li>
            <li>If your shipping address needs a correction, reply to this email as soon as possible.</li>
          </ul>

          ${
            trackingCode
              ? `
          <div style="margin:18px 0;padding:14px;background:#f0f9ff;border:1px solid #0ea5e9;border-radius:12px;">
            <p style="margin:0 0 8px;font-weight:bold;color:#0369a1;">Your order is ready to ship!</p>
            <p style="margin:0 0 6px;"><strong>Tracking number:</strong> ${escapeHtml(trackingCode)}</p>
            ${trackingUrl ? `<p style="margin:0;"><a href="${escapeHtml(trackingUrl)}" style="color:#0ea5e9;text-decoration:underline;">Track your package</a></p>` : ""}
          </div>
          `
              : ""
          }

          <p style="margin:16px 0 0; font-size:12px; color:#666;">
            Questions? Reply to this email and we'll help.
          </p>
        </div>
      `;

      // Send store notification (non-fatal)
      try {
        await sendEmail({
  to: storeTo,
  from: storeFrom,
  subject: storeSubject,
  html: storeHtml,
  replyTo: customerEmail || "kelleysfarmcandles@gmail.com",
});

      } catch (err) {
        console.error("[email] store notification failed:", err?.message || err);
      }

      // Send customer confirmation (non-fatal)
      try {
        if (customerTo) {
          await sendEmail({
            to: customerTo,
            from: customerFrom,
            subject: customerSubject,
            html: customerHtml,
          });
        } else {
          console.log("[email] customer email missing");
        }
      } catch (err) {
        console.error("[email] customer confirmation failed:", err?.message || err);
      }
    }

    // ✅ Always return 200 even if email fails
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[webhook] handler error:", err);
    return res.status(200).json({ received: true });
  }
}
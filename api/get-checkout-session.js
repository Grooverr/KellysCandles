// api/get-checkout-session.js
export const config = { runtime: "nodejs" };
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_LIVE_KEY, {
  apiVersion: "2024-06-20",
});


// ✅ Allow list origins (match your create-checkout-session allowlist)
const ALLOWED_ORIGINS = new Set([
  "https://grooverr.github.io",
  "https://kelleyscandles.com",
  "https://www.kelleyscandles.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const sessionId = String(req.query.session_id || "").trim();
    if (!sessionId) return res.status(400).json({ error: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["shipping_cost.shipping_rate"],
    });

    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      expand: ["data.price.product"],
    });

    return res.status(200).json({
      id: session.id,
      currency: session.currency,
      payment_status: session.payment_status,
      customer: {
        email: session.customer_details?.email || session.customer_email || null,
        name: session.customer_details?.name || null,
        phone: session.customer_details?.phone || null,
      },
      shipping: session.shipping_details || null,
      shipping_method: session.shipping_cost?.shipping_rate?.display_name || null,
      totals: {
        subtotal: session.amount_subtotal ?? 0,
        shipping: session.shipping_cost?.amount_total ?? 0,
        tax: session.total_details?.amount_tax ?? 0,
        total: session.amount_total ?? 0,
      },
      items: (lineItems.data || []).map((li) => ({
        description: li.description || "Item",
        quantity: li.quantity ?? 1,
        unit_amount: li.price?.unit_amount ?? null,
        amount_subtotal: li.amount_subtotal ?? 0,
      })),
    });
  } catch (err) {
    console.error("[get-checkout-session] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}


import Stripe from "stripe";

const PRICE_MAP = {
  "Apple Pie|16 oz": 1600,
  "Love Spelling|16 oz": 1600,
  "Black Raspberry|16 oz": 1600,
  "Monkey Farts|16 oz": 1600,
  "Lilac Bush|16 oz": 1600,
  "Lavander|16 oz": 1600,

  "Apple Pie|12 oz": 1200,
  "Black Raspberry|12 oz": 1200,
  "Monkey Farts|12 oz": 1200,
  "Lilac Bush|12 oz": 1200,

  "Apple Pie|6 oz": 600,
  "Black Raspberry|6 oz": 600,
  "Monkey Farts|6 oz": 600,
  "Lilac Bush|6 oz": 600,
  "Lavander|6 oz": 600,
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// ✅ Allow list origins (add your custom domain later)
const ALLOWED_ORIGINS = new Set([
  "https://grooverr.github.io",
  // after you point the domain, add:
  // "https://kelleyscandles.com",
  // "https://www.kelleyscandles.com",
  // optional local dev:
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // If origin is missing (server-to-server) or not allowed, omit Allow-Origin.
    // For browser calls, this blocks.
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
  // ✅ ALWAYS set CORS headers first
  setCors(req, res);

  // ✅ Respond to preflight immediately
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ✅ Only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { cart, customerEmail } = req.body || {};

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Build line items from server-side price map (prevents tampering)
    const line_items = cart.map((item) => {
      const name = String(item.name || "").trim();
      const size = String(item.size || "").trim();
      const scent = String(item.scent || "").trim();
      const qty = Math.max(1, Number(item.qty || 1));

      if (!name || !size) throw new Error("Invalid cart item");
      if (qty > 10) throw new Error("Quantity limit exceeded");

      const key = `${name}|${size}`;
      const unit_amount = PRICE_MAP[key];
      if (!unit_amount) throw new Error(`Invalid product/size: ${key}`);

      const displayName = `${name}${scent ? " • " + scent : ""} • ${size}`;

      return {
        quantity: qty,
        price_data: {
          currency: "usd",
          unit_amount,
          product_data: { name: displayName },
        },
      };
    });

    // Optional: simple cart summary for metadata
    const itemsSummary = cart
      .map((i) => `${Math.max(1, Number(i.qty || 1))}x ${i.name} (${i.size})`)
      .join(", ");

    // ✅ Use your canonical site base
    // (If you later move to your domain, swap these to your domain)
    const success_url = "https://grooverr.github.io/KellysCandles/success.html";
    const cancel_url = "https://grooverr.github.io/KellysCandles/cancel.html";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url,
      cancel_url,

      // ✅ Helps webhook have reliable email, and Stripe can send receipt if enabled
      customer_email: typeof customerEmail === "string" ? customerEmail.trim() : undefined,

      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ["US"] },

      // ✅ Useful for your webhook, but don't trust it for totals/prices
      metadata: {
        items: itemsSummary,
        source: "github-pages",
        fulfillment: "shipping",
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[checkout] error:", err);
    return res.status(500).json({
      error: err.message || "Checkout failed",
      code: "CHECKOUT_CREATE_FAILED",
    });
  }
}

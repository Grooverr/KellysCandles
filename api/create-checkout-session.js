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

const ALLOWED_ORIGIN = "https://grooverr.github.io";

export default async function handler(req, res) {
  // ✅ ALWAYS set CORS headers first
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  // ✅ Respond to preflight immediately
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ✅ Only block non-POST *after* OPTIONS is handled
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { cart } = req.body || {};

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const line_items = cart.map(item => {
  const name = String(item.name || "").trim();
  const size = String(item.size || "").trim();
  const scent = String(item.scent || "").trim();
  const qty = Math.max(1, Number(item.qty || 1));

  if (!name || !size) throw new Error("Invalid cart item");
  if (qty > 10) throw new Error("Quantity limit exceeded");

  const key = `${name}|${size}`;
  const unit_amount = PRICE_MAP[key];
  if (!unit_amount) throw new Error(`Invalid product/size: ${key}`);

  const displayName =
    `${name}${scent ? " • " + scent : ""} • ${size}`;

  return {
    quantity: qty,
    price_data: {
      currency: "usd",
      unit_amount,
      product_data: { name: displayName },
    },
  };
});


    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: "https://grooverr.github.io/KellysCandles/success.html",
      cancel_url: "https://grooverr.github.io/KellysCandles/cancel.html",
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Checkout failed" });
  }
}

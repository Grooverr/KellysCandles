import Stripe from "stripe";

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
      const price = parseFloat(
        String(item.price).replace(/[^0-9.]/g, "")
      );

      if (!price || price <= 0) {
        throw new Error("Invalid price");
      }

      return {
        quantity: Math.max(1, Number(item.qty || 1)),
        price_data: {
          currency: "usd",
          unit_amount: Math.round(price * 100),
          product_data: {
            name: `${item.name}${item.scent ? " • " + item.scent : ""}${item.size ? " • " + item.size : ""}`,
          },
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

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // ---- CORS (so GitHub Pages can call Vercel) ----
  const allowedOrigins = new Set(["https://grooverr.github.io"]);
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    console.log("[checkout] OPTIONS preflight");
    return res.status(204).end();
  }

  try {
    const { cart } = req.body || {};
    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // Build Stripe line items from cart
    const line_items = cart.map((item) => {
      const qty = Math.max(1, Number(item.qty || 1));
      const priceNum = parseFloat(String(item.price || "").replace(/[^0-9.\-]/g, "")) || 0;
      const unitAmount = Math.round(priceNum * 100);
      const variantParts = [item.scent, item.size].filter(Boolean);
      const variant = variantParts.length ? ` (${variantParts.join(" • ")})` : "";

      return {
        quantity: qty,
        price_data: {
          currency: "usd",
          unit_amount: unitAmount,
          product_data: {
            name: `${item.name || "Candle"}${variant}`
          }
        }
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      // Put your real GH Pages URLs here:
      success_url: "https://grooverr.github.io/KellysCandles/success.html",
      cancel_url: "https://grooverr.github.io/KellysCandles/cancel.html",
      // optional but helpful:
      customer_creation: "if_required"
    });

    console.log("[checkout] session created", session.id);
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
};

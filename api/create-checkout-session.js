import Stripe from "stripe";

const PRICE_MAP = {
  // 🔽 TEMP: $1 smoke test
  "Apple Pie|17 oz": 100,

  // everything else unchanged
  "Love Spelling|17 oz": 2200,
  "Black Raspberry|17 oz": 2200,
  "Monkey Farts|17 oz": 2200,
  "Lilac Bush|17 oz": 2200,
  "Lavander|17 oz": 2200,

  "Apple Pie|12 oz": 1400,
  "Black Raspberry|12 oz": 1400,
  "Monkey Farts|12 oz": 1400,
  "Lilac Bush|12 oz": 1400,
  "Love Spelling|12 oz": 1400,
  "Lavander|12 oz": 1400,

  "Apple Pie|6 oz": 700,
  "Black Raspberry|6 oz": 700,
  "Monkey Farts|6 oz": 700,
  "Lilac Bush|6 oz": 700,
  "Love Spelling|6 oz": 700,
  "Lavander|6 oz": 700,
};


const SCENT_ALIASES = {
  "black raspberry vanilla bean": "Black Raspberry",
  "black raspberry vanilla": "Black Raspberry",
  "black raspberry": "Black Raspberry",
  "raspberry": "Black Raspberry",
  "apple": "Apple Pie",
  "apple pie": "Apple Pie",
  "applepie": "Apple Pie",
  "apple pie candle": "Apple Pie",
};

const VALID_SCENTS = new Set(
  Object.keys(PRICE_MAP).map((key) => key.split("|")[0])
);

const ENFORCE_SCENT_ALLOWLIST = false;

const stripe = new Stripe(process.env.STRIPE_LIVE_KEY, {
  apiVersion: "2024-06-20",
});

// ✅ Allow list origins (add your custom domain later)
const ALLOWED_ORIGINS = new Set([
  "https://grooverr.github.io",
  "https://kelleyscandles.com",
  "https://www.kelleyscandles.com",
  // optional local dev:
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

function setCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeScent(raw, index) {
  const cleaned = String(raw || "").trim().replace(/\s+/g, " ");
  if (!cleaned) {
    const err = new Error(`Missing scent/name for cart item at index ${index}`);
    err.statusCode = 400;
    throw err;
  }
  const cleanedKey = cleaned
    .toLowerCase()
    .replace(/[•–—-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const canonical = SCENT_ALIASES[cleanedKey] || cleaned;
  if (ENFORCE_SCENT_ALLOWLIST && !VALID_SCENTS.has(canonical)) {
    const err = new Error(
      `Unknown scent "${cleaned}" for cart item at index ${index}`
    );
    err.statusCode = 400;
    throw err;
  }
  return canonical;
}

function normalizeSize(raw, index) {
  const cleaned = String(raw || "").trim().toLowerCase();
  const match = cleaned.match(/(\d+(\.\d+)?)/);
  if (!match) {
    const err = new Error(`Invalid size "${raw}" for cart item at index ${index}`);
    err.statusCode = 400;
    throw err;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    const err = new Error(`Invalid size "${raw}" for cart item at index ${index}`);
    err.statusCode = 400;
    throw err;
  }
  const sizeNum = Number.isInteger(value) ? value : value;
  return `${sizeNum} oz`;
}

function getTotalQty(normalizedItems) {
  return normalizedItems.reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
}

function getTieredShipping(totalQty) {
  // Adjust these tiers anytime
  if (totalQty <= 1) return { amount: 600, label: "Standard Shipping (1 candle)" };     // $6.00
  if (totalQty <= 3) return { amount: 900, label: "Standard Shipping (2–3 candles)" }; // $9.00
  return { amount: 1200, label: "Standard Shipping (4+ candles)" };                    // $12.00
}

export default async function handler(req, res) {
  // ✅ ALWAYS set CORS headers first
  setCors(req, res);

  // ✅ Respond to preflight immediately (use 200 for Safari stability)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
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

    const normalizedItems = cart.map((item, index) => {
      const nameSource = item.candleName || item.name || item.scent;
      const scent = normalizeScent(nameSource, index);
      const size = normalizeSize(item.size, index);
      const qty = Math.max(1, Number(item.qty || 1));

      if (qty > 10) {
        const err = new Error(
          `Quantity limit exceeded for cart item at index ${index}`
        );
        err.statusCode = 400;
        throw err;
      }

      const key = `${scent}|${size}`;
      const unit_amount = PRICE_MAP[key];

      if (!unit_amount) {
        const availableForScent = Object.keys(PRICE_MAP).filter((k) =>
          k.startsWith(`${scent}|`)
        );
        const err = new Error(
          `No price found for "${key}" (cart item index ${index}). ` +
            (availableForScent.length
              ? `Available: ${availableForScent.join(", ")}`
              : "No prices exist for this scent.")
        );
        err.statusCode = 400;
        throw err;
      }

      return { qty, scent, size, unit_amount, key };
    });

    // Build line items from server-side price map (prevents tampering)
    const line_items = normalizedItems.map((item) => ({
      quantity: item.qty,
      price_data: {
        currency: "usd",
        unit_amount: item.unit_amount,
        product_data: { name: `${item.scent} • ${item.size}` },
      },
    }));

    const FREE_SHIPPING_THRESHOLD_CENTS = 10000; // $100.00

    const totalQty = getTotalQty(normalizedItems);
    const tieredShipping = getTieredShipping(totalQty);

    // ✅ Compute subtotal server-side (tamper-proof)
    const subtotalCents = normalizedItems.reduce(
      (sum, i) => sum + i.unit_amount * i.qty,
      0
    );

    // ✅ Apply free shipping if subtotal >= $100
    const freeShippingApplied = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS;

    const finalShipping = freeShippingApplied
      ? { amount: 0, label: "Free Shipping (Orders $100+)" }
      : tieredShipping;

    // Optional: simple cart summary for metadata
    const itemsSummary = normalizedItems
      .map((i) => `${i.qty}x ${i.scent} (${i.size})`)
      .join(", ");

    // ✅ Use your canonical site base
    const success_url =
      "https://www.kelleyscandles.com/success.html?session_id={CHECKOUT_SESSION_ID}";
    const cancel_url = "https://www.kelleyscandles.com/cancel.html";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url,
      cancel_url,

      // ✅ Helps webhook have reliable email, and Stripe can send receipt if enabled
      customer_email:
        typeof customerEmail === "string" ? customerEmail.trim() : undefined,

      // ✅ REQUIRED: always collect phone + shipping address
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ["US"] },

      // ✅ Shipping option (tiered under $100; free at $100+)
      shipping_options: [
        {
          shipping_rate_data: {
            display_name: finalShipping.label,
            type: "fixed_amount",
            fixed_amount: { amount: finalShipping.amount, currency: "usd" },
            delivery_estimate: {
              minimum: { unit: "business_day", value: 3 },
              maximum: { unit: "business_day", value: 7 },
            },
          },
        },
      ],

      // ✅ Useful for your webhook, but don't trust it for totals/prices
      metadata: {
        items: itemsSummary,
        source: "github-pages",
        fulfillment: "shipping",

        subtotal_cents: String(subtotalCents),
        free_shipping_applied: freeShippingApplied ? "true" : "false",
        free_shipping_threshold_cents: String(FREE_SHIPPING_THRESHOLD_CENTS),

        shipping_tier: finalShipping.label,
        shipping_amount: String(finalShipping.amount),
        total_qty: String(totalQty),
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    const status =
      err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    console.error("[checkout] error:", err);
    return res.status(status).json({
      error: err.message || "Checkout failed",
      code: status === 400 ? "CHECKOUT_INVALID_CART" : "CHECKOUT_CREATE_FAILED",
    });
  }
}

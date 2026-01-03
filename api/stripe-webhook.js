import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

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
  try {
    const rawBody = await readRawBody(req);
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
    // ✅ Payment completed (your main “order created” event)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // session fields you’ll care about:
      // session.id
      // session.amount_total
      // session.currency
      // session.customer_details (email, name, phone)
      // session.payment_status
      // session.metadata (if you add it in create-checkout-session)

      console.log("[webhook] checkout.session.completed", {
        id: session.id,
        amount_total: session.amount_total,
        currency: session.currency,
        payment_status: session.payment_status,
        customer_email: session.customer_details?.email,
        customer_name: session.customer_details?.name,
        items: session.metadata?.items, // if you set this
      });

      // TODO (later): send yourself an email, write to Google Sheets, etc.
    }

    // Always return 200 quickly so Stripe stops retrying
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[webhook] handler error:", err);
    return res.status(500).send("Webhook handler failed");
  }
}

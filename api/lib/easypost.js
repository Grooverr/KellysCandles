// api/lib/easypost.js
// ─────────────────────────────────────────────────────────────
// EasyPost shipment creation and label purchasing
// ─────────────────────────────────────────────────────────────

import EasyPost from "@easypost/api";

// ─────────────────────────────────────────────────────────────
// Initialize EasyPost client with environment-aware key
// ─────────────────────────────────────────────────────────────
const EASYPOST_API_KEY =
  process.env.NODE_ENV === "production"
    ? process.env.EASYPOST_LIVE_API_KEY
    : process.env.EASYPOST_TEST_API_KEY;

if (!EASYPOST_API_KEY) {
  throw new Error(
    `[easypost] Missing API key. NODE_ENV=${process.env.NODE_ENV} — ` +
    `set EASYPOST_LIVE_API_KEY (production) or EASYPOST_TEST_API_KEY (development).`
  );
}

const easypost = new EasyPost(EASYPOST_API_KEY);

// ─────────────────────────────────────────────────────────────
// Ship-from address (Kelley's warehouse)
// ─────────────────────────────────────────────────────────────
const FROM_ADDRESS = {
  name: "Kelley's Farm Candles",
  street1: "17 Deerfield Dr",
  city: "Moundsville",
  state: "WV",
  zip: "26041-1082",
  country: "US",
  phone: "3043125563",
};

// ─────────────────────────────────────────────────────────────
// Package weight calculations (estimated)
// All weights in ounces
// ─────────────────────────────────────────────────────────────
const CANDLE_WEIGHTS = {
  "6 oz": 10,   // 6 oz wax + ~4 oz jar
  "12 oz": 18,  // 12 oz wax + ~6 oz jar
  "17 oz": 24,  // 17 oz wax + ~7 oz jar
};

const BOX_WEIGHT = 4; // Empty box + packing material (oz)

// Standard box dimensions for candle shipments (inches)
const BOX_DIMENSIONS = {
  length: 12,
  width: 10,
  height: 8,
};

/**
 * Calculate total package weight based on cart items
 * @param {Array} items - Array of {scent, size, qty} objects
 * @returns {number} Total weight in ounces
 */
function calculatePackageWeight(items) {
  const candleWeight = items.reduce((total, item) => {
    const unitWeight = CANDLE_WEIGHTS[item.size] || 15; // fallback to avg
    return total + unitWeight * item.qty;
  }, 0);

  return candleWeight + BOX_WEIGHT;
}

/**
 * Create a shipment and purchase the cheapest label
 * @param {Object} params
 * @param {Object} params.toAddress - Customer shipping address from Stripe
 * @param {Array} params.items - Cart items for weight calculation
 * @param {string} params.orderId - Stripe session ID for reference
 * @returns {Promise<Object>} Shipment object with tracking info
 */
export async function createShipment({ toAddress, items, orderId }) {
  try {
    const weightOz = calculatePackageWeight(items);

    console.log("[easypost] Creating shipment", {
      orderId,
      weightOz,
      itemCount: items.length,
    });

    // Create the shipment
    const shipment = await easypost.Shipment.create({
      from_address: FROM_ADDRESS,
      to_address: {
        name: toAddress.name,
        street1: toAddress.line1,
        street2: toAddress.line2 || "",
        city: toAddress.city,
        state: toAddress.state,
        zip: toAddress.postal_code,
        country: toAddress.country || "US",
        phone: toAddress.phone || "",
      },
      parcel: {
        length: BOX_DIMENSIONS.length,
        width: BOX_DIMENSIONS.width,
        height: BOX_DIMENSIONS.height,
        weight: weightOz,
      },
      reference: orderId, // Links back to Stripe session
    });

    console.log("[easypost] Shipment created", {
      shipmentId: shipment.id,
      ratesCount: shipment.rates?.length || 0,
    });

    // Buy the cheapest rate
    // EasyPost automatically sorts rates by price (lowest first)
    if (!shipment.rates || shipment.rates.length === 0) {
      throw new Error("No shipping rates available for this shipment");
    }

    const lowestRate = shipment.rates[0];

    console.log("[easypost] Buying label", {
      carrier: lowestRate.carrier,
      service: lowestRate.service,
      rate: lowestRate.rate,
      currency: lowestRate.currency,
    });

    await easypost.Shipment.buy(shipment.id, lowestRate);

    // Retrieve the updated shipment with postage_label and tracking_code
    const boughtShipment = await easypost.Shipment.retrieve(shipment.id);

    console.log("[easypost] Label purchased", {
      trackingCode: boughtShipment.tracking_code,
      labelUrl: boughtShipment.postage_label?.label_url,
    });

    return {
      success: true,
      shipmentId: boughtShipment.id,
      trackingCode: boughtShipment.tracking_code,
      trackingUrl: boughtShipment.tracker?.public_url || null,
      labelUrl: boughtShipment.postage_label?.label_url || null,
      carrier: lowestRate.carrier,
      service: lowestRate.service,
      cost: lowestRate.rate,
      currency: lowestRate.currency,
    };
  } catch (err) {
    console.error("[easypost] Shipment creation failed:", {
      message: err.message,
      code: err.code,
      orderId,
    });

    return {
      success: false,
      error: err.message,
      orderId,
    };
  }
}

/**
 * Retrieve tracking info for an existing shipment
 * @param {string} trackingCode - Tracking number
 * @returns {Promise<Object>} Tracking details
 */
export async function getTracking(trackingCode) {
  try {
    const tracker = await easypost.Tracker.create({ tracking_code: trackingCode });
    return {
      success: true,
      status: tracker.status,
      status_detail: tracker.status_detail,
      tracking_details: tracker.tracking_details,
      public_url: tracker.public_url,
    };
  } catch (err) {
    console.error("[easypost] Tracking retrieval failed:", err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}
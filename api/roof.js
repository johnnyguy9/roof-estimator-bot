/**
 * PointWake Roof Estimator Webhook
 * GHL → API → GHL (WRITE BACK)
 */

export default async function handler(req, res) {
  console.log("===== ROOF ESTIMATOR HIT =====");

  if (req.method !== "POST") {
    return res.status(200).json({ ok: false, reason: "POST only" });
  }

  try {
    // ---------- PARSE BODY ----------
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    console.log("INCOMING BODY:", JSON.stringify(body, null, 2));

    // ---------- CONTACT ID ----------
    const contactId =
      body?.contact_id ||
      body?.contactId ||
      body?.contact?.id ||
      body?.contact?.contact_id;

    if (!contactId) {
      console.log("❌ Missing contact_id");
      return res.status(200).json({ ok: false, reason: "Missing contact_id" });
    }

    // ---------- INPUTS ----------
    const address =
      body?.address ||
      body?.contact?.address1 ||
      body?.contact?.full_address;

    const stories = normalizeStories(body?.stories);
    const providedSquares = normalizeSquares(body?.squares);

    console.log("ADDRESS:", address);
    console.log("STORIES:", stories);
    console.log("PROVIDED SQUARES:", providedSquares);

    // ---------- PRICING ----------
    const PRICE_PER_SQUARE = {
      1: 500,
      2: 575,
      3: 650
    };

    let finalSquares;

    if (providedSquares) {
      finalSquares = providedSquares;
    } else {
      if (!address) {
        console.log("⚠️ No address — skipping GHL update");
        return res.status(200).json({ ok: true, updated: false });
      }

      const measured = await measureRoofSquaresFromSolar(address);
      if (!measured) {
        console.log("⚠️ Solar measurement failed");
        return res.status(200).json({ ok: true, updated: false });
      }

      finalSquares = bufferSquares(measured);
    }

    const pricePerSquare = PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE[1];
    const totalEstimate = roundCurrency(finalSquares * pricePerSquare);

    if (!Number.isFinite(totalEstimate)) {
      console.log("⚠️ Invalid estimate — aborting write");
      return res.status(200).json({ ok: true, updated: false });
    }

    console.log("FINAL SQUARES:", finalSquares);
    console.log("TOTAL ESTIMATE:", totalEstimate);

    // ---------- GHL WRITE BACK ----------
    const ghlResponse = await updateGhlTotalEstimate(contactId, totalEstimate);

    return res.status(200).json({
      ok: true,
      updated: true,
      contactId,
      total_estimate: totalEstimate,
      squares: finalSquares,
      stories,
      ghl: ghlResponse
    });

  } catch (err) {
    console.error("🔥 ERROR:", err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* ================= HELPERS ================= */

function normalizeStories(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 3);
}

function normalizeSquares(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n);
}

function bufferSquares(sq) {
  if (sq <= 15) return sq + 3;
  if (sq <= 25) return sq + 4;
  return sq + 5;
}

function roundCurrency(num) {
  return Number(num.toFixed(2));
}

/* ================= GOOGLE SOLAR ================= */

async function measureRoofSquaresFromSolar(address) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  const geoRes = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
  );
  const geo = await geoRes.json();
  if (geo.status !== "OK") return null;

  const { lat, lng } = geo.results[0].geometry.location;

  const solarRes = await fetch(
    `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${key}`
  );
  const solar = await solarRes.json();

  const segments = solar?.solarPotential?.roofSegmentStats;
  if (!segments?.length) return null;

  const totalM2 = segments.reduce((s, r) => s + (r.areaMeters2 || 0), 0);
  if (!totalM2) return null;

  return Math.ceil((totalM2 * 10.7639) / 100);
}

/* ================= GHL WRITE BACK ================= */

async function updateGhlTotalEstimate(contactId, total) {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const fieldKey = process.env.GHL_TOTAL_ESTIMATE_FIELD_KEY;

  if (!token) throw new Error("Missing GHL_PRIVATE_TOKEN");
  if (!fieldKey) throw new Error("Missing GHL_TOTAL_ESTIMATE_FIELD_KEY");

  console.log("WRITING TO GHL:", { contactId, fieldKey, total });

  const resp = await fetch(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    {
      method: "PATCH", // ✅ REQUIRED
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Version: "2021-07-28"
      },
      body: JSON.stringify({
        customFields: {
          [fieldKey]: Number(total) // ✅ MUST be number
        }
      })
    }
  );

  const data = await resp.json();
  console.log("GHL RESPONSE:", data);

  if (!resp.ok) {
    throw new Error(`GHL update failed ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * PointWake Roof Estimator Webhook
 * GHL → API → GHL (WRITE BACK) — FINAL FIXED VERSION
 */

export default async function handler(req, res) {
  console.log("===== ROOF ESTIMATOR HIT =====");
  console.log("Timestamp:", new Date().toISOString());
  console.log("Method:", req.method);

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
      body?.customData?.contact_id ||
      body?.contact_id ||
      body?.contact?.id ||
      body?.contact?.contact_id;

    if (!contactId) {
      console.log("❌ Missing contact_id");
      return res.status(200).json({ ok: false, reason: "Missing contact_id" });
    }

    console.log("✅ Contact ID:", contactId);

    // ---------- ADDRESS (FULL NORMALIZATION + SANITIZATION) ----------
    const rawAddress =
      body?.customData?.address ||
      body?.full_address ||
      body?.address1 ||
      body?.contact?.address1 ||
      body?.contact?.full_address ||
      null;

    const address =
      typeof rawAddress === "string" && rawAddress.trim().length > 6
        ? rawAddress.trim()
        : null;

    // ---------- STORIES ----------
    const storiesRaw =
      body?.customData?.stories ||
      body?.["# of Stories"] ||
      body?.stories ||
      null;

    // ---------- SQUARES (OPTIONAL) ----------
    const squaresRaw =
      body?.customData?.squares ||
      body?.Squares ||
      body?.squares ||
      null;

    const stories = normalizeStories(storiesRaw);
    const providedSquares = normalizeSquares(squaresRaw);

    console.log("📍 ADDRESS:", address || "NOT PROVIDED");
    console.log("🏠 STORIES:", stories);
    console.log("📐 PROVIDED SQUARES:", providedSquares || "NOT PROVIDED");

    // ---------- PRICING ----------
    const PRICE_PER_SQUARE = {
      1: 500,
      2: 575,
      3: 650
    };

    let finalSquares;

    if (providedSquares) {
      finalSquares = providedSquares;
      console.log("✅ Using provided squares:", finalSquares);
    } else {
      if (!address) {
        console.log("⚠️ No usable address — skipping GHL update");
        return res.status(200).json({
          ok: true,
          updated: false,
          reason: "No usable address"
        });
      }

      console.log("🔍 Measuring roof via Google Solar...");
      const measured = await measureRoofSquaresFromSolar(address);

      if (!measured) {
        console.log("❌ Solar measurement failed");
        return res.status(200).json({
          ok: true,
          updated: false,
          reason: "Solar measurement failed"
        });
      }

      finalSquares = bufferSquares(measured);
      console.log("✅ Final squares after buffer:", finalSquares);
    }

    const pricePerSquare = PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE[1];
    const totalEstimate = roundCurrency(finalSquares * pricePerSquare);

    console.log("💰 TOTAL ESTIMATE:", totalEstimate);

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
    console.error("🔥 ERROR:", err.message);
    console.error(err.stack);
    return res.status(200).json({
      ok: false,
      error: err.message
    });
  }
}

/* ================= HELPERS ================= */

function normalizeStories(val) {
  if (!val) return 1;
  const match = String(val).match(/\d+/);
  const n = match ? Number(match[0]) : Number(val);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 1), 3);
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
  if (!key) {
    console.log("❌ GOOGLE_MAPS_API_KEY not set");
    return null;
  }

  console.log("🌍 Geocoding address:", address);

  const geoRes = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
  );
  const geo = await geoRes.json();

  if (geo.status !== "OK") {
    console.log("❌ Geocode failed:", geo);
    return null;
  }

  const { lat, lng } = geo.results[0].geometry.location;
  console.log("✅ Coordinates:", lat, lng);

  const solarRes = await fetch(
    `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${key}`
  );

  const solar = await solarRes.json();

  if (solar.error) {
    console.log("❌ Solar API error:", solar.error);
    return null;
  }

  const segments = solar?.solarPotential?.roofSegmentStats;
  if (!segments?.length) {
    console.log("❌ No roof segments found");
    return null;
  }

  const totalM2 = segments.reduce((s, r) => s + (r.areaMeters2 || 0), 0);
  if (!totalM2) return null;

  const squares = Math.ceil((totalM2 * 10.7639) / 100);
  console.log("📐 Calculated squares:", squares);
  return squares;
}

/* ================= GHL WRITE BACK ================= */

async function updateGhlTotalEstimate(contactId, total) {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const fieldKey = process.env.GHL_TOTAL_ESTIMATE_FIELD_KEY;

  if (!token) throw new Error("Missing GHL_PRIVATE_TOKEN");
  if (!fieldKey) throw new Error("Missing GHL_TOTAL_ESTIMATE_FIELD_KEY");

  const resp = await fetch(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Version: "2021-07-28"
      },
      body: JSON.stringify({
        customFields: {
          [fieldKey]: Number(total)
        }
      })
    }
  );

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`GHL update failed ${resp.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

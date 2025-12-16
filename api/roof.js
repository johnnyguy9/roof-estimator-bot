/**
 * PointWake Roof Estimator Webhook
 * GHL → API → GHL (WRITE BACK)
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: false, reason: "POST only" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const contactId =
      body?.contact_id ||
      body?.contactId ||
      body?.contact?.id;

    if (!contactId) {
      return res.status(200).json({ ok: false, reason: "Missing contact_id" });
    }

    const address =
      body?.address ||
      body?.contact?.address1;

    const stories = normalizeStories(body?.stories);
    const providedSquares = normalizeSquares(body?.squares);

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
        await updateGhlTotalEstimate(contactId, "");
        return res.status(200).json({ ok: true, updated: false });
      }

      const measured = await measureRoofSquaresFromSolar(address);
      if (!measured) {
        await updateGhlTotalEstimate(contactId, "");
        return res.status(200).json({ ok: true, updated: false });
      }

      finalSquares = bufferSquares(measured);
    }

    const pricePerSquare = PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE[1];
    const totalEstimate = roundCurrency(finalSquares * pricePerSquare);

    // 🔑 THIS IS THE ENTIRE FIX
    await updateGhlTotalEstimate(contactId, totalEstimate);

    return res.status(200).json({
      ok: true,
      contactId,
      total_estimate: totalEstimate,
      squares: finalSquares,
      stories
    });

  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: err.message
    });
  }
}

/* ---------------- HELPERS ---------------- */

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

/* -------- GOOGLE SOLAR -------- */

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

  const sqft = totalM2 * 10.7639;
  return Math.ceil(sqft / 100);
}

/* -------- GHL WRITE BACK -------- */

async function updateGhlTotalEstimate(contactId, total) {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const fieldKey = process.env.GHL_TOTAL_ESTIMATE_FIELD_KEY || "total_estimate";

  if (!token) throw new Error("Missing GHL token");

  const resp = await fetch(
    `https://services.leadconnectorhq.com/contacts/${contactId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Version: "2021-07-28"
      },
      body: JSON.stringify({
        customFields: [
          { key: fieldKey, value: String(total) }
        ]
      })
    }
  );

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`GHL update failed ${resp.status}: ${t}`);
  }
}

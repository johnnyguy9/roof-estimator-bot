/**
 * PointWake Roof Estimator Webhook - ENHANCED DEBUG VERSION
 * GHL → API → GHL (WRITE BACK)
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
      body?.contact_id ||
      body?.contactId ||
      body?.contact?.id ||
      body?.contact?.contact_id;

    if (!contactId) {
      console.log("❌ Missing contact_id");
      console.log("Available keys in body:", Object.keys(body));
      if (body?.contact) {
        console.log("Available keys in body.contact:", Object.keys(body.contact));
      }
      return res.status(200).json({ ok: false, reason: "Missing contact_id" });
    }

    console.log("✅ Contact ID found:", contactId);

    // ---------- INPUTS ----------
    const address =
      body?.address ||
      body?.contact?.address1 ||
      body?.contact?.full_address;

    const stories = normalizeStories(body?.stories);
    const providedSquares = normalizeSquares(body?.squares);

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
      console.log("✅ Using provided squares:", providedSquares);
      finalSquares = providedSquares;
    } else {
      if (!address) {
        console.log("⚠️ No address AND no provided squares — cannot calculate");
        console.log("⚠️ Skipping GHL update - nothing to write");
        return res.status(200).json({ 
          ok: true, 
          updated: false,
          reason: "No address or squares provided"
        });
      }

      console.log("🔍 Attempting to measure roof from address...");
      const measured = await measureRoofSquaresFromSolar(address);
      
      if (!measured) {
        console.log("❌ Solar measurement failed - API returned null");
        console.log("⚠️ Skipping GHL update - no measurement available");
        return res.status(200).json({ 
          ok: true, 
          updated: false,
          reason: "Solar measurement failed"
        });
      }

      console.log("✅ Solar measured:", measured, "squares (raw)");
      finalSquares = bufferSquares(measured);
      console.log("✅ After buffer:", finalSquares, "squares");
    }

    const pricePerSquare = PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE[1];
    const totalEstimate = roundCurrency(finalSquares * pricePerSquare);

    if (!Number.isFinite(totalEstimate)) {
      console.log("❌ Invalid estimate calculated — aborting write");
      return res.status(200).json({ 
        ok: true, 
        updated: false,
        reason: "Invalid estimate calculation"
      });
    }

    console.log("💰 CALCULATION:");
    console.log("   - Final Squares:", finalSquares);
    console.log("   - Price/Square: $", pricePerSquare);
    console.log("   - Total Estimate: $", totalEstimate);

    // ---------- GHL WRITE BACK ----------
    console.log("📤 Attempting GHL write-back...");
    const ghlResponse = await updateGhlTotalEstimate(contactId, totalEstimate);

    console.log("✅ GHL UPDATE SUCCESSFUL");
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
    console.error("🔥 FATAL ERROR:", err.message);
    console.error("Stack:", err.stack);
    return res.status(200).json({ 
      ok: false, 
      error: err.message,
      stack: err.stack
    });
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
  
  if (!key) {
    console.log("❌ GOOGLE_MAPS_API_KEY not set in environment");
    return null;
  }

  console.log("🌍 Geocoding address:", address);
  
  const geoRes = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
  );
  const geo = await geoRes.json();
  
  console.log("📍 Geocode status:", geo.status);
  
  if (geo.status !== "OK") {
    console.log("❌ Geocode failed:", geo);
    return null;
  }

  const { lat, lng } = geo.results[0].geometry.location;
  console.log("✅ Coordinates:", lat, lng);

  console.log("☀️ Fetching Solar API data...");
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
    console.log("❌ No roof segments found in Solar API response");
    return null;
  }

  console.log("✅ Found", segments.length, "roof segments");
  const totalM2 = segments.reduce((s, r) => s + (r.areaMeters2 || 0), 0);
  console.log("📏 Total roof area:", totalM2, "m²");
  
  if (!totalM2) return null;

  const squares = Math.ceil((totalM2 * 10.7639) / 100);
  console.log("📐 Calculated squares:", squares);
  
  return squares;
}

/* ================= GHL WRITE BACK ================= */

async function updateGhlTotalEstimate(contactId, total) {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const fieldKey = process.env.GHL_TOTAL_ESTIMATE_FIELD_KEY;

  console.log("🔧 Environment check:");
  console.log("   - GHL_PRIVATE_TOKEN:", token ? `SET (${token.substring(0, 10)}...)` : "❌ MISSING");
  console.log("   - GHL_TOTAL_ESTIMATE_FIELD_KEY:", fieldKey || "❌ MISSING");

  if (!token) throw new Error("Missing GHL_PRIVATE_TOKEN");
  if (!fieldKey) throw new Error("Missing GHL_TOTAL_ESTIMATE_FIELD_KEY");

  const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
  const payload = {
    customFields: {
      [fieldKey]: Number(total)
    }
  };

  console.log("📤 GHL UPDATE REQUEST:");
  console.log("   - URL:", url);
  console.log("   - Method: PATCH");
  console.log("   - Contact ID:", contactId);
  console.log("   - Field Key:", fieldKey);
  console.log("   - Value:", Number(total));
  console.log("   - Payload:", JSON.stringify(payload, null, 2));

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  
  console.log("📥 GHL RESPONSE:");
  console.log("   - Status:", resp.status, resp.statusText);
  console.log("   - Body:", JSON.stringify(data, null, 2));

  if (!resp.ok) {
    console.error("❌ GHL UPDATE FAILED");
    console.error("   - Status:", resp.status);
    console.error("   - Response:", JSON.stringify(data, null, 2));
    throw new Error(`GHL update failed ${resp.status}: ${JSON.stringify(data)}`);
  }

  console.log("✅ GHL update succeeded");
  return data;
}

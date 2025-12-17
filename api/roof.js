/**
 * PointWake Roof Estimator Webhook
 * GHL → API → GHL (WRITE BACK)
 * PRODUCTION VERSION - ALL FIXES APPLIED
 */

export default async function handler(req, res) {
  console.log("===== ROOF ESTIMATOR HIT =====");
  console.log("Timestamp:", new Date().toISOString());
  console.log("Method:", req.method);

  if (req.method !== "POST") {
    return res.status(200).json({ ok: false, reason: "POST only" });
  }

  try {
    /* ================= PARSE BODY ================= */
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    console.log("INCOMING BODY:", JSON.stringify(body, null, 2));

    /* ================= CONTACT ID ================= */
    const contactId =
      body?.customData?.contact_id ||
      body?.contact_id ||
      body?.contact?.id ||
      body?.contact?.contact_id ||
      null;

    if (!contactId) {
      console.log("❌ Missing contact_id");
      return res.status(200).json({ ok: false, reason: "Missing contact_id" });
    }

    console.log("✅ Contact ID:", contactId);

    /* ================= INPUT NORMALIZATION ================= */
    // Prioritize full_address for accurate geocoding
    const address =
      body?.full_address ||
      body?.customData?.full_address ||
      body?.contact?.full_address ||
      buildFullAddress(body) ||
      body?.customData?.address ||
      body?.address ||
      body?.address1 ||
      body?.contact?.address ||
      body?.contact?.address1 ||
      null;

    const storiesRaw =
      body?.customData?.stories ||
      body?.["# of Stories"] ||
      body?.stories ||
      null;

    const squaresRaw =
      body?.customData?.squares ||
      body?.Squares ||
      body?.squares ||
      null;

    console.log("🔎 Address Resolution Debug:", {
      "full_address (top)": body?.full_address,
      "customData.full_address": body?.customData?.full_address,
      "address1": body?.address1,
      "customData.address": body?.customData?.address,
      "city": body?.city,
      "state": body?.state,
      "postal_code": body?.postal_code,
      "→ RESOLVED": address
    });

    const stories = normalizeStories(storiesRaw);
    const providedSquares = normalizeSquares(squaresRaw);

    console.log("📍 ADDRESS:", address || "❌ NOT DETECTED");
    console.log("🏠 STORIES:", stories);
    console.log("📐 PROVIDED SQUARES:", providedSquares || "NOT PROVIDED");

    /* ================= PRICING ================= */
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
        console.log("⚠️ No address detected — cannot calculate");
        return res.status(200).json({
          ok: true,
          updated: false,
          reason: "No address provided"
        });
      }

      console.log("🔍 Measuring roof via Google Solar for:", address);
      const measured = await measureRoofSquaresFromSolar(address);

      if (!measured) {
        console.log("❌ Solar measurement failed for:", address);
        return res.status(200).json({
          ok: true,
          updated: false,
          reason: "Solar measurement failed"
        });
      }

      finalSquares = bufferSquares(measured);
      console.log("✅ Measured:", measured, "→ Buffered:", finalSquares);
    }

    const pricePerSquare = PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE[1];
    const totalEstimate = roundCurrency(finalSquares * pricePerSquare);

    console.log("💰 TOTAL ESTIMATE:", totalEstimate);

    /* ================= GHL WRITE BACK ================= */
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

function buildFullAddress(body) {
  // Try to construct full address from parts
  const street = body?.address1 || body?.customData?.address || body?.address;
  const city = body?.city;
  const state = body?.state;
  const zip = body?.postal_code || body?.postalCode;

  if (!street) return null;
  
  const parts = [street];
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (zip) parts.push(zip);

  // Only return if we have at least street + city or street + zip
  if (parts.length >= 3) {
    return parts.join(", ");
  }

  return null;
}

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
    console.error("❌ GOOGLE_MAPS_API_KEY not configured");
    return null;
  }

  try {
    // Step 1: Geocode
    const geoRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`
    );
    const geo = await geoRes.json();
    
    if (geo.status !== "OK") {
      console.error("❌ Geocoding failed:", geo.status, geo.error_message);
      return null;
    }

    const { lat, lng } = geo.results[0].geometry.location;
    console.log("✅ Geocoded:", { lat, lng });

    // Step 2: Solar API
    const solarRes = await fetch(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${key}`
    );
    const solar = await solarRes.json();

    // Check both possible response paths
    const segments = 
      solar?.solarPotential?.roofSegmentStats ||
      solar?.buildingInsights?.solarPotential?.roofSegmentStats;

    if (!segments?.length) {
      console.error("❌ No roof segments found in Solar API response");
      return null;
    }

    console.log("✅ Found", segments.length, "roof segments");

    // Check both possible area field paths
    const totalM2 = segments.reduce((sum, seg) => {
      const area = seg.stats?.areaMeters2 || seg.areaMeters2 || 0;
      return sum + area;
    }, 0);

    if (!totalM2) {
      console.error("❌ Total area is 0");
      return null;
    }

    const squares = Math.ceil((totalM2 * 10.7639) / 100);
    console.log("✅ Solar calculated:", totalM2, "m² →", squares, "squares");
    
    return squares;

  } catch (err) {
    console.error("❌ Solar API error:", err.message);
    return null;
  }
}

/* ================= GHL WRITE BACK ================= */

async function updateGhlTotalEstimate(contactId, total) {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const fieldKey = process.env.GHL_TOTAL_ESTIMATE_FIELD_KEY;

  if (!token) {
    console.error("❌ Missing GHL_PRIVATE_TOKEN environment variable");
    throw new Error("Missing GHL_PRIVATE_TOKEN");
  }
  if (!fieldKey) {
    console.error("❌ Missing GHL_TOTAL_ESTIMATE_FIELD_KEY environment variable");
    throw new Error("Missing GHL_TOTAL_ESTIMATE_FIELD_KEY");
  }

  console.log("📤 Updating GHL contact:", contactId, "with estimate:", total);
  console.log("🔑 Using field key:", fieldKey);

  // CRITICAL: Use v2 endpoint - OAuth tokens ONLY work here
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
  
  const payload = {
    customField: {
      [fieldKey]: total
    }
  };

  console.log("📤 Request URL:", url);
  console.log("📤 Payload:", JSON.stringify(payload));

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  
  if (!resp.ok) {
    console.error("❌ GHL UPDATE failed:", resp.status, JSON.stringify(data));
    
    if (resp.status === 401) {
      console.error("🔴 AUTHENTICATION ERROR:");
      console.error("   - Verify token is OAuth token (not API key)");
      console.error("   - Check token has contacts.write permission");
      console.error("   - Token may be expired - regenerate in GHL");
    } else if (resp.status === 422) {
      console.error("🔴 FIELD KEY ERROR:");
      console.error("   - Field key may be incorrect:", fieldKey);
      console.error("   - Check custom field exists in GHL");
    }
    
    throw new Error(JSON.stringify(data));
  }

  console.log("✅ GHL updated successfully");
  return data;
}

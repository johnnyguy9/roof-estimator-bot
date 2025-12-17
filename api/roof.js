/**
 * PointWake Roof Estimator Webhook
 * GHL → API → GHL (WRITE BACK)
 * PRODUCTION VERSION - ENHANCED LOGGING
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
          reason: "No address provided",
          debug: "Check customData.address or full_address field"
        });
      }

      console.log("🔍 Measuring roof via Google Solar for:", address);
      const measured = await measureRoofSquaresFromSolar(address);

      if (!measured) {
        console.log("❌ Solar measurement failed for:", address);
        return res.status(200).json({
          ok: true,
          updated: false,
          reason: "Solar measurement failed",
          address: address,
          debug: "Check logs for geocoding or Solar API errors"
        });
      }

      finalSquares = bufferSquares(measured);
      console.log("✅ Measured:", measured, "→ Buffered:", finalSquares);
    }

    const pricePerSquare = PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE[1];
    const totalEstimate = roundCurrency(finalSquares * pricePerSquare);

    console.log("💰 TOTAL ESTIMATE:", totalEstimate);

    /* ================= GHL WRITE BACK ================= */
    console.log("🚀 Attempting to update GHL with estimate...");
    const ghlResponse = await updateGhlTotalEstimate(contactId, totalEstimate);

    console.log("🎉 SUCCESS: Workflow complete!");
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
  
  console.log("🔍 Starting Solar measurement process...");
  console.log("📍 Input address:", address);
  
  if (!key) {
    console.error("❌ GOOGLE_MAPS_API_KEY not configured in environment variables");
    return null;
  }
  
  console.log("✅ Google API key found (length:", key.length, "chars)");

  try {
    // Step 1: Geocode
    console.log("📡 Step 1: Calling Geocoding API...");
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
    console.log("🌐 Geocoding URL:", geoUrl.replace(key, "***API_KEY***"));
    
    const geoRes = await fetch(geoUrl);
    console.log("📥 Geocoding response status:", geoRes.status, geoRes.statusText);
    
    const geo = await geoRes.json();
    console.log("📦 Geocoding response status field:", geo.status);
    
    if (geo.status !== "OK") {
      console.error("❌ Geocoding failed with status:", geo.status);
      if (geo.error_message) {
        console.error("❌ Error message:", geo.error_message);
      }
      if (geo.status === "ZERO_RESULTS") {
        console.error("❌ Address not found. Check if address is valid and complete.");
      } else if (geo.status === "REQUEST_DENIED") {
        console.error("❌ API request denied. Check API key permissions and billing.");
      } else if (geo.status === "OVER_QUERY_LIMIT") {
        console.error("❌ API quota exceeded. Check Google Cloud Console.");
      }
      return null;
    }

    const { lat, lng } = geo.results[0].geometry.location;
    const formattedAddress = geo.results[0].formatted_address;
    console.log("✅ Geocoded successfully:");
    console.log("   Coordinates:", { lat, lng });
    console.log("   Formatted address:", formattedAddress);

    // Step 2: Solar API
    console.log("📡 Step 2: Calling Solar API...");
    const solarUrl = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${key}`;
    console.log("🌐 Solar API URL:", solarUrl.replace(key, "***API_KEY***"));
    
    const solarRes = await fetch(solarUrl);
    console.log("📥 Solar API response status:", solarRes.status, solarRes.statusText);
    
    if (!solarRes.ok) {
      console.error("❌ Solar API returned error status:", solarRes.status);
      const errorText = await solarRes.text();
      console.error("❌ Solar API error response:", errorText);
      return null;
    }
    
    const solar = await solarRes.json();
    console.log("📦 Solar API response keys:", Object.keys(solar).join(", "));

    // Check both possible response paths
    const segments = 
      solar?.solarPotential?.roofSegmentStats ||
      solar?.buildingInsights?.solarPotential?.roofSegmentStats;

    if (!segments) {
      console.error("❌ No roof segments found in response");
      console.error("   Response structure:", JSON.stringify(solar, null, 2).substring(0, 500));
      return null;
    }
    
    if (!segments.length) {
      console.error("❌ Roof segments array is empty");
      return null;
    }

    console.log("✅ Found", segments.length, "roof segments");
    console.log("   Segment details:");
    segments.forEach((seg, idx) => {
      const area = seg.stats?.areaMeters2 || seg.areaMeters2 || 0;
      console.log(`   Segment ${idx + 1}: ${area.toFixed(2)} m²`);
    });

    // Check both possible area field paths
    const totalM2 = segments.reduce((sum, seg) => {
      const area = seg.stats?.areaMeters2 || seg.areaMeters2 || 0;
      return sum + area;
    }, 0);

    if (!totalM2 || totalM2 <= 0) {
      console.error("❌ Total area calculated as zero or invalid");
      return null;
    }

    const sqft = totalM2 * 10.7639;
    const squares = Math.ceil(sqft / 100);
    
    console.log("✅ Solar measurement complete:");
    console.log("   Total area:", totalM2.toFixed(2), "m²");
    console.log("   Converted:", sqft.toFixed(2), "sqft");
    console.log("   Roofing squares:", squares);
    
    return squares;

  } catch (err) {
    console.error("❌ Exception during Solar API call:");
    console.error("   Error type:", err.name);
    console.error("   Error message:", err.message);
    console.error("   Stack trace:", err.stack);
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
  console.log("🔑 Token prefix:", token.substring(0, 20) + "...");
  console.log("🔑 Token length:", token.length, "chars");

  // CRITICAL: Use v2 endpoint with correct payload structure
  const url = `https://services.leadconnectorhq.com/contacts/${contactId}`;
  
  // For Private Integration Tokens, use this payload structure
  const payload = {
    [fieldKey]: total
  };

  console.log("📤 Request URL:", url);
  console.log("📤 Payload:", JSON.stringify(payload));

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  console.log("📥 GHL API response status:", resp.status, resp.statusText);
  
  const data = await resp.json();
  console.log("📦 GHL API response data:", JSON.stringify(data).substring(0, 200));
  
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

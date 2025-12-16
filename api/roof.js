/**
 * Roof Estimation API Handler
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {
    const bodyResult = parseRequestBody(req.body);

    if (!bodyResult.success) {
      return res.status(400).json(bodyResult);
    }

    const fields = extractFields(bodyResult.data);

    if (!fields.jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is required but was not found in the request."
      });
    }

    const jobType = String(fields.jobType).trim().toLowerCase();

    // ✅ FIX: insurance path must SEND response
    if (jobType.includes("insurance")) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        needsEstimator: false,
        message: "Insurance claim detected — routed to Insurance Workflow."
      });
    }

    return await handleRetailEstimate(fields, res);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "An internal server error occurred."
    });
  }
}

/* -------------------- Parsing -------------------- */

function parseRequestBody(body) {
  let parsed = body;

  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { success: false, error: "Invalid JSON body." };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { success: false, error: "Request body must be a JSON object." };
  }

  return { success: true, data: parsed };
}

/* -------------------- Field Resolution -------------------- */

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const full = prefix ? `${prefix}.${key}` : key;
    keys.push(full);
    if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      keys.push(...flattenKeys(obj[key], full));
    }
  }
  return keys;
}

function getNestedValue(obj, path) {
  return path.split(".").reduce((acc, p) => acc?.[p], obj);
}

function resolveField(body, allKeys, possibleKeys) {
  const normalize = k => k.replace(/[\s_-]/g, "").toLowerCase();

  const normalizedKeys = allKeys.map(k => ({
    original: k,
    norm: normalize(k)
  }));

  for (const pk of possibleKeys) {
    const target = normalize(pk);

    if (body[pk] !== undefined && body[pk] !== null && body[pk] !== "") {
      return body[pk];
    }

    for (const k of normalizedKeys) {
      if (k.norm === target || k.norm.endsWith(`.${target}`)) {
        const val = getNestedValue(body, k.original);
        if (val !== undefined && val !== null && val !== "") {
          return val;
        }
      }
    }
  }
  return undefined;
}

function extractFields(body) {
  const allKeys = flattenKeys(body);

  return {
    jobType: resolveField(body, allKeys, ["jobType", "job_type", "type", "customData.jobType"]),
    roofType: resolveField(body, allKeys, ["roofType", "roof_type", "customData.roofType"]),
    stories: resolveField(body, allKeys, ["stories", "story", "customData.stories"]),
    squares: resolveField(body, allKeys, ["squares", "square", "customData.squares"]),
    address: resolveField(body, allKeys, [
      "address",
      "address1",
      "street_address",
      "contact.address1",
      "customData.address"
    ])
  };
}

/* -------------------- Measurement -------------------- */

async function measureRoof(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  try {
    const geoRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
    );
    const geoData = await geoRes.json();
    if (geoData.status !== "OK" || !geoData.results?.length) return null;

    const { lat, lng } = geoData.results[0].geometry.location;

    const solarRes = await fetch(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${apiKey}`
    );
    const solarData = await solarRes.json();

    const segments =
      solarData?.solarPotential?.roofSegmentStats ||
      solarData?.buildingInsights?.solarPotential?.roofSegmentStats;

    if (!segments?.length) return null;

    const totalAreaM2 = segments.reduce(
      (sum, seg) => sum + (seg.stats?.areaMeters2 || seg.areaMeters2 || 0),
      0
    );

    if (!totalAreaM2) return null;

    return Math.ceil((totalAreaM2 * 10.7639) / 100);
  } catch {
    return null;
  }
}

function applySquareBuffer(sq) {
  if (sq <= 15) return sq + 3;
  if (sq <= 25) return sq + 4;
  return sq + 5;
}

/* -------------------- Retail Estimator -------------------- */

async function handleRetailEstimate(fields, res) {
  const PRICING_PER_SQUARE = {
    "1": 500,
    "2": 575,
    "3": 650
  };

  let finalSquares;
  let measurementMethod;

  if (fields.squares !== undefined) {
    const sq = Number(fields.squares);
    if (isNaN(sq) || sq <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid squares value."
      });
    }
    finalSquares = Math.ceil(sq);
    measurementMethod = "provided";
  } else {
    if (!fields.address) {
      return res.status(400).json({
        success: false,
        error: "Address is required when squares are not provided."
      });
    }

    const measured = await measureRoof(fields.address);

    if (!measured) {
      return res.status(200).json({
        success: false,
        mode: "manual_required",
        needsEstimator: true,
        message: "Unable to automatically measure this roof.",
        address: fields.address
      });
    }

    finalSquares = applySquareBuffer(measured);
    measurementMethod = "google_solar_api_buffered";
  }

  const stories = Math.min(Math.max(Number(fields.stories || 1), 1), 3);
  const pricePerSquare = PRICING_PER_SQUARE[String(stories)];
  const totalPrice = finalSquares * pricePerSquare;

  // ✅ FIX: return ALL legacy-compatible fields for GHL
  return res.status(200).json({
    success: true,
    mode: "retail-estimate",

    // 🔑 GHL compatibility fields
    totalPrice,
    total_price: totalPrice,
    totalEstimate: totalPrice,
    total_estimate: totalPrice,
    estimateAmount: totalPrice,
    estimate_amount: totalPrice,

    pricePerSquare,
    price_per_square: pricePerSquare,

    squares: finalSquares,
    totalSquares: finalSquares,
    roofSquares: finalSquares,

    stories,
    jobType: String(fields.jobType).trim().toLowerCase(),
    roofType: fields.roofType || "not_specified",
    address: fields.address || "not_provided",
    measurementMethod,

    disclaimer:
      "Estimate generated using public satellite data and automated modeling. Final measurements and pricing are confirmed during an on-site audit.",
    timestamp: new Date().toISOString()
  });
}

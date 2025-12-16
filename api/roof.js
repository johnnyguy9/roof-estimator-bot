/**
 * GoHighLevel Webhook - Roof Estimation API
 * 
 * Returns a single field: contact.total_estimate
 * GHL workflows trigger based on whether this value is null or a number.
 * 
 * @param {Object} req - HTTP request object
 * @param {Object} res - HTTP response object
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      "contact.total_estimate": null
    });
  }

  try {
    const body = parseRequestBody(req.body);
    
    if (!body.success) {
      return res.status(200).json({
        "contact.total_estimate": null
      });
    }

    const fields = extractFields(body.data);
    const totalEstimate = await calculateEstimate(fields);

    // CRITICAL: Return only the field GHL expects
    return res.status(200).json({
      "contact.total_estimate": totalEstimate
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(200).json({
      "contact.total_estimate": null
    });
  }
}

/**
 * Parse and validate the request body
 */
function parseRequestBody(body) {
  let parsed = body;

  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { success: false };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { success: false };
  }

  return { success: true, data: parsed };
}

/**
 * Flatten nested object keys for flexible field resolution
 */
function flattenKeys(obj, prefix = "") {
  const keys = [];

  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;

    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);

    if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
      keys.push(...flattenKeys(obj[key], fullKey));
    }
  }

  return keys;
}

/**
 * Resolve field value from multiple possible key names
 */
function resolveField(body, allKeys, possibleKeys) {
  const normalize = (key) => key.replace(/[\s_-]/g, "").toLowerCase();

  const normalizedKeys = allKeys.map((k) => ({
    original: k,
    normalized: normalize(k)
  }));

  for (const key of possibleKeys) {
    const target = normalize(key);

    const directValue = body[key];
    if (directValue !== undefined && directValue !== null && directValue !== "") {
      return directValue;
    }

    for (const { original, normalized } of normalizedKeys) {
      if (normalized === target || normalized.endsWith(`.${target}`)) {
        const value = getNestedValue(body, original);
        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
      }
    }
  }

  return undefined;
}

/**
 * Get value from nested object path
 */
function getNestedValue(obj, path) {
  const parts = path.split(".");
  let value = obj;

  for (const part of parts) {
    value = value?.[part];
    if (value === undefined) return undefined;
  }

  return value;
}

/**
 * Extract all relevant fields from request body
 */
function extractFields(body) {
  const allKeys = flattenKeys(body);

  return {
    stories: resolveField(body, allKeys, [
      "stories",
      "story",
      "customData.stories"
    ]),
    squares: resolveField(body, allKeys, [
      "squares",
      "square",
      "customData.squares"
    ]),
    address: resolveField(body, allKeys, [
      "address",
      "address1",
      "street_address",
      "contact.address1",
      "customData.address"
    ])
  };
}

/**
 * Measure roof area using Google Solar API
 */
async function measureRoof(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.error("GOOGLE_MAPS_API_KEY is not configured");
    return null;
  }

  try {
    // Geocode address to coordinates
    const geoRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
    );
    const geoData = await geoRes.json();

    if (geoData.status !== "OK" || !geoData.results?.length) {
      console.log("Geocoding failed for address:", address);
      return null;
    }

    const { lat, lng } = geoData.results[0].geometry.location;

    // Query Solar API for roof measurements
    const solarRes = await fetch(
      `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${apiKey}`
    );
    const solarData = await solarRes.json();

    const segments =
      solarData?.solarPotential?.roofSegmentStats ||
      solarData?.buildingInsights?.solarPotential?.roofSegmentStats;

    if (!segments?.length) {
      console.log("No roof segments found for address:", address);
      return null;
    }

    // Calculate total roof area in square meters
    const totalAreaM2 = segments.reduce(
      (sum, seg) => sum + (seg.stats?.areaMeters2 || seg.areaMeters2 || 0),
      0
    );

    if (!totalAreaM2) {
      return null;
    }

    // Convert to roofing squares (1 square = 100 sqft)
    const sqft = totalAreaM2 * 10.7639;
    return Math.ceil(sqft / 100);

  } catch (err) {
    console.error("Error measuring roof:", err.message);
    return null;
  }
}

/**
 * Apply safety buffer to automated measurements
 */
function applySquareBuffer(squares) {
  if (squares <= 15) return squares + 3;
  if (squares <= 25) return squares + 4;
  return squares + 5;
}

/**
 * Calculate total estimate based on fields
 * Returns a number or null
 */
async function calculateEstimate(fields) {
  const PRICING_PER_SQUARE = {
    "1": 500,
    "2": 575,
    "3": 650
  };

  let finalSquares;

  // Use provided squares or auto-measure
  if (fields.squares !== undefined) {
    const sq = Number(fields.squares);
    
    if (isNaN(sq) || sq <= 0) {
      console.log("Invalid squares provided:", fields.squares);
      return null;
    }

    finalSquares = Math.ceil(sq);

  } else {
    // No squares provided - need address for measurement
    if (!fields.address) {
      console.log("No squares or address provided");
      return null;
    }

    const measuredSquares = await measureRoof(fields.address);

    if (!measuredSquares) {
      console.log("Unable to measure roof for address:", fields.address);
      return null;
    }

    finalSquares = applySquareBuffer(measuredSquares);
  }

  // Parse and validate stories (default to 1)
  const stories = fields.stories ? Number(fields.stories) : 1;
  
  if (isNaN(stories) || stories < 1 || stories > 3) {
    console.log("Invalid stories value:", fields.stories);
    // Use default pricing for story 1
    const pricePerSquare = PRICING_PER_SQUARE["1"];
    return finalSquares * pricePerSquare;
  }

  const pricePerSquare = PRICING_PER_SQUARE[String(stories)] || PRICING_PER_SQUARE["1"];
  const totalEstimate = finalSquares * pricePerSquare;

  console.log("Estimate calculated:", {
    squares: finalSquares,
    stories,
    pricePerSquare,
    total: totalEstimate
  });

  return totalEstimate;
}

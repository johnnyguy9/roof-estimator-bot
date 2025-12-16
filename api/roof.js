/**
 * Roof Estimation API Handler
 * 
 * Processes roofing job requests and generates automated estimates using
 * Google Solar API for roof measurements or manual square footage input.
 * 
 * @param {Object} req - HTTP request object
 * @param {Object} res - HTTP response object
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {
    const body = parseRequestBody(req.body);
    
    if (!body.success) {
      return res.status(400).json(body);
    }

    const fields = extractFields(body.data);
    
    if (!fields.jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is required but was not found in the request."
      });
    }

    const jobType = String(fields.jobType).trim().toLowerCase();

    // Route insurance claims to separate workflow
    if (jobType.includes("insurance")) {
      return handleInsuranceJob();
    }

    // Generate retail estimate
    return await handleRetailEstimate(fields, res);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "An internal server error occurred."
    });
  }
}

/**
 * Parse and validate the request body
 * @param {*} body - Raw request body
 * @returns {Object} Parsed body or error object
 */
function parseRequestBody(body) {
  let parsed = body;

  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        success: false,
        error: "Invalid JSON body."
      };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      success: false,
      error: "Request body must be a JSON object."
    };
  }

  return { success: true, data: parsed };
}

/**
 * Flatten nested object keys for flexible field resolution
 * @param {Object} obj - Object to flatten
 * @param {string} prefix - Key prefix for nested paths
 * @returns {string[]} Array of flattened key paths
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
 * @param {Object} body - Request body object
 * @param {string[]} allKeys - Flattened keys array
 * @param {string[]} possibleKeys - Possible key names to search
 * @returns {*} Resolved field value or undefined
 */
function resolveField(body, allKeys, possibleKeys) {
  const normalize = (key) => key.replace(/[\s_-]/g, "").toLowerCase();

  const normalizedKeys = allKeys.map((k) => ({
    original: k,
    normalized: normalize(k)
  }));

  for (const key of possibleKeys) {
    const target = normalize(key);

    // Direct match
    const directValue = body[key];
    if (directValue !== undefined && directValue !== null && directValue !== "") {
      return directValue;
    }

    // Fuzzy match on nested keys
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
 * @param {Object} obj - Object to traverse
 * @param {string} path - Dot-separated path
 * @returns {*} Value at path or undefined
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
 * @param {Object} body - Request body object
 * @returns {Object} Extracted fields
 */
function extractFields(body) {
  const allKeys = flattenKeys(body);

  return {
    jobType: resolveField(body, allKeys, [
      "jobType",
      "job_type",
      "type",
      "customData.jobType"
    ]),
    roofType: resolveField(body, allKeys, [
      "roofType",
      "roof_type",
      "customData.roofType"
    ]),
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
 * Handle insurance job requests
 * @returns {Object} Insurance workflow response
 */
function handleInsuranceJob() {
  return {
    success: true,
    mode: "insurance",
    needsEstimator: false,
    message: "Insurance claim detected — routed to Insurance Workflow."
  };
}

/**
 * Measure roof area using Google Solar API
 * @param {string} address - Property address
 * @returns {Promise<number|null>} Roof squares or null if measurement fails
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
 * @param {number} squares - Measured roof squares
 * @returns {number} Buffered square count
 */
function applySquareBuffer(squares) {
  if (squares <= 15) return squares + 3;
  if (squares <= 25) return squares + 4;
  return squares + 5;
}

/**
 * Validate and parse stories input
 * @param {*} stories - Stories value from request
 * @returns {Object} Validation result with parsed value
 */
function validateStories(stories) {
  const value = stories ? Number(stories) : 1;

  if (isNaN(value) || value < 1 || value > 3) {
    return {
      valid: false,
      error: "Invalid stories value. Must be 1, 2, or 3."
    };
  }

  return { valid: true, value };
}

/**
 * Validate and parse squares input
 * @param {*} squares - Squares value from request
 * @returns {Object} Validation result with parsed value
 */
function validateSquares(squares) {
  const value = Number(squares);

  if (isNaN(value) || value <= 0) {
    return {
      valid: false,
      error: "Invalid squares value. Must be a positive number."
    };
  }

  return { valid: true, value: Math.ceil(value) };
}

/**
 * Handle retail estimate generation
 * @param {Object} fields - Extracted request fields
 * @param {Object} res - HTTP response object
 * @returns {Promise<Object>} Estimate response
 */
async function handleRetailEstimate(fields, res) {
  const PRICING_PER_SQUARE = {
    "1": 500,
    "2": 575,
    "3": 650
  };

  let finalSquares;
  let measurementMethod;

  // Use provided squares or auto-measure
  if (fields.squares !== undefined) {
    const validation = validateSquares(fields.squares);
    
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    finalSquares = validation.value;
    measurementMethod = "provided";

  } else {
    if (!fields.address) {
      return res.status(400).json({
        success: false,
        error: "Address is required when squares are not provided."
      });
    }

    const measuredSquares = await measureRoof(fields.address);

    if (!measuredSquares) {
      return res.status(200).json({
        success: false,
        mode: "manual_required",
        needsEstimator: true,
        message: "Unable to automatically measure this roof. Please enter squares manually or schedule an on-site audit.",
        address: fields.address
      });
    }

    finalSquares = applySquareBuffer(measuredSquares);
    measurementMethod = "google_solar_api_buffered";
  }

  // Validate stories
  const storiesValidation = validateStories(fields.stories);
  
  if (!storiesValidation.valid) {
    return res.status(400).json({
      success: false,
      error: storiesValidation.error
    });
  }

  const stories = storiesValidation.value;
  const pricePerSquare = PRICING_PER_SQUARE[String(stories)] || PRICING_PER_SQUARE["1"];
  const totalPrice = finalSquares * pricePerSquare;

  return res.status(200).json({
    success: true,
    mode: "retail-estimate",
    jobType: String(fields.jobType).trim().toLowerCase(),
    roofType: fields.roofType || "not_specified",
    stories,
    squares: finalSquares,
    pricePerSquare,
    totalPrice,
    address: fields.address || "not_provided",
    measurementMethod,
    disclaimer: "Estimate generated using public satellite data and automated modeling. Final measurements and pricing are confirmed during an on-site audit.",
    timestamp: new Date().toISOString()
  });
}

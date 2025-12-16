/**
 * Roof Estimation API Handler
 * 
 * Generates retail roofing estimates using:
 * - Manual squares (if provided)
 * - Google Solar API roof measurement + buffer (if not)
 * 
 * CRITICAL:
 * Writes total estimate back to GHL contact field:
 * contact.total_estimate_
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {
    // -----------------------------
    // Parse request body
    // -----------------------------
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          success: false,
          error: "Invalid JSON body."
        });
      }
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({
        success: false,
        error: "Request body must be a JSON object."
      });
    }

    // -----------------------------
    // Helpers
    // -----------------------------
    function flattenKeys(obj, prefix = "") {
      let keys = [];
      for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const full = prefix ? `${prefix}.${key}` : key;
        keys.push(full);
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
          keys = keys.concat(flattenKeys(obj[key], full));
        }
      }
      return keys;
    }

    function getNestedValue(obj, path) {
      return path.split(".").reduce((o, p) => o?.[p], obj);
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
          if (k.norm === target || k.norm.endsWith("." + target)) {
            const val = getNestedValue(body, k.original);
            if (val !== undefined && val !== null && val !== "") return val;
          }
        }
      }
      return undefined;
    }

    // -----------------------------
    // Extract fields
    // -----------------------------
    const allKeys = flattenKeys(body);

    const fields = {
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

    if (!fields.jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is required."
      });
    }

    const jobType = String(fields.jobType).trim().toLowerCase();

    // -----------------------------
    // Insurance routing
    // -----------------------------
    if (jobType.includes("insurance")) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        needsEstimator: false,
        message: "Insurance claim detected."
      });
    }

    // -----------------------------
    // Google Solar API measurement
    // -----------------------------
    async function measureRoof(address) {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return null;

      try {
        const geoRes = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
        );
        const geoData = await geoRes.json();
        if (geoData.status !== "OK") return null;

        const { lat, lng } = geoData.results[0].geometry.location;

        const solarRes = await fetch(
          `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${apiKey}`
        );
        const solarData = await solarRes.json();

        const segments =
          solarData?.solarPotential?.roofSegmentStats ||
          solarData?.buildingInsights?.solarPotential?.roofSegmentStats;

        if (!segments?.length) return null;

        const totalM2 = segments.reduce(
          (sum, seg) => sum + (seg.stats?.areaMeters2 || seg.areaMeters2 || 0),
          0
        );

        const sqft = totalM2 * 10.7639;
        return Math.ceil(sqft / 100);

      } catch {
        return null;
      }
    }

    // -----------------------------
    // Square buffer
    // -----------------------------
    function applySquareBuffer(sq) {
      if (sq <= 15) return sq + 3;
      if (sq <= 25) return sq + 4;
      return sq + 5;
    }

    // -----------------------------
    // Pricing
    // -----------------------------
    const PRICING_PER_SQUARE = {
      "1": 500,
      "2": 575,
      "3": 650
    };

    const stories = Math.min(Math.max(Number(fields.stories) || 1, 1), 3);
    const pricePerSquare = PRICING_PER_SQUARE[String(stories)];

    let finalSquares;
    let measurementMethod;

    if (fields.squares !== undefined) {
      finalSquares = Math.ceil(Number(fields.squares));
      measurementMethod = "provided";
    } else {
      if (!fields.address) {
        return res.status(400).json({
          success: false,
          error: "Address required when squares not provided."
        });
      }

      const measured = await measureRoof(fields.address);
      if (!measured) {
        return res.status(200).json({
          success: false,
          needsEstimator: true,
          mode: "manual_required",
          message: "Unable to auto-measure roof."
        });
      }

      finalSquares = applySquareBuffer(measured);
      measurementMethod = "google_solar_api_buffered";
    }

    const totalPrice = finalSquares * pricePerSquare;

    // -----------------------------
    // ✅ CRITICAL GHL WRITE-BACK
    // -----------------------------
    return res.status(200).json({
      success: true,
      mode: "retail-estimate",

      contact: {
        total_estimate_: totalPrice
      },

      jobType,
      roofType: fields.roofType || "not_specified",
      stories,
      squares: finalSquares,
      pricePerSquare,
      totalPrice,
      address: fields.address || "not_provided",
      measurementMethod,

      disclaimer:
        "Estimate generated using automated satellite data. Final pricing verified during on-site inspection.",

      timestamp: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      details: err.message
    });
  }
}

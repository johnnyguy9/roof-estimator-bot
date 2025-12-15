export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.'
    });
  }

  try {
    console.log("🔥 Processing request");
    let body = req.body;

    //---------------------------------------------
    // Parse and validate JSON body
    //---------------------------------------------
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (err) {
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

    //---------------------------------------------
    // Deep key flattener with array handling
    //---------------------------------------------
    function flattenKeys(obj, prefix = "") {
      let keys = [];
      for (let key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        
        const full = prefix ? `${prefix}.${key}` : key;
        keys.push(full);
        
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
          keys = keys.concat(flattenKeys(obj[key], full));
        }
      }
      return keys;
    }

    const allKeys = flattenKeys(body);

    //---------------------------------------------
    // Universal field resolver
    //---------------------------------------------
    function resolveField(possibleKeys) {
      const normalize = k => k.replace(/[\s_-]/g, "").toLowerCase();

      const normalizedKeys = allKeys.map(k => ({
        original: k,
        norm: normalize(k)
      }));

      for (const pk of possibleKeys) {
        const target = normalize(pk);

        // Direct key match
        if (body[pk] !== undefined && body[pk] !== null && body[pk] !== '') {
          return body[pk];
        }

        // Fuzzy match on flattened keys
        for (const k of normalizedKeys) {
          if (k.norm === target || k.norm.endsWith('.' + target)) {
            const parts = k.original.split(".");
            let val = body;
            for (const p of parts) {
              val = val?.[p];
              if (val === undefined) break;
            }
            if (val !== undefined && val !== null && val !== '') {
              return val;
            }
          }
        }
      }
      return undefined;
    }

    //---------------------------------------------
    // Extract and validate fields
    //---------------------------------------------
    const jobType = resolveField(["jobType", "job_type", "type", "customData.jobType"]);
    const roofType = resolveField(["roofType", "roof_type", "customData.roofType"]);
    const stories = resolveField(["stories", "story", "customData.stories"]);
    let squares = resolveField(["squares", "square", "customData.squares"]);
    const address = resolveField([
      "address",
      "address1",
      "street_address",
      "contact.address1",
      "customData.address"
    ]);

    //---------------------------------------------
    // Validate required field: jobType
    //---------------------------------------------
    if (!jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is required but was not found in the request."
      });
    }

    const cleanJobType = String(jobType).trim().toLowerCase();

    //---------------------------------------------
    // Insurance path (no estimation needed)
    //---------------------------------------------
    if (cleanJobType.includes("insurance")) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        needsEstimator: false,
        message: "Insurance claim detected — routed to Insurance Workflow."
      });
    }

    //---------------------------------------------
    // Google Solar API measurement function
    //---------------------------------------------
    async function measureRoof(address) {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;

      if (!apiKey) {
        console.error("GOOGLE_MAPS_API_KEY is not configured");
        return null;
      }

      try {
        // Geocode the address
        const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
        const geoRes = await fetch(geoUrl);
        
        if (!geoRes.ok) {
          console.error("Geocoding API error:", geoRes.status);
          return null;
        }

        const geoData = await geoRes.json();

        if (geoData.status !== 'OK' || !geoData.results || geoData.results.length === 0) {
          console.log("No geocoding results for address:", address);
          return null;
        }

        const { lat, lng } = geoData.results[0].geometry.location;

        // Query Solar API
        const solarUrl = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${apiKey}`;
        const solarRes = await fetch(solarUrl);

        if (!solarRes.ok) {
          console.error("Solar API error:", solarRes.status);
          return null;
        }

        const solarData = await solarRes.json();

        const segments = solarData?.solarPotential?.roofSegmentStats || 
                        solarData?.buildingInsights?.solarPotential?.roofSegmentStats;

        if (!segments || segments.length === 0) {
          console.log("No roof segments found for address:", address);
          return null;
        }

        // Calculate total roof area
        const totalAreaM2 = segments.reduce(
          (sum, seg) => sum + (seg.stats?.areaMeters2 || seg.areaMeters2 || 0),
          0
        );

        if (!totalAreaM2 || totalAreaM2 <= 0) {
          return null;
        }

        // Convert square meters to squares (1 square = 100 sqft)
        const sqft = totalAreaM2 * 10.7639;
        return Math.ceil(sqft / 100);

      } catch (err) {
        console.error("Error measuring roof:", err.message);
        return null;
      }
    }

    //---------------------------------------------
    // Retail estimation logic
    //---------------------------------------------
    const PRICING_PER_SQUARE = {
      "1": 450,
      "2": 550,
      "3": 650
    };

    let finalSquares;
    let measurementMethod;

    // Use provided squares if available
    if (squares !== undefined) {
      const sq = Number(squares);
      
      if (isNaN(sq) || sq <= 0) {
        return res.status(400).json({
          success: false,
          error: "Invalid squares value. Must be a positive number."
        });
      }

      if (sq > 1000) {
        return res.status(400).json({
          success: false,
          error: "Squares value seems unrealistic (>1000). Please verify."
        });
      }

      finalSquares = Math.ceil(sq);
      measurementMethod = "provided";

    } else {
      // Auto-measure using Google Solar API
      if (!address) {
        return res.status(400).json({
          success: false,
          error: "Address is required when squares are not provided."
        });
      }

      finalSquares = await measureRoof(address);

      if (!finalSquares) {
        return res.status(200).json({
          success: false,
          mode: "manual_required",
          needsEstimator: true,
          message: "Unable to automatically measure this roof. Please enter squares manually or schedule an on-site audit.",
          address
        });
      }

      measurementMethod = "google_solar_api";
    }

    // Validate and default stories
    const storiesNum = stories ? Number(stories) : 1;
    
    if (isNaN(storiesNum) || storiesNum < 1 || storiesNum > 3) {
      return res.status(400).json({
        success: false,
        error: "Invalid stories value. Must be 1, 2, or 3."
      });
    }

    const storiesKey = String(Math.floor(storiesNum));
    const pricePerSquare = PRICING_PER_SQUARE[storiesKey] || PRICING_PER_SQUARE["1"];
    const totalPrice = finalSquares * pricePerSquare;

    //---------------------------------------------
    // Success response
    //---------------------------------------------
    return res.status(200).json({
      success: true,
      mode: "retail-estimate",
      jobType: cleanJobType,
      roofType: roofType || "not_specified",
      stories: storiesNum,
      squares: finalSquares,
      pricePerSquare,
      totalPrice,
      address: address || "not_provided",
      measurementMethod,
      disclaimer: "Estimate generated using satellite imagery. Final measurements and pricing require verification during an on-site audit.",
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    
    // Don't expose internal error details in production
    const isDev = process.env.NODE_ENV === 'development';
    
    return res.status(500).json({
      success: false,
      error: "An internal server error occurred.",
      ...(isDev && { details: err.message, stack: err.stack })
    });
  }
}

/**
 * Roof Estimation API Handler (GHL Compatible)
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        error: "Invalid JSON body"
      });
    }

    /* ----------------------------
       FIELD RESOLUTION
    -----------------------------*/
    const jobType   = body.jobType   || body.job_type;
    const roofType  = body.roofType;
    const stories   = Number(body.stories || 1);
    const squaresIn = body.squares;
    const address   = body.address;

    if (!jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is required"
      });
    }

    if (jobType.toLowerCase().includes("insurance")) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        needsEstimator: false
      });
    }

    /* ----------------------------
       MEASUREMENT
    -----------------------------*/
    async function measureRoof(address) {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return null;

      const geo = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`
      ).then(r => r.json());

      if (geo.status !== "OK") return null;

      const { lat, lng } = geo.results[0].geometry.location;

      const solar = await fetch(
        `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${apiKey}`
      ).then(r => r.json());

      const segments =
        solar?.solarPotential?.roofSegmentStats ||
        solar?.buildingInsights?.solarPotential?.roofSegmentStats;

      if (!segments?.length) return null;

      const areaM2 = segments.reduce(
        (s, seg) => s + (seg.stats?.areaMeters2 || seg.areaMeters2 || 0),
        0
      );

      const sqft = areaM2 * 10.7639;
      return Math.ceil(sqft / 100);
    }

    function applyBuffer(sq) {
      if (sq <= 15) return sq + 3;
      if (sq <= 25) return sq + 4;
      return sq + 5;
    }

    let measuredSquares;
    let measurementMethod;

    if (squaresIn) {
      measuredSquares = Math.ceil(Number(squaresIn));
      measurementMethod = "provided";
    } else {
      if (!address) {
        return res.status(400).json({
          success: false,
          error: "Address required for auto-measurement"
        });
      }

      const auto = await measureRoof(address);
      if (!auto) {
        return res.status(200).json({
          success: false,
          mode: "manual_required"
        });
      }

      measuredSquares = applyBuffer(auto);
      measurementMethod = "google_solar_api_buffered";
    }

    /* ----------------------------
       PRICING
    -----------------------------*/
    const PRICE_PER_SQUARE = {
      1: 500,
      2: 575,
      3: 650
    };

    const pricePerSquare =
      PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE[1];

    const totalEstimate = measuredSquares * pricePerSquare;

    /* ----------------------------
       🔑 GHL-CRITICAL RESPONSE
    -----------------------------*/
    return res.status(200).json({
      success: true,
      mode: "retail-estimate",

      // 🔥 THIS IS WHAT FIXES YOUR WORKFLOW
      contact: {
        total_estimate: totalEstimate
      },

      // optional debug fields
      jobType,
      roofType: roofType || "not_specified",
      stories,
      squares: measuredSquares,
      pricePerSquare,
      totalPrice: totalEstimate,
      address,
      measurementMethod,

      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}

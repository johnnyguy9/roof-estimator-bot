/**
 * GHL Roof Estimator Webhook
 * ---------------------------------
 * PURPOSE:
 * - Measure roof (Google Solar OR manual squares)
 * - Calculate price
 * - Return value DIRECTLY into Contact field
 *
 * IMPORTANT:
 * Your GHL account does NOT support response mapping.
 * This MUST return contact.total_estimate
 */

export default async function handler(req, res) {
  try {
    let body = req.body;

    // Safely parse body
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(200).json({
          contact: { total_estimate: null }
        });
      }
    }

    const stories = Number(body?.stories) || 1;
    const providedSquares = Number(body?.squares);
    const address = body?.address;

    // 🔒 PRICING — RESTORED TO ORIGINAL
    const PRICE_PER_SQUARE = {
      1: 500,
      2: 575,
      3: 650
    };

    // Google Solar measurement
    async function measureRoof(addr) {
      try {
        const key = process.env.GOOGLE_MAPS_API_KEY;
        if (!key) return null;

        const geo = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${key}`
        ).then(r => r.json());

        if (!geo.results?.length) return null;

        const { lat, lng } = geo.results[0].geometry.location;

        const solar = await fetch(
          `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&key=${key}`
        ).then(r => r.json());

        const segments =
          solar?.solarPotential?.roofSegmentStats ||
          solar?.buildingInsights?.solarPotential?.roofSegmentStats;

        if (!segments?.length) return null;

        const totalM2 = segments.reduce(
          (sum, s) => sum + (s.areaMeters2 || s.stats?.areaMeters2 || 0),
          0
        );

        if (!totalM2) return null;

        const sqft = totalM2 * 10.7639;
        return Math.ceil(sqft / 100);
      } catch {
        return null;
      }
    }

    // Buffer logic
    function bufferSquares(sq) {
      if (sq <= 15) return sq + 3;
      if (sq <= 25) return sq + 4;
      return sq + 5;
    }

    let squares;

    if (!isNaN(providedSquares) && providedSquares > 0) {
      squares = Math.ceil(providedSquares);
    } else if (address) {
      const measured = await measureRoof(address);
      if (!measured) {
        return res.status(200).json({
          contact: { total_estimate: null }
        });
      }
      squares = bufferSquares(measured);
    } else {
      return res.status(200).json({
        contact: { total_estimate: null }
      });
    }

    const pricePerSquare =
      PRICE_PER_SQUARE[String(stories)] || PRICE_PER_SQUARE["1"];

    const totalEstimate = squares * pricePerSquare;

    // ✅ THIS IS WHAT YOUR GHL ACCOUNT REQUIRES
    return res.status(200).json({
      contact: {
        total_estimate: totalEstimate
      }
    });

  } catch {
    return res.status(200).json({
      contact: { total_estimate: null }
    });
  }
}

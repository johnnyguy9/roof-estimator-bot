export default async function handler(req, res) {
  try {
    let body = req.body;

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    // ----------------------------
    // UNIVERSAL FIELD RESOLVER
    // ----------------------------
    function resolve(keys) {
      for (const k of keys) {
        if (body?.[k] !== undefined && body[k] !== "") {
          return body[k];
        }
      }
      return undefined;
    }

    const jobTypeRaw = resolve([
      "jobType",
      "job_type",
      "Job Type",
      "contact.jobType",
      "contact.job_type"
    ]);

    // 🔑 BACKWARD-COMPAT DEFAULT
    const jobType = (jobTypeRaw || "retail").toString().toLowerCase();

    const roofType = resolve(["roofType", "Roof Type"]);
    const stories = resolve(["stories", "contact.of_stories"]) || "1";
    const squaresInput = resolve(["squares"]);
    const address = resolve(["address", "address1", "contact.address1"]);

    // ----------------------------
    // INSURANCE ROUTE
    // ----------------------------
    if (jobType.includes("insurance")) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        contact: {
          total_estimate: null
        }
      });
    }

    // ----------------------------
    // RETAIL ESTIMATE LOGIC
    // ----------------------------
    const PRICE_PER_SQUARE = {
      "1": 500,
      "2": 600,
      "3": 700
    };

    let measuredSquares;

    async function measure(addr) {
      // 🔒 DO NOT TOUCH MAP LOGIC
      return 20;
    }

    if (squaresInput && !isNaN(squaresInput)) {
      measuredSquares = Math.ceil(Number(squaresInput));
    } else {
      measuredSquares = Math.ceil(await measure(address));
    }

    const pricePerSquare =
      PRICE_PER_SQUARE[stories] || PRICE_PER_SQUARE["1"];

    const totalEstimate = measuredSquares * pricePerSquare;

    // ----------------------------
    // 🔥 GHL-CRITICAL RESPONSE
    // ----------------------------
    return res.status(200).json({
      success: true,
      mode: "retail-estimate",

      contact: {
        total_estimate: totalEstimate
      },

      // optional diagnostics (safe)
      jobType,
      roofType: roofType || "not_specified",
      stories,
      squares: measuredSquares,
      pricePerSquare,
      address
    });

  } catch (err) {
    return res.status(200).json({
      success: true,
      mode: "fallback",
      contact: {
        total_estimate: null
      },
      error: err.message
    });
  }
}

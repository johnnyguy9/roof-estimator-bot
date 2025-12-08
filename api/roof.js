export default async function handler(req, res) {
  try {
    console.log("🔥 RAW req.body:", req.body);
    console.log("🔥 typeof req.body:", typeof req.body);

    // Step 1: Ensure body is an object
    let body = req.body;

    try {
      if (typeof body === "string") {
        console.log("🔥 Body is STRING — attempting JSON.parse…");
        body = JSON.parse(body);
      }
    } catch (err) {
      console.error("❌ JSON.parse FAILED — raw body was:", req.body);
      return res.status(400).json({
        success: false,
        error: "Invalid JSON received from GHL.",
        raw: req.body
      });
    }

    // Guarantee object
    if (!body || typeof body !== "object") {
      console.error("❌ Body is not an object. Body received:", body);
      return res.status(400).json({
        success: false,
        error: "Webhook body was empty or not an object.",
        raw: req.body
      });
    }

    console.log("✅ PARSED BODY:", body);
    console.log("🔑 BODY KEYS:", Object.keys(body));

    // Deep key flattener
    function flattenKeys(obj, prefix = "") {
      let keys = [];
      for (let key in obj) {
        const full = prefix ? `${prefix}.${key}` : key;
        keys.push(full);
        if (typeof obj[key] === "object" && obj[key] !== null) {
          keys = keys.concat(flattenKeys(obj[key], full));
        }
      }
      return keys;
    }

    console.log("🔎 ALL NESTED KEYS FOUND:", flattenKeys(body));

    // Field extractor
    function findField(obj, possibleKeys) {
      for (const key of possibleKeys) {
        if (obj[key] !== undefined) return obj[key];
        const parts = key.split(".");
        let cur = obj;
        for (const p of parts) cur = cur?.[p];
        if (cur !== undefined) return cur;
      }
      return undefined;
    }

    const jobType = findField(body, [
      "jobType",
      "job_type",
      "JobType",
      "contact.jobType",
      "contact.job_type",
      "contact.JobType"
    ]);

    console.log("🚨 FINAL jobType VALUE FOUND:", jobType);

    if (!jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is missing from webhook payload.",
        receivedKeys: flattenKeys(body),
        fullBody: body
      });
    }

    const cleanJobType = jobType.toString().trim();
    console.log("✨ CLEAN jobType:", cleanJobType);

    //
    // --------------------- RETAIL ESTIMATOR LOGIC ---------------------
    //

    const roofType = body.roofType;
    const stories = body.stories;
    let squares = body.squares;
    const address = body.address;

    const roofPricing = {
      "1": 450,
      "2": 550,
      "3": 650
    };

    let finalSquares = 0;

    async function fakeMeasureRoofFromAddress(addr) {
      console.log("Demo measurement for address:", addr);
      return 20;
    }

    if (squares) {
      const sq = Number(squares);
      if (isNaN(sq) || sq <= 0) {
        return res.status(400).json({
          success: false,
          error: "Invalid squares value."
        });
      }
      finalSquares = Math.ceil(sq);
    } else {
      if (!address) {
        return res.status(400).json({
          success: false,
          error: "Address required when squares is not provided."
        });
      }
      const measured = await fakeMeasureRoofFromAddress(address);
      finalSquares = Math.ceil(measured);
    }

    const pricePerSquare = roofPricing[stories];
    const totalPrice = finalSquares * pricePerSquare;

    return res.status(200).json({
      success: true,
      mode: "retail-estimate",
      needsEstimator: true,
      jobType: cleanJobType,
      roofType,
      stories,
      squares: finalSquares,
      pricePerSquare,
      totalPrice,
      currency: "USD",
      address: address || null,
      message: "Estimated price generated successfully."
    });

  } catch (err) {
    console.error("Estimator error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
      details: err.message || String(err)
    });
  }
}

export default async function handler(req, res) {
  try {
    console.log("🔥 RAW req.body:", req.body);
    let body = req.body;

    //---------------------------------------------
    // Ensure JSON object
    //---------------------------------------------
    if (typeof body === "string") {
      try {
        console.log("🔥 Body is STRING — parsing…");
        body = JSON.parse(body);
      } catch (err) {
        console.error("❌ JSON.parse failed:", err);
        return res.status(400).json({
          success: false,
          error: "Invalid JSON body.",
          raw: req.body
        });
      }
    }

    if (!body || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        error: "Body is not an object.",
        raw: req.body
      });
    }

    console.log("✅ PARSED BODY:", body);

    //---------------------------------------------
    // Deep key flattener
    //---------------------------------------------
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

    const allKeys = flattenKeys(body);
    console.log("🔎 ALL KEYS:", allKeys);

    //---------------------------------------------
    // UNIVERSAL FIELD RESOLVER (fuzzy matching)
    //---------------------------------------------
    function resolveField(possibleKeys) {
      const normalized = key =>
        key.replace(/[\s_]/g, "").toLowerCase();

      const normalizedKeys = allKeys.map(k => ({
        original: k,
        norm: normalized(k)
      }));

      for (const pk of possibleKeys) {
        const target = normalized(pk);

        // Exact root match
        if (body[pk] !== undefined) return body[pk];

        // Fuzzy match anywhere in payload
        for (const k of normalizedKeys) {
          if (k.norm.endsWith(target)) {
            const parts = k.original.split(".");
            let val = body;
            for (const p of parts) val = val?.[p];
            if (val !== undefined) return val;
          }
        }
      }
      return undefined;
    }

    //---------------------------------------------
    // Extract fields using universal resolver
    //---------------------------------------------
    const jobType = resolveField([
      "jobType",
      "Job Type",
      "job_type",
      "contact.jobType",
      "customData.jobType",
      "customData.Job Type"
    ]);

    const roofType = resolveField([
      "roofType",
      "Roof Type",
      "customData.roofType"
    ]);

    const stories = resolveField([
      "stories",
      "# of Stories",
      "customData.stories",
      "contact.stories"
    ]);

    let squares = resolveField([
      "squares",
      "Squares",
      "customData.squares"
    ]);

    const address = resolveField([
      "address",
      "address1",
      "contact.address1",
      "customData.address"
    ]);

    console.log("✔ RESOLVED jobType:", jobType);
    console.log("✔ RESOLVED roofType:", roofType);
    console.log("✔ RESOLVED stories:", stories);
    console.log("✔ RESOLVED squares:", squares);
    console.log("✔ RESOLVED address:", address);

    //---------------------------------------------
    // REQUIRED FIELD: jobType
    //---------------------------------------------
    if (!jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is missing.",
        receivedKeys: allKeys,
        body
      });
    }

    const cleanJobType = jobType.toString().trim().toLowerCase();

    //---------------------------------------------
    // Handle INSURANCE path
    //---------------------------------------------
    if (cleanJobType.includes("insurance")) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        needsEstimator: false,
        message: "Insurance claim — route to Insurance Workflow."
      });
    }

    //---------------------------------------------
    // RETAIL ESTIMATOR LOGIC
    //---------------------------------------------
    const pricing = { "1": 450, "2": 550, "3": 650 };

    let finalSquares = 0;

    async function measure(addr) {
      console.log("📏 Measuring roof for:", addr);
      return 20; // stub for testing
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
          error: "Address required when squares missing."
        });
      }
      finalSquares = Math.ceil(await measure(address));
    }

    const pps = pricing[stories];
    const total = finalSquares * pps;

    return res.status(200).json({
      success: true,
      mode: "retail-estimate",
      needsEstimator: true,
      jobType: cleanJobType,
      roofType,
      stories,
      squares: finalSquares,
      pricePerSquare: pps,
      totalPrice: total,
      address,
      message: "Estimate calculated successfully."
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Server error",
      details: err.message
    });
  }
}

//---------------------------------------------------------
// 🔎 UNIVERSAL BODY DEBUGGER — NO MORE HIDDEN ERRORS
//---------------------------------------------------------

console.log("🔥 RAW req.body:", req.body);
console.log("🔥 typeof req.body:", typeof req.body);

// Step 1: Ensure body is an object
let body = req.body;

try {
  // GHL sometimes sends a JSON string instead of an object
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

// Step 2: Guarantee body is at least an empty object
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

// Step 3: Deep inspection — flatten all keys (helps detect nested fields)
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

//---------------------------------------------------------
// 🔎 Extract fields with fallback for wrong casing or nesting
//---------------------------------------------------------

function findField(obj, possibleKeys) {
  for (const key of possibleKeys) {
    // direct hit
    if (obj[key] !== undefined) return obj[key];

    // nested hit (body.contact.jobType)
    const parts = key.split(".");
    let cur = obj;
    for (const p of parts) {
      cur = cur?.[p];
    }
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

// If STILL missing → GHL is not sending it at all.
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

    // ⭐⭐⭐ NEW: Try every possible field GHL might be using
    const jobType =
      (body.jobType ||
      body["job_type"] ||
      body["job type"] ||
      body.JobType ||
      body.jobtype ||
      body["contact.job_type"] ||
      body["contact.jobType"] ||
      "").toString().trim();

    const roofType =
      (body.roofType ||
      body["roof_type"] ||
      body["roof type"] ||
      body.RoofType ||
      "").toString().trim();

    const storiesRaw =
      body.stories ||
      body["# of stories"] ||
      body["stories_raw"] ||
      body["contact._of_stories"];

    const squaresRaw = body.squares;
    const address =
      (body.address ||
      body.Address ||
      body["contact.address1"] ||
      "").toString().trim();

    // Log the interpreted values clearly
    console.log("---- Interpreted Values ----");
    console.log("jobType:", jobType);
    console.log("roofType:", roofType);
    console.log("storiesRaw:", storiesRaw);
    console.log("squaresRaw:", squaresRaw);
    console.log("address:", address);
    console.log("----------------------------");

    // Validate job type
    if (!jobType) {
      return res.status(400).json({
        success: false,
        error: "jobType is required.",
        receivedBody: body
      });
    }

    const isInsurance = jobType.toLowerCase().includes("insurance");

    // INSURANCE → no estimator
    if (isInsurance) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        needsEstimator: false,
        message: "Insurance claim. Route to Insurance Workflow."
      });
    }

    // RETAIL path
    if (!roofType) {
      return res.status(400).json({
        success: false,
        error: "roofType is required for Retail.",
        receivedBody: body
      });
    }

    if (roofType.toLowerCase().includes("not sure")) {
      return res.status(400).json({
        success: false,
        error: "Roof type 'Not Sure' should not be sent to webhook."
      });
    }

    const stories = parseInt(storiesRaw, 10);
    if (![1, 2, 3].includes(stories)) {
      return res.status(400).json({
        success: false,
        error: "stories must be 1, 2, or 3.",
        receivedStories: storiesRaw
      });
    }

    const priceTable = {
      "Asphalt / Composite Shingle": { 1: 500, 2: 550, 3: 600 },
      Metal: { 1: 950, 2: 1000, 3: 1050 },
      "Tile / Clay / Concrete": { 1: 1200, 2: 1300, 3: 1400 },
      "Wood / Shake": { 1: 1200, 2: 1300, 3: 1400 },
      "Flat / TPO": { 1: 1000, 2: 1100, 3: 1200 }
    };

    const roofPricing = priceTable[roofType];
    if (!roofPricing) {
      return res.status(400).json({
        success: false,
        error: "Unsupported roofType: " + roofType,
        receivedroofType: roofType
      });
    }

    let finalSquares;
    if (squaresRaw !== undefined && squaresRaw !== null && squaresRaw !== "") {
      const sq = Number(squaresRaw);
      if (!Number.isFinite(sq) || sq <= 0) {
        return res.status(400).json({
          success: false,
          error: "squares must be a positive number.",
          receivedSquares: squaresRaw
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
      jobType,
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
    const address = (body.address || "").toString().trim();

    if (!jobType) {
      return res.status(400).json({ success: false, error: "jobType is required." });
    }

    const isInsurance = jobType.toLowerCase().includes("insurance");

    // INSURANCE → NO estimator
    if (isInsurance) {
      return res.status(200).json({
        success: true,
        mode: "insurance",
        needsEstimator: false,
        message: "Insurance claim. Route to Insurance Workflow."
      });
    }

    // RETAIL path
    if (!roofType) {
      return res.status(400).json({
        success: false,
        error: "roofType is required for Retail."
      });
    }

    // NOT SURE SHOULD NEVER HIT WEBHOOK
    if (roofType.toLowerCase().includes("not sure")) {
      return res.status(400).json({
        success: false,
        error: "Roof type 'Not Sure' should not be sent to webhook. Route to Appointment Workflow."
      });
    }

    const stories = parseInt(storiesRaw, 10);
    if (![1, 2, 3].includes(stories)) {
      return res.status(400).json({
        success: false,
        error: "stories must be 1, 2, or 3."
      });
    }

    const priceTable = {
      "Asphalt / Composite Shingle": { 1: 500, 2: 550, 3: 600 },
      Metal: { 1: 950, 2: 1000, 3: 1050 },
      "Tile / Clay / Concrete": { 1: 1200, 2: 1300, 3: 1400 },
      "Wood / Shake": { 1: 1200, 2: 1300, 3: 1400 },
      "Flat / TPO": { 1: 1000, 2: 1100, 3: 1200 }
    };

    const roofPricing = priceTable[roofType];
    if (!roofPricing) {
      return res.status(400).json({
        success: false,
        error: "Unsupported roofType: " + roofType
      });
    }

    let finalSquares;
    if (squaresRaw !== undefined && squaresRaw !== null && squaresRaw !== "") {
      const sq = Number(squaresRaw);
      if (!Number.isFinite(sq) || sq <= 0) {
        return res.status(400).json({
          success: false,
          error: "squares must be a positive number."
        });
      }
      finalSquares = Math.ceil(sq); // ALWAYS ROUND UP
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
      jobType,
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

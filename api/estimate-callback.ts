// /api/estimate-callback.ts

let latestResults: Record<string, any> = {};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { callbackId, status, totalEstimate, message } = req.body;

  if (!callbackId) {
    return res.status(400).json({ error: "Missing callbackId" });
  }

  // Store result temporarily (demo-safe)
  latestResults[callbackId] = {
    status,
    totalEstimate,
    message,
    receivedAt: Date.now()
  };

  return res.status(200).json({ ok: true });
}

// Optional: allow frontend to fetch result
export async function getResult(callbackId: string) {
  return latestResults[callbackId] || null;
}

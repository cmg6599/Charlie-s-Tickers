/**
 * GET /api/health — confirms Finnhub env is present (never exposes the key).
 * Vercel / CI: set FINNHUB_ENDKEY (legacy FINNHUB_API_KEY also counts as configured).
 */

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }
  const k = String(process.env.FINNHUB_ENDKEY || process.env.FINNHUB_API_KEY || "").trim();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      ok: true,
      finnhubConfigured: k.length > 0,
      finnhubKeyLength: k.length,
    })
  );
}

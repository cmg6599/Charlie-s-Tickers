/**
 * Vercel serverless handler — same behavior as server.js /api/quotes
 * so the static site can still load live quotes on *.vercel.app
 */

async function fetchYahooQuotes(symbols) {
  const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const upstream = await fetch(yahooUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 CharlieTickers/1.0",
      Accept: "application/json",
    },
  });
  const json = await upstream.json().catch(() => ({}));
  const results = json?.quoteResponse?.result || [];
  const error = json?.quoteResponse?.error || null;
  if (!upstream.ok || error || !Array.isArray(results) || results.length === 0) {
    return {
      ok: false,
      error: error?.description || `Yahoo upstream error (HTTP ${upstream.status})`,
    };
  }
  return { ok: true, provider: "yahoo", results };
}

async function fetchFinnhubQuotes(yahooSymbols, finnhubSymbols, finnhubKey) {
  if (!finnhubKey) return { ok: false, error: "Yahoo failed and no Finnhub key provided" };
  const tasks = finnhubSymbols.map(async (fSymbol, idx) => {
    const ySymbol = yahooSymbols[idx];
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(fSymbol)}&token=${encodeURIComponent(
      finnhubKey
    )}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      if (typeof json?.c !== "number" || json.c <= 0) return null;
      return {
        symbol: ySymbol,
        regularMarketPrice: json.c,
        regularMarketChangePercent: typeof json?.dp === "number" ? json.dp : 0,
      };
    } catch {
      return null;
    }
  });
  const raw = await Promise.all(tasks);
  const results = raw.filter(Boolean);
  if (results.length === 0) return { ok: false, error: "Finnhub fallback failed or key invalid" };
  return { ok: true, provider: "finnhub", results };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const host = req.headers.host || "localhost";
  const reqUrl = new URL(req.url || "/", `http://${host}`);

  try {
    const symbols = (reqUrl.searchParams.get("symbols") || "").trim();
    const finnhubSymbolsRaw = (reqUrl.searchParams.get("finnhubSymbols") || "").trim();
    const finnhubKey = (reqUrl.searchParams.get("finnhubKey") || "").trim();
    if (!symbols) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Missing symbols query param" }));
      return;
    }
    const yahooSymbols = symbols.split(",").map((s) => s.trim()).filter(Boolean);
    const finnhubSymbols = finnhubSymbolsRaw
      ? finnhubSymbolsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : yahooSymbols;

    const yahooResult = await fetchYahooQuotes(yahooSymbols);
    if (yahooResult.ok) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(yahooResult));
      return;
    }

    const finnhubResult = await fetchFinnhubQuotes(yahooSymbols, finnhubSymbols, finnhubKey);
    if (finnhubResult.ok) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(finnhubResult));
      return;
    }

    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: `Yahoo failed: ${yahooResult.error}. Finnhub failed: ${finnhubResult.error}.`,
      })
    );
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch quotes",
      })
    );
  }
}

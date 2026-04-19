/**
 * Vercel serverless handler — same behavior as server.js /api/quotes
 * so the static site can still load live quotes on *.vercel.app
 */

const YAHOO_CHUNK = 8;
const FINNHUB_GAP_MS = 150;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Yahoo batch endpoint often fails on one huge URL or from datacenter IPs; smaller chunks help. */
async function fetchYahooQuotes(symbols) {
  if (!symbols.length) return { ok: false, error: "No symbols requested" };
  const merged = [];
  const yahooErrors = [];
  for (let i = 0; i < symbols.length; i += YAHOO_CHUNK) {
    const chunk = symbols.slice(i, i + YAHOO_CHUNK);
    const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}`;
    const upstream = await fetch(yahooUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://finance.yahoo.com/",
      },
    });
    const json = await upstream.json().catch(() => ({}));
    const results = json?.quoteResponse?.result || [];
    const error = json?.quoteResponse?.error || null;
    const financeErr = json?.finance?.error || null;
    if (!upstream.ok || error || financeErr) {
      const msg =
        error?.description ||
        (typeof financeErr?.description === "string" ? financeErr.description : null) ||
        (typeof financeErr?.code === "string" ? financeErr.code : null) ||
        `Yahoo HTTP ${upstream.status}`;
      yahooErrors.push(msg);
      continue;
    }
    if (Array.isArray(results) && results.length > 0) merged.push(...results);
  }
  if (merged.length === 0) {
    return {
      ok: false,
      error:
        yahooErrors[0] ||
        "Yahoo returned no data (common from cloud servers). Add a Finnhub API key below — get one free at finnhub.io/register.",
    };
  }
  return { ok: true, provider: "yahoo", results: merged };
}

/** Free Finnhub tier: avoid parallel burst; one quote at a time with a short gap. */
async function fetchFinnhubQuotes(yahooSymbols, finnhubSymbols, finnhubKey) {
  if (!finnhubKey) return { ok: false, error: "Yahoo failed and no Finnhub key provided" };
  const results = [];
  const hints = [];
  for (let idx = 0; idx < finnhubSymbols.length; idx++) {
    if (idx > 0) await delay(FINNHUB_GAP_MS);
    const fSymbol = finnhubSymbols[idx];
    const ySymbol = yahooSymbols[idx] ?? yahooSymbols[0];
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(fSymbol)}&token=${encodeURIComponent(
      finnhubKey
    )}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429) {
        hints.push("Finnhub rate limit (429) — wait a minute or upgrade plan.");
        continue;
      }
      if (!res.ok) {
        const msg = json.error || json.message || `HTTP ${res.status}`;
        hints.push(String(msg));
        continue;
      }
      const finnhubErr = json?.error ?? json?.message;
      if (typeof finnhubErr === "string" && finnhubErr.trim()) {
        hints.push(finnhubErr.trim());
        continue;
      }
      if (typeof json?.c !== "number" || json.c <= 0) continue;
      results.push({
        symbol: ySymbol,
        regularMarketPrice: json.c,
        regularMarketChangePercent: typeof json?.dp === "number" ? json.dp : 0,
      });
    } catch {
      hints.push("network error");
    }
  }
  if (results.length === 0) {
    const tail = hints.length ? ` (${hints.slice(0, 2).join("; ")})` : "";
    return {
      ok: false,
      error: `Finnhub returned no usable prices${tail}. Check key at finnhub.io/dashboard — use a stock key, not Twelve Data.`,
    };
  }
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

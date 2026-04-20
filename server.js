import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = __dirname;

/** Local dev: load FINNHUB_API_KEY from `.env` if not already set (never commit `.env`). */
function applyLocalDotEnv() {
  if (String(process.env.FINNHUB_API_KEY || "").trim()) return;
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  try {
    let raw = readFileSync(envPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let t = lines[i].trim();
      if (!t || t.startsWith("#")) continue;
      if (t.startsWith("export ")) t = t.slice(7).trim();
      const eq = t.indexOf("=");
      if (eq < 1) {
        // Allow key name only on one line, token on the next (common mistake).
        if (t === "FINNHUB_API_KEY") {
          for (let j = i + 1; j < lines.length; j++) {
            let next = lines[j].trim();
            if (!next || next.startsWith("#")) continue;
            if (next.includes("=")) break;
            process.env.FINNHUB_API_KEY = next.trim();
            break;
          }
        }
        continue;
      }
      const k = t.slice(0, eq).trim();
      if (k !== "FINNHUB_API_KEY") continue;
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env.FINNHUB_API_KEY = v.trim();
      break;
    }
  } catch {
    /* ignore */
  }
}
applyLocalDotEnv();

const PORT = Number(process.env.PORT || 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function safePath(urlPath) {
  const u = urlPath.split("?")[0].split("#")[0];
  const normalized = path.posix.normalize(u);
  const rel = normalized.replace(/^(\.\.(\/|\\|$))+/, "");
  return rel === "/" ? "/index.html" : rel;
}

const YAHOO_CHUNK = 8;
const FINNHUB_GAP_MS = 150;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
        "Yahoo returned no data. Add a Finnhub API key in the UI (free at finnhub.io/register).",
    };
  }
  return { ok: true, provider: "yahoo", results: merged };
}

async function fetchFinnhubQuotes(yahooSymbols, finnhubSymbols, finnhubKey) {
  if (!finnhubKey)
    return {
      ok: false,
      error:
        "Yahoo failed and Finnhub is not configured. Set FINNHUB_API_KEY on the server (Vercel: Project Settings → Environment Variables; local: .env — see .env.example).",
    };
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
        hints.push("Finnhub rate limit (429)");
        continue;
      }
      if (!res.ok) {
        hints.push(String(json.error || json.message || `HTTP ${res.status}`));
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
      error: `Finnhub returned no usable prices${tail}. Use a Finnhub key from finnhub.io/dashboard.`,
    };
  }
  return { ok: true, provider: "finnhub", results };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (reqUrl.pathname === "/api/health") {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }
    const k = String(process.env.FINNHUB_API_KEY || "").trim();
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
    return;
  }

  if (reqUrl.pathname === "/api/quotes") {
    try {
      const symbols = (reqUrl.searchParams.get("symbols") || "").trim();
      const finnhubSymbolsRaw = (reqUrl.searchParams.get("finnhubSymbols") || "").trim();
      const finnhubKey = String(process.env.FINNHUB_API_KEY || "").trim();
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
          error: `Yahoo failed: ${yahooResult.error} — Finnhub failed: ${finnhubResult.error}`,
        })
      );
      return;
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "Failed to fetch Yahoo quotes",
        })
      );
      return;
    }
  }

  try {
    const rel = safePath(req.url || "/");
    const filePath = path.join(root, rel);
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error("Not a file");

    const ext = path.extname(filePath).toLowerCase();
    const buf = await readFile(filePath);

    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Charlie's Tickers running on http://localhost:${PORT}`);
  const envPath = path.join(root, ".env");
  const hasDotEnv = existsSync(envPath);
  const k = String(process.env.FINNHUB_API_KEY || "").trim();
  if (k) {
    // eslint-disable-next-line no-console
    console.log(`Finnhub fallback: configured (key length ${k.length}). GET /api/health to verify from the browser.`);
  } else if (hasDotEnv) {
    // eslint-disable-next-line no-console
    console.warn(
      "Found .env but FINNHUB_API_KEY is empty or not parsed. Use exactly: FINNHUB_API_KEY=yourkey (one line, file must be next to server.js). Remove stray characters after the value."
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "FINNHUB_API_KEY unset — copy .env.example to .env, add your key, restart. Server only reads `.env`, not `.env.example`."
    );
  }
});


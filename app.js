const FAST_REFRESH_MS = 30_000;
const SLOW_REFRESH_MS = 90_000;
const FINNHUB_STORAGE_KEY = "charlies_tickers_finnhub_key";

const TICKERS = [
  { id: "CRWV", name: "CoreWeave", type: "stock", symbol: "CRWV", yahooSymbol: "CRWV", finnhubSymbol: "CRWV" },
  { id: "GOOGL", name: "Google", type: "stock", symbol: "GOOGL", yahooSymbol: "GOOGL", finnhubSymbol: "GOOGL" },
  { id: "AMZN", name: "Amazon", type: "stock", symbol: "AMZN", yahooSymbol: "AMZN", finnhubSymbol: "AMZN" },
  { id: "ORCL", name: "Oracle", type: "stock", symbol: "ORCL", yahooSymbol: "ORCL", finnhubSymbol: "ORCL" },
  { id: "TSLA", name: "Tesla", type: "stock", symbol: "TSLA", yahooSymbol: "TSLA", finnhubSymbol: "TSLA" },
  { id: "MSFT", name: "Microsoft", type: "stock", symbol: "MSFT", yahooSymbol: "MSFT", finnhubSymbol: "MSFT" },
  { id: "BABA", name: "Alibaba", type: "stock", symbol: "BABA", yahooSymbol: "BABA", finnhubSymbol: "BABA" },
  { id: "WDAY", name: "Workday", type: "stock", symbol: "WDAY", yahooSymbol: "WDAY", finnhubSymbol: "WDAY" },
  { id: "CRM", name: "Salesforce", type: "stock", symbol: "CRM", yahooSymbol: "CRM", finnhubSymbol: "CRM" },
  { id: "AAPL", name: "Apple", type: "stock", symbol: "AAPL", yahooSymbol: "AAPL", finnhubSymbol: "AAPL" },
  { id: "NKE", name: "Nike", type: "stock", symbol: "NKE", yahooSymbol: "NKE", finnhubSymbol: "NKE" },
  { id: "BTCUSD", name: "BTC (Bitcoin)", type: "fx", symbol: "BTC/USD", yahooSymbol: "BTC-USD", finnhubSymbol: "BINANCE:BTCUSDT" },
  { id: "ETHUSD", name: "ETH (Ethereum)", type: "fx", symbol: "ETH/USD", yahooSymbol: "ETH-USD", finnhubSymbol: "BINANCE:ETHUSDT" },
  { id: "XRPUSD", name: "XRP", type: "fx", symbol: "XRP/USD", yahooSymbol: "XRP-USD", finnhubSymbol: "BINANCE:XRPUSDT" },
  { id: "SP500", name: "S&P 500", type: "index", symbol: "^GSPC", yahooSymbol: "^GSPC", finnhubSymbol: "SPY" },
];

const $ = (sel) => document.querySelector(sel);
const cardsEl = $("#cards");
const marketBadgeEl = $("#marketBadge");
const lastUpdateEl = $("#lastUpdate");
const nyTimeEl = $("#nyTime");
const apiHintEl = $("#apiHint");
const skyStarsEl = $("#skyStars");
const finnhubKeyInputEl = $("#finnhubKeyInput");
const saveFinnhubBtnEl = $("#saveFinnhubBtn");
const clearFinnhubBtnEl = $("#clearFinnhubBtn");

/** @type {Map<string, { price: number|null, percent: number|null, updatedAt: Date|null, status: 'idle'|'ok'|'err', errMsg?: string }>} */
const state = new Map();

let pollTimer = null;
let clockTimer = null;
let marketTimer = null;
let lastUpdateAt = null;
let shootingStarTimer = null;
let flyingCowTimer = null;
let currentRefreshMs = FAST_REFRESH_MS;
let currentProvider = "yahoo";

function formatMoney(n, { currency = "USD" } = {}) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}

function formatPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatTime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

function formatNYTime(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
  return parts;
}

function getNYParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  /** @type {Record<string,string>} */
  const obj = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  return obj;
}

function isMarketOpenNY(d = new Date()) {
  const p = getNYParts(d);
  const weekday = p.weekday; // Mon..Sun
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  if (dow < 1 || dow > 5) return false;
  const hh = Number(p.hour);
  const mm = Number(p.minute);
  const minutes = hh * 60 + mm;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return minutes >= open && minutes < close;
}

function nextMarketTransitionMs(d = new Date()) {
  // Simple scheduler: if open, transition at 16:00 NY; else transition at next 09:30 NY (Mon-Fri).
  const p = getNYParts(d);
  const yy = Number(p.year);
  const mo = Number(p.month);
  const dd = Number(p.day);
  const hh = Number(p.hour);
  const mm = Number(p.minute);

  // Construct an approximate NY "today" date by using the user's local Date but with NY-derived Y/M/D,
  // then adjust using Intl formatting during comparisons. Good enough for scheduling within minutes.
  const localNow = d;
  const base = new Date(localNow);
  base.setFullYear(yy, mo - 1, dd);
  base.setHours(hh, mm, 0, 0);

  const openNow = isMarketOpenNY(d);
  if (openNow) {
    // Find next 16:00 NY
    const target = new Date(base);
    target.setHours(16, 0, 0, 0);
    const delta = target.getTime() - base.getTime();
    return Math.max(5_000, Math.min(delta + 2_000, 60 * 60 * 1000));
  }

  // Find next weekday 09:30 NY
  for (let i = 0; i < 8; i++) {
    const t = new Date(base);
    t.setDate(t.getDate() + i);
    t.setHours(9, 30, 0, 0);
    if (!isMarketOpenNY(t)) {
      // Could be weekend; check weekday using formatter.
      const wd = getNYParts(t).weekday;
      const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
      if (dow < 1 || dow > 5) continue;
    }
    const delta = t.getTime() - base.getTime();
    if (delta > 0) return Math.max(10_000, Math.min(delta + 2_000, 6 * 60 * 60 * 1000));
  }
  return 60 * 60 * 1000;
}

function cardChangeClass(pct) {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "change--flat";
  if (pct > 0.001) return "change--up";
  if (pct < -0.001) return "change--down";
  return "change--flat";
}

function sparkClass(pct) {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "";
  if (pct > 0.001) return "spark--up";
  if (pct < -0.001) return "spark--down";
  return "";
}

/** Shown beside % change; avoids "fetch error" when we still display last good prices after a failed refresh. */
function cardStatusLabel(s) {
  if (s.status === "ok") return "live";
  if (s.status === "idle") return "loading";
  const hasStaleQuote = s.price != null || s.percent != null;
  if (hasStaleQuote) return "stale";
  return s.errMsg === "No data" ? "no quote" : "fetch error";
}

function renderCards() {
  const frag = document.createDocumentFragment();
  for (const t of TICKERS) {
    const s = state.get(t.id) || {
      price: null,
      percent: null,
      updatedAt: null,
      status: "idle",
    };

    const changeCls = cardChangeClass(s.percent);
    const sparkCls = sparkClass(s.percent);
    const priceStr = s.price == null ? "—" : formatMoney(s.price);
    const pctStr = formatPct(s.percent);
    const updated = s.updatedAt ? formatTime(s.updatedAt) : "—";

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = t.id;

    const top = document.createElement("div");
    top.className = "card__top";

    const left = document.createElement("div");
    const symbol = document.createElement("div");
    symbol.className = "symbol";

    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = t.symbol;

    const symText = document.createElement("span");
    symText.textContent = t.id;

    symbol.appendChild(symText);
    symbol.appendChild(pill);

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = t.name;

    left.appendChild(symbol);
    left.appendChild(name);

    const right = document.createElement("div");
    const price = document.createElement("div");
    price.className = "price";
    price.textContent = priceStr;

    const change = document.createElement("div");
    change.className = `change ${changeCls}`;

    const pct = document.createElement("span");
    pct.className = "change__pct";
    pct.textContent = pctStr;

    const status = document.createElement("span");
    status.className = "muted";
    status.textContent = cardStatusLabel(s);
    if (s.status === "err" && s.errMsg) status.title = String(s.errMsg);

    change.appendChild(pct);
    change.appendChild(status);

    right.appendChild(price);
    right.appendChild(change);

    top.appendChild(left);
    top.appendChild(right);

    const bottom = document.createElement("div");
    bottom.className = "card__bottom";

    const updatedEl = document.createElement("div");
    updatedEl.innerHTML = `<span class="muted">Updated:</span> <span class="updated">${updated}</span>`;

    const spark = document.createElement("div");
    spark.className = `spark ${sparkCls}`;
    spark.title = "Shimmer indicates refresh activity";

    bottom.appendChild(updatedEl);
    bottom.appendChild(spark);

    card.appendChild(top);
    card.appendChild(bottom);

    frag.appendChild(card);
  }
  cardsEl.replaceChildren(frag);
}

function setMarketBadge({ open, note }) {
  marketBadgeEl.classList.remove("badge--open", "badge--closed", "badge--neutral");
  if (open === true) {
    marketBadgeEl.classList.add("badge--open");
    marketBadgeEl.textContent = note || "Markets open (NYSE/Nasdaq hours)";
  } else if (open === false) {
    marketBadgeEl.classList.add("badge--closed");
    marketBadgeEl.textContent = note || "Markets closed";
  } else {
    marketBadgeEl.classList.add("badge--neutral");
    marketBadgeEl.textContent = note || "Checking market…";
  }
}

function setLastUpdate(d) {
  lastUpdateAt = d;
  lastUpdateEl.textContent = d ? formatTime(d) : "—";
}

function updateClock() {
  nyTimeEl.textContent = formatNYTime(new Date());
}

function updateApiHint() {
  const source = currentProvider === "finnhub" ? "Finnhub fallback" : "Yahoo Finance";
  apiHintEl.textContent = `Live quotes enabled via ${source}. Refresh every 30s.`;
}

function setApiHintMessage(message) {
  apiHintEl.textContent = message;
}

function isRateLimitError(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("rate") ||
    m.includes("frequency") ||
    m.includes("credits") ||
    m.includes("quota") ||
    m.includes("limit")
  );
}

function setPollingSpeed(ms) {
  if (currentRefreshMs === ms && pollTimer) return;
  stopPolling();
  currentRefreshMs = ms;
  pollTimer = setInterval(() => void refreshOnce(), currentRefreshMs);
}

function parseMaybeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchQuotesBatch() {
  const symbols = TICKERS.map((t) => t.yahooSymbol);
  const finnhubSymbols = TICKERS.map((t) => t.finnhubSymbol);
  const finnhubKey = (localStorage.getItem(FINNHUB_STORAGE_KEY) || "").trim();
  const params = new URLSearchParams({
    symbols: symbols.join(","),
    finnhubSymbols: finnhubSymbols.join(","),
    finnhubKey,
  });
  const url = `/api/quotes?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json?.ok) {
    const msg = json?.error || `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  const results = Array.isArray(json?.results) ? json.results : [];
  const map = new Map(results.map((q) => [q.symbol, q]));
  currentProvider = json?.provider || "yahoo";

  const now = new Date();
  for (const t of TICKERS) {
    const q = map.get(t.yahooSymbol);
    if (!q) {
      state.set(t.id, {
        price: null,
        percent: null,
        updatedAt: now,
        status: "err",
        errMsg: "No data",
      });
      continue;
    }
    const price = parseMaybeNumber(q.regularMarketPrice);
    const pct = parseMaybeNumber(q.regularMarketChangePercent);
    state.set(t.id, {
      price,
      percent: pct,
      updatedAt: now,
      status: "ok",
    });
  }

  setLastUpdate(now);
  return { ok: true };
}

function setAllIdle() {
  for (const t of TICKERS) {
    if (!state.has(t.id)) {
      state.set(t.id, { price: null, percent: null, updatedAt: null, status: "idle" });
    } else {
      const s = state.get(t.id);
      state.set(t.id, { ...s, status: s?.status === "ok" ? "ok" : "idle" });
    }
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPollingIfOpen() {
  stopPolling();
  currentRefreshMs = FAST_REFRESH_MS;
  const open = isMarketOpenNY(new Date());
  setMarketBadge({
    open,
    note: open ? "Markets open — refreshing every 30s" : "Markets closed — showing latest available prices",
  });

  // Immediate fetch then interval, always.
  void refreshOnce();
  pollTimer = setInterval(() => void refreshOnce(), currentRefreshMs);
}

async function refreshOnce() {
  try {
    const r = await fetchQuotesBatch();
    if (!r.ok) {
      if (isRateLimitError(r.error)) {
        setPollingSpeed(SLOW_REFRESH_MS);
        setApiHintMessage("Rate limit hit. Auto-switched to slower refresh for live data.");
      } else {
        setApiHintMessage(`Live fetch failed: ${r.error}`);
      }
      // Mark everything err (but keep last values displayed).
      const now = new Date();
      for (const t of TICKERS) {
        const prev = state.get(t.id) || {};
        state.set(t.id, {
          price: prev.price ?? null,
          percent: prev.percent ?? null,
          updatedAt: prev.updatedAt ?? now,
          status: "err",
          errMsg: r.error,
        });
      }
    } else {
      if (currentRefreshMs !== FAST_REFRESH_MS) {
        setPollingSpeed(FAST_REFRESH_MS);
      }
      updateApiHint();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    setApiHintMessage(`Network error: ${msg}`);
    const now = new Date();
    for (const t of TICKERS) {
      const prev = state.get(t.id) || {};
      state.set(t.id, {
        price: prev.price ?? null,
        percent: prev.percent ?? null,
        updatedAt: prev.updatedAt ?? now,
        status: "err",
        errMsg: msg,
      });
    }
  } finally {
    renderCards();
  }
}

function scheduleMarketWatcher() {
  if (marketTimer) clearTimeout(marketTimer);
  const ms = nextMarketTransitionMs(new Date());
  marketTimer = setTimeout(() => {
    startPollingIfOpen();
    scheduleMarketWatcher();
  }, ms);
}

function openModal() {
  // No-op: Yahoo mode does not require API key modal.
}
function closeModal() {
  // No-op: Yahoo mode does not require API key modal.
}

function wireUi() {
  if (finnhubKeyInputEl) {
    finnhubKeyInputEl.value = localStorage.getItem(FINNHUB_STORAGE_KEY) || "";
  }
  if (saveFinnhubBtnEl) {
    saveFinnhubBtnEl.addEventListener("click", () => {
      const key = (finnhubKeyInputEl?.value || "").trim();
      if (key) {
        localStorage.setItem(FINNHUB_STORAGE_KEY, key);
        setApiHintMessage("Finnhub fallback key saved. Refreshing quotes...");
      } else {
        localStorage.removeItem(FINNHUB_STORAGE_KEY);
        setApiHintMessage("Finnhub key empty. Yahoo-only mode.");
      }
      void refreshOnce();
    });
  }
  if (clearFinnhubBtnEl) {
    clearFinnhubBtnEl.addEventListener("click", () => {
      localStorage.removeItem(FINNHUB_STORAGE_KEY);
      if (finnhubKeyInputEl) finnhubKeyInputEl.value = "";
      setApiHintMessage("Finnhub key cleared. Yahoo-only mode.");
      void refreshOnce();
    });
  }
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

function scatterBackgroundFloaters() {
  const container = $("#bg-floaters");
  container.replaceChildren();

  const keywords = ["dog", "soccer", "football"];
  const count = Math.max(6, Math.min(10, Math.round(window.innerWidth / 170)));

  for (let i = 0; i < count; i++) {
    const kw = keywords[Math.floor(Math.random() * keywords.length)];
    const w = 520 + Math.floor(Math.random() * 220);
    const h = 520 + Math.floor(Math.random() * 220);

    // Unsplash Source (no key). Cache-bust per floater to increase variety.
    const src = `https://source.unsplash.com/${w}x${h}/?${encodeURIComponent(kw)}&sig=${Math.random()
      .toString(16)
      .slice(2)}`;

    const el = document.createElement("div");
    el.className = "floater";
    el.style.left = `${Math.random() * 92}%`;
    el.style.top = `${Math.random() * 92}%`;
    el.style.setProperty("--dur", `${18 + Math.random() * 16}s`);
    el.style.setProperty("--x0", `${-18 + Math.random() * 36}px`);
    el.style.setProperty("--y0", `${-14 + Math.random() * 28}px`);
    el.style.setProperty("--x1", `${-26 + Math.random() * 52}px`);
    el.style.setProperty("--y1", `${-22 + Math.random() * 44}px`);
    el.style.setProperty("--r0", `${-3 + Math.random() * 6}deg`);
    el.style.setProperty("--r1", `${-3 + Math.random() * 6}deg`);
    el.style.backgroundImage = `url("${src}")`;
    container.appendChild(el);
  }
}

function generateSkyStars() {
  if (!skyStarsEl) return;
  skyStarsEl.replaceChildren();
  const count = Math.max(20, Math.min(45, Math.round(window.innerWidth / 28)));
  for (let i = 0; i < count; i++) {
    const star = document.createElement("span");
    star.className = "star";
    star.style.left = `${Math.random() * 95}%`;
    star.style.top = `${Math.random() * 85}%`;
    star.style.setProperty("--tw", `${2 + Math.random() * 4}s`);
    skyStarsEl.appendChild(star);
  }
}

function launchShootingStar() {
  if (!skyStarsEl) return;
  const star = document.createElement("span");
  star.className = "shooting-star";
  const startX = -12;
  const startY = Math.round(skyStarsEl.clientHeight * (0.15 + Math.random() * 0.40));
  star.style.left = `${startX}px`;
  star.style.top = `${startY}px`;
  const moonEl = $("#moonTarget");
  if (moonEl) {
    const skyRect = skyStarsEl.getBoundingClientRect();
    const moonRect = moonEl.getBoundingClientRect();
    const targetX = moonRect.left + moonRect.width * 0.48 - skyRect.left;
    const targetY = moonRect.top + moonRect.height * 0.55 - skyRect.top;
    const tx = targetX - startX;
    const ty = targetY - startY;
    star.style.setProperty("--tx", `${tx}px`);
    star.style.setProperty("--ty", `${ty}px`);
  }
  skyStarsEl.appendChild(star);
  setTimeout(() => star.remove(), 2000);
}

function startShootingStars() {
  if (shootingStarTimer) clearInterval(shootingStarTimer);
  launchShootingStar();
  shootingStarTimer = setInterval(launchShootingStar, 5000);
}

function launchFlyingCow() {
  if (!skyStarsEl) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;

  const cow = document.createElement("div");
  cow.className = "flying-cow";
  cow.setAttribute("aria-hidden", "true");
  cow.textContent = "🐄";

  const skyW = skyStarsEl.clientWidth;
  const skyH = skyStarsEl.clientHeight;
  const moonEl = $("#moonTarget");

  let midX = skyW * 0.55;
  let y0 = Math.round(skyH * 0.28);
  let yMid = Math.round(skyH * 0.12);
  let y1 = Math.round(skyH * 0.32);

  if (moonEl) {
    const skyRect = skyStarsEl.getBoundingClientRect();
    const moonRect = moonEl.getBoundingClientRect();
    const moonCenterX = moonRect.left + moonRect.width * 0.5 - skyRect.left;
    midX = Math.max(40, Math.min(skyW - 40, moonCenterX - 18));
    const moonTopRel = moonRect.top - skyRect.top;
    yMid = Math.max(4, Math.min(skyH * 0.4, moonTopRel - moonRect.height * 0.15));
    y0 = Math.round(Math.min(yMid + 18, skyH * 0.42));
    y1 = Math.round(Math.min(yMid + 28, skyH * 0.48));
  }

  cow.style.setProperty("--cow-x0", "-48px");
  cow.style.setProperty("--cow-x-mid", `${midX}px`);
  cow.style.setProperty("--cow-x1", `${skyW + 48}px`);
  cow.style.setProperty("--cow-y0", `${y0}px`);
  cow.style.setProperty("--cow-y-mid", `${yMid}px`);
  cow.style.setProperty("--cow-y1", `${y1}px`);
  cow.style.setProperty("--cow-dur", "2.4s");

  skyStarsEl.appendChild(cow);
  setTimeout(() => cow.remove(), 2600);
}

function startFlyingCows() {
  if (flyingCowTimer) clearInterval(flyingCowTimer);
  launchFlyingCow();
  flyingCowTimer = setInterval(launchFlyingCow, 5000);
}

function init() {
  setAllIdle();
  renderCards();
  wireUi();
  updateApiHint();
  updateClock();
  clockTimer = setInterval(updateClock, 1_000);
  generateSkyStars();
  startShootingStars();
  startFlyingCows();

  scatterBackgroundFloaters();
  window.addEventListener("resize", () => {
    // Re-scatter occasionally (debounced).
    clearTimeout(window.__ct_resizeTimer);
    window.__ct_resizeTimer = setTimeout(() => {
      scatterBackgroundFloaters();
      generateSkyStars();
    }, 250);
  });

  startPollingIfOpen();
  scheduleMarketWatcher();
  void refreshOnce();
}

init();


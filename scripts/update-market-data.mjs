// scripts/update-market-data.mjs
// Pulls end-of-day close prices from Massive once/day and updates companies.json.
// Market cap is computed using a "shares estimate" per ticker (cached in shares.json).

import fs from "fs/promises";

const API_KEY = process.env.MASSIVE_API_KEY;
if (!API_KEY) {
  throw new Error("Missing MASSIVE_API_KEY (add it in GitHub repo Secrets).");
}

// Massive REST API base is api.massive.com (Polygon rebrand). We'll use HTTPS.
const BASE = "https://api.massive.com";

function normalizeTicker(t) {
  // Normalization helps with edge cases like BRK.B vs BRK-B
  return String(t || "")
    .trim()
    .toUpperCase()
    .replace("-", ".");
}

async function fileExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  const raw = await fs.readFile(path, "utf8");
  return JSON.parse(raw);
}

async function writeJson(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// YYYY-MM-DD in America/New_York
function nyDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function addDays(yyyyMmDd, deltaDays) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${txt.slice(0, 400)}`);
  }
  return res.json();
}

async function fetchDailyGrouped(dateStr) {
  // Daily Market Summary endpoint: /v2/aggs/grouped/locale/us/market/stocks/{date}
  // Returns: results[] with T (ticker) and c (close). We'll request adjusted prices.
  const url =
    `${BASE}/v2/aggs/grouped/locale/us/market/stocks/${dateStr}` +
    `?adjusted=true&include_otc=false&apiKey=${encodeURIComponent(API_KEY)}`;

  return fetchJson(url);
}

// Find the most recent trading day by trying yesterday and backing up.
// (Weekends/holidays return empty results.)
async function getMostRecentTradingDayData() {
  const todayNY = nyDateString();
  let candidate = addDays(todayNY, -1);

  for (let i = 0; i < 10; i++) {
    try {
      const data = await fetchDailyGrouped(candidate);
      if (Array.isArray(data?.results) && data.results.length > 0) {
        return { asOfDate: candidate, data };
      }
    } catch {
      // ignore and back up a day
    }
    candidate = addDays(candidate, -1);
  }

  throw new Error("Could not find recent trading day data (10-day lookback).");
}

async function main() {
  // Load your company list
  const companies = await readJson("companies.json");

  // Build set of tickers we care about (S&P 500 list)
  const wantedTickers = new Set(companies.map((c) => normalizeTicker(c.ticker)));

  // Build (or load) shares cache.
  // shares[ticker] ≈ marketCap / price from your existing dataset.
  let shares = {};
  if (await fileExists("shares.json")) {
    shares = await readJson("shares.json");
  } else {
    for (const c of companies) {
      const t = normalizeTicker(c.ticker);
      const p = Number(c.price);
      const mc = Number(c.marketCap);
      if (Number.isFinite(p) && p > 0 && Number.isFinite(mc) && mc > 0) {
        shares[t] = mc / p;
      }
    }
    await writeJson("shares.json", shares);
    console.log(`Created shares.json with ${Object.keys(shares).length} tickers.`);
  }

  // Fetch last trading day closes
  const { asOfDate, data } = await getMostRecentTradingDayData();

  // Build a map: ticker -> close
  const closeByTicker = new Map();
  for (const row of data.results) {
    const t = normalizeTicker(row?.T);
    const close = row?.c;
    if (!wantedTickers.has(t)) continue;
    if (typeof close === "number" && Number.isFinite(close)) {
      closeByTicker.set(t, close);
    }
  }

  // Update companies.json
  let updated = 0;
  let missing = 0;

  for (const c of companies) {
    const t = normalizeTicker(c.ticker);
    const close = closeByTicker.get(t);

    if (typeof close !== "number") {
      missing++;
      continue;
    }

    c.price = close;

    const sh = shares[t];
    if (typeof sh === "number" && Number.isFinite(sh) && sh > 0) {
      c.marketCap = close * sh;
    }
    updated++;
  }

  await writeJson("companies.json", companies);

  // Helpful metadata file (optional to display on the site)
  await writeJson("data_asof.json", {
    asOfDate,
    updatedAtUTC: new Date().toISOString(),
    updatedCompanies: updated,
    missingCompanies: missing,
  });

  console.log(
    `Done. asOfDate=${asOfDate} updated=${updated} missing=${missing} tickersFound=${closeByTicker.size}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

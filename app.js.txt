// Companydle — fully static S&P 500 guessing game
// Works on GitHub Pages (no server). Your daily state is stored in localStorage.

const MAX_GUESSES = 8;
const STORAGE_KEY = "companydle-state-v1";
const ANSWER_SALT = "companydle-v1"; // change this if you ever want a totally new long-term schedule

// ---------- Buckets (edit these whenever you want) ----------
const BUCKETS = {
  founded: [
    { label: "<1900", upper: 1900 },
    { label: "1900–1949", upper: 1950 },
    { label: "1950–1969", upper: 1970 },
    { label: "1970–1989", upper: 1990 },
    { label: "1990–2009", upper: 2010 },
    { label: "2010+", upper: Infinity },
  ],
  price: [
    { label: "<$25", upper: 25 },
    { label: "$25–$50", upper: 50 },
    { label: "$50–$100", upper: 100 },
    { label: "$100–$200", upper: 200 },
    { label: "$200–$500", upper: 500 },
    { label: "$500+", upper: Infinity },
  ],
  marketCap: [
    { label: "<$10B", upper: 10e9 },
    { label: "$10B–$50B", upper: 50e9 },
    { label: "$50B–$200B", upper: 200e9 },
    { label: "$200B–$500B", upper: 500e9 },
    { label: "$500B–$1T", upper: 1e12 },
    { label: "$1T+", upper: Infinity },
  ],
  employees: [
    { label: "<10K", upper: 10_000 },
    { label: "10K–50K", upper: 50_000 },
    { label: "50K–100K", upper: 100_000 },
    { label: "100K–200K", upper: 200_000 },
    { label: "200K–500K", upper: 500_000 },
    { label: "500K+", upper: Infinity },
  ],
  pe: [
    { label: "<10", upper: 10 },
    { label: "10–20", upper: 20 },
    { label: "20–30", upper: 30 },
    { label: "30–50", upper: 50 },
    { label: "50–100", upper: 100 },
    { label: "100+", upper: Infinity },
  ],
};

// ---------- DOM ----------
const guessInput = document.getElementById("guessInput");
const guessBtn = document.getElementById("guessBtn");
const suggestionsEl = document.getElementById("suggestions");
const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const attemptsEl = document.getElementById("attempts");
const todayEl = document.getElementById("today");
const shareBtn = document.getElementById("shareBtn");

const helpBtn = document.getElementById("helpBtn");
const helpDialog = document.getElementById("helpDialog");
const closeHelpBtn = document.getElementById("closeHelpBtn");

// ---------- Data ----------
let companies = [];        // used for suggestions
let answerList = [];       // stable ordering for daily schedule
let byTicker = new Map();  // ticker -> company
let byName = new Map();    // normalized name -> company
let answer = null;         // today's company

// ---------- Utilities ----------
// Daily reset at midnight New York time (America/New_York).
// This matches "midnight in New York" even across daylight saving changes.
function getTodayNY() {
  const tz = "America/New_York";
  const now = new Date();

  // Use formatToParts to avoid locale quirks.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;

  if (!y || !m || !d) {
    // Fallback: UTC (shouldn't happen in modern browsers)
    return new Date().toISOString().slice(0, 10);
  }
  return `${y}-${m}-${d}`;
}

function getUTCDayNumber(dateStr) {
  // dateStr: YYYY-MM-DD
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Deterministic, non-crypto hash
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function mulberry32(seed) {
  // tiny seeded RNG
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seedStr) {
  const seed = cyrb53(seedStr) >>> 0;
  const rand = mulberry32(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDailyAnswer(dateStr) {
  if (!answerList.length) return null;

  // No repeats until the cycle completes (e.g. ~500 days)
  const schedule = seededShuffle(answerList, ANSWER_SALT);
  const day = getUTCDayNumber(dateStr);
  const idx = ((day % schedule.length) + schedule.length) % schedule.length;
  return schedule[idx];
}

function bucketUpper(value, bucketDefs) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { label: "N/A", index: -1 };
  }
  for (let i = 0; i < bucketDefs.length; i++) {
    if (value < bucketDefs[i].upper) return { label: bucketDefs[i].label, index: i };
  }
  return { label: bucketDefs[bucketDefs.length - 1].label, index: bucketDefs.length - 1 };
}

function arrowFor(guessVal, answerVal) {
  if (guessVal === null || answerVal === null || guessVal === undefined || answerVal === undefined) return "";
  if (guessVal === answerVal) return "";
  return guessVal < answerVal ? "▲" : "▼";
}

function setStatus(msg) { statusEl.textContent = msg; }
function setAttempts(used) { attemptsEl.textContent = `${used} / ${MAX_GUESSES}`; }

// ---------- Game State ----------
function loadState() {
  const today = getTodayNY();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { date: today, guesses: [], solved: false };
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.date !== today) return { date: today, guesses: [], solved: false };
    if (!Array.isArray(parsed.guesses)) parsed.guesses = [];
    parsed.solved = !!parsed.solved;
    return parsed;
  } catch {
    return { date: today, guesses: [], solved: false };
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- Rendering ----------
function makeCell(text, isOk, extraClass = "") {
  const el = document.createElement("div");
  el.className = `cell ${isOk ? "ok" : "bad"} ${extraClass}`.trim();
  el.textContent = text;
  return el;
}

function makeNumericCell(bucketLabel, isOk, arrow) {
  const el = document.createElement("div");
  el.className = `cell ${isOk ? "ok" : "bad"}`.trim();

  const spanText = document.createElement("span");
  spanText.textContent = bucketLabel;
  el.appendChild(spanText);

  if (!isOk && arrow) {
    const spanArrow = document.createElement("span");
    spanArrow.className = "arrow";
    spanArrow.textContent = arrow;
    el.appendChild(spanArrow);
  }
  return el;
}

function renderGuessRow(guessCompany) {
  const row = document.createElement("div");
  row.className = "row";

  const isCompanyCorrect = guessCompany.ticker === answer.ticker;
  row.appendChild(makeCell(
    `${guessCompany.name} (${guessCompany.ticker})${isCompanyCorrect ? " ✅" : ""}`,
    isCompanyCorrect,
    "company"
  ));

  // Sector (exact match)
  row.appendChild(makeCell(guessCompany.sector || "N/A", (guessCompany.sector || "") === (answer.sector || "")));

  // HQ (state or country)
  row.appendChild(makeCell(guessCompany.hq || "N/A", (guessCompany.hq || "") === (answer.hq || "")));

  // Founded bucket + arrow
  {
    const g = bucketUpper(guessCompany.founded, BUCKETS.founded);
    const a = bucketUpper(answer.founded, BUCKETS.founded);
    row.appendChild(makeNumericCell(g.label, g.index === a.index && g.index !== -1, arrowFor(guessCompany.founded, answer.founded)));
  }

  // Price bucket + arrow
  {
    const g = bucketUpper(guessCompany.price, BUCKETS.price);
    const a = bucketUpper(answer.price, BUCKETS.price);
    row.appendChild(makeNumericCell(g.label, g.index === a.index && g.index !== -1, arrowFor(guessCompany.price, answer.price)));
  }

  // Market cap bucket + arrow
  {
    const g = bucketUpper(guessCompany.marketCap, BUCKETS.marketCap);
    const a = bucketUpper(answer.marketCap, BUCKETS.marketCap);
    row.appendChild(makeNumericCell(g.label, g.index === a.index && g.index !== -1, arrowFor(guessCompany.marketCap, answer.marketCap)));
  }

  // Employees bucket + arrow
  {
    const g = bucketUpper(guessCompany.employees, BUCKETS.employees);
    const a = bucketUpper(answer.employees, BUCKETS.employees);
    row.appendChild(makeNumericCell(g.label, g.index === a.index && g.index !== -1, arrowFor(guessCompany.employees, answer.employees)));
  }

  // P/E bucket + arrow (treat N/A specially)
  {
    const g = bucketUpper(guessCompany.pe, BUCKETS.pe);
    const a = bucketUpper(answer.pe, BUCKETS.pe);
    const ok = (g.index === -1 && a.index === -1) || (g.index === a.index && g.index !== -1);
    row.appendChild(makeNumericCell(g.label, ok, arrowFor(guessCompany.pe, answer.pe)));
  }

  rowsEl.prepend(row);
}

function clearBoard() { rowsEl.innerHTML = ""; }

function showShareButtonIfFinished(state) {
  const finished = state.solved || state.guesses.length >= MAX_GUESSES;
  shareBtn.classList.toggle("hidden", !finished);
}

function makeShareText(state) {
  const resultLine = state.solved
    ? `Solved in ${state.guesses.length}/${MAX_GUESSES}`
    : `Unsolved (0/${MAX_GUESSES})`;

  const lines = [];
  for (const t of state.guesses) {
    const g = byTicker.get(t);
    if (!g) continue;

    const tiles = [];
    tiles.push((g.sector || "") === (answer.sector || "") ? "🟩" : "⬛");
    tiles.push((g.hq || "") === (answer.hq || "") ? "🟩" : "⬛");
    tiles.push(bucketUpper(g.founded, BUCKETS.founded).index === bucketUpper(answer.founded, BUCKETS.founded).index ? "🟩" : "⬛");
    tiles.push(bucketUpper(g.price, BUCKETS.price).index === bucketUpper(answer.price, BUCKETS.price).index ? "🟩" : "⬛");
    tiles.push(bucketUpper(g.marketCap, BUCKETS.marketCap).index === bucketUpper(answer.marketCap, BUCKETS.marketCap).index ? "🟩" : "⬛");
    tiles.push(bucketUpper(g.employees, BUCKETS.employees).index === bucketUpper(answer.employees, BUCKETS.employees).index ? "🟩" : "⬛");

    const gi = bucketUpper(g.pe, BUCKETS.pe).index;
    const ai = bucketUpper(answer.pe, BUCKETS.pe).index;
    const peOk = (gi === -1 && ai === -1) || (gi === ai && gi !== -1);
    tiles.push(peOk ? "🟩" : "⬛");

    lines.push(tiles.join(""));
  }

  const baseUrl = location.origin + location.pathname;
  return `Companydle ${state.date} — ${resultLine}\n${lines.join("\n")}\n${baseUrl}`;
}

// ---------- Suggestions ----------
function hideSuggestions() {
  suggestionsEl.style.display = "none";
  suggestionsEl.innerHTML = "";
}

function escapeHtml(str) {
  return (str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showSuggestions(items) {
  suggestionsEl.innerHTML = "";
  for (const c of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion";
    btn.setAttribute("role", "option");
    btn.innerHTML = `<span>${escapeHtml(c.name)}</span><span class="ticker">${escapeHtml(c.ticker)}</span>`;
    btn.addEventListener("click", () => submitGuess(c.ticker));
    suggestionsEl.appendChild(btn);
  }
  suggestionsEl.style.display = items.length ? "block" : "none";
}

function getSuggestions(query) {
  const q = normalize(query);
  if (!q) return [];

  const prefix = [];
  const contains = [];

  for (const c of companies) {
    const n = normalize(c.name);
    const t = (c.ticker || "").toLowerCase();
    if (n.startsWith(q) || t.startsWith(q)) prefix.push(c);
    else if (n.includes(q) || t.includes(q)) contains.push(c);
  }

  return prefix.concat(contains).slice(0, 12);
}

// ---------- Core gameplay ----------
function lockUI(locked) {
  guessInput.disabled = locked;
  guessBtn.disabled = locked;
}

function submitGuess(inputValue) {
  const state = loadState();
  if (!answer) return;

  if (state.solved) {
    setStatus(`Already solved. Answer: ${answer.name} (${answer.ticker}).`);
    lockUI(true);
    showShareButtonIfFinished(state);
    return;
  }

  if (state.guesses.length >= MAX_GUESSES) {
    setStatus(`Out of guesses. Answer was: ${answer.name} (${answer.ticker}).`);
    lockUI(true);
    showShareButtonIfFinished(state);
    return;
  }

  const raw = (inputValue ?? guessInput.value ?? "").trim();
  if (!raw) { setStatus("Type a company name or ticker."); return; }

  const qNorm = normalize(raw);
  const qTicker = raw.toUpperCase();

  let company = byTicker.get(qTicker) || byName.get(qNorm);

  // If not exact, try "best" suggestion if there's only one
  if (!company) {
    const sug = getSuggestions(raw);
    if (sug.length === 1) company = sug[0];
  }

  if (!company) { setStatus("No match. Try the official company name or ticker."); return; }
  if (state.guesses.includes(company.ticker)) { setStatus("You already guessed that one."); return; }

  state.guesses.push(company.ticker);
  renderGuessRow(company);

  guessInput.value = "";
  hideSuggestions();

  if (company.ticker === answer.ticker) {
    state.solved = true;
    setStatus(`Correct! The answer is ${answer.name} (${answer.ticker}).`);
    lockUI(true);
  } else if (state.guesses.length >= MAX_GUESSES) {
    setStatus(`Out of guesses. Answer was: ${answer.name} (${answer.ticker}).`);
    lockUI(true);
  } else {
    setStatus("Keep going!");
  }

  setAttempts(state.guesses.length);
  saveState(state);
  showShareButtonIfFinished(state);
}

function hydrateFromState(state) {
  clearBoard();

  // We use prepend() when drawing rows, so to preserve visual order (oldest on top),
  // we can render in guess order and accept newest-on-top, or reverse. Royaledle typically shows newest on top.
  for (const ticker of state.guesses) {
    const c = byTicker.get(ticker);
    if (c) renderGuessRow(c);
  }

  setAttempts(state.guesses.length);

  if (state.solved) {
    setStatus(`Solved! Answer: ${answer.name} (${answer.ticker}).`);
    lockUI(true);
  } else if (state.guesses.length >= MAX_GUESSES) {
    setStatus(`Out of guesses. Answer was: ${answer.name} (${answer.ticker}).`);
    lockUI(true);
  } else {
    setStatus("Make your first guess.");
    lockUI(false);
  }

  showShareButtonIfFinished(state);
}

// ---------- Init ----------
async function init() {
  const today = getTodayNY();
  todayEl.textContent = today;

  const res = await fetch("companies.json", { cache: "no-store" });
  companies = await res.json();

  companies = companies
    .filter(c => c && c.name && c.ticker)
    .map(c => ({
      name: String(c.name).trim(),
      ticker: String(c.ticker).trim().toUpperCase(),
      sector: c.sector ? String(c.sector).trim() : null,
      hq: c.hq ? String(c.hq).trim() : null,
      founded: (c.founded === null || c.founded === undefined) ? null : Number(c.founded),
      price: (c.price === null || c.price === undefined) ? null : Number(c.price),
      marketCap: (c.marketCap === null || c.marketCap === undefined) ? null : Number(c.marketCap),
      employees: (c.employees === null || c.employees === undefined) ? null : Number(c.employees),
      pe: (c.pe === null || c.pe === undefined) ? null : Number(c.pe),
    }));

  companies.sort((a, b) => a.name.localeCompare(b.name));
  answerList = [...companies].sort((a, b) => a.ticker.localeCompare(b.ticker));

  byTicker = new Map(companies.map(c => [c.ticker, c]));
  byName = new Map(companies.map(c => [normalize(c.name), c]));

  answer = pickDailyAnswer(today);
  if (!answer) { setStatus("No data loaded."); lockUI(true); return; }

  const state = loadState();
  hydrateFromState(state);

  // Events
  guessBtn.addEventListener("click", () => submitGuess());
  guessInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitGuess(); }
    else if (e.key === "Escape") hideSuggestions();
  });

  guessInput.addEventListener("input", () => {
    const items = getSuggestions(guessInput.value);
    showSuggestions(items);
  });

  document.addEventListener("click", (e) => {
    if (!suggestionsEl.contains(e.target) && e.target !== guessInput) hideSuggestions();
  });

  // Help
  helpBtn.addEventListener("click", () => helpDialog.showModal());
  closeHelpBtn.addEventListener("click", () => helpDialog.close());

  // Share
  shareBtn.addEventListener("click", async () => {
    const s = loadState();
    const text = makeShareText(s);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied share text to clipboard!");
    } catch {
      window.prompt("Copy this:", text);
    }
  });
}

init().catch((err) => {
  console.error(err);
  setStatus("Error loading app.js or companies.json.");
});


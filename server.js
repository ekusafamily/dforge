const express = require("express");
const cors    = require("cors");
const puppeteer = require("puppeteer");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Config (use environment variables in production) ──────────────────────
const DFORGE_EMAIL      = process.env.DFORGE_EMAIL    || "brianireri002@gmail.com";
const DFORGE_PASSWORD   = process.env.DFORGE_PASSWORD || "Ilove.mumu047";
const DFORGE_LOGIN_URL  = "https://dforge.site/login";
const DFORGE_TARGET_URL = "https://dforge.site/commissions";

// Cache for 5 minutes
let cache = { data: null, fetchedAt: null };
const CACHE_TTL_MS = 5 * 60 * 1000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Scraper ───────────────────────────────────────────────────────────────
async function scrapeDforgeCommissions() {
  console.log("🚀 Launching Puppeteer...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",       // required on Render / Docker
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // ── Login ────────────────────────────────────────────────────────────
    console.log("🔐 Logging in...");
    await page.goto(DFORGE_LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.type('input[type="email"]', DFORGE_EMAIL, { delay: 40 });
    await page.type('input[type="password"]', DFORGE_PASSWORD, { delay: 40 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click('button[type="submit"]'),
    ]);
    console.log("✅ Logged in →", page.url());

    // ── Navigate to commissions ──────────────────────────────────────────
    if (!page.url().includes("/commissions")) {
      await page.goto(DFORGE_TARGET_URL, { waitUntil: "networkidle2", timeout: 30000 });
    }

    // Wait for content to render (CSR app)
    await page.waitForSelector("main", { timeout: 15000 });
    console.log("⏳ Waiting for initial data to settle...");
    await new Promise((r) => setTimeout(r, 3500));

    // ── Click "This Month" card to switch period ─────────────────────────
    console.log("📅 Clicking 'This Month' card...");
    const clicked = await page.evaluate(() => {
      // Find the card/button that contains "This Month" text
      const allEls = [...document.querySelectorAll("button, div[role='button'], div[tabindex]")];
      const thisMonthBtn = allEls.find(
        (el) => el.textContent.trim().match(/^This Month/) ||
                (el.childElementCount < 6 && el.textContent.includes("This Month") && !el.textContent.includes("Last Month"))
      );
      if (thisMonthBtn) {
        thisMonthBtn.click();
        return true;
      }
      return false;
    });
    console.log(clicked ? "✅ Clicked 'This Month'" : "⚠️  'This Month' button not found, continuing...");

    // Wait for data to reload after clicking
    await new Promise((r) => setTimeout(r, 3000));

    // ── Extract only what we need ────────────────────────────────────────
    console.log("🔍 Extracting targeted data...");
    const data = await page.evaluate(() => {

      const pageText = document.body.innerText;

      // ══════════════════════════════════════════════════════════════════
      // 1. THIS MONTH STATS
      // After clicking "This Month", the main stats block is updated.
      // We pull values from the full page text using targeted regex.
      // ══════════════════════════════════════════════════════════════════
      const thisMonth = {};

      // Gross markup — find the largest "$X.XX" near "Gross app markup"
      const grossMatches = [...pageText.matchAll(/Gross app markup[\s\S]{0,80}\$([\d,.]+)/gi)];
      if (grossMatches.length > 0) {
        // Pick the one with the highest value (monthly will be biggest)
        const amounts = grossMatches.map(m => ({ raw: m[1], val: parseFloat(m[1].replace(/,/g, "")) }));
        amounts.sort((a, b) => b.val - a.val);
        thisMonth.grossMarkup = "$" + amounts[0].raw;
      } else {
        const gm = pageText.match(/Gross app markup\s*\$([\d,.]+)/i);
        thisMonth.grossMarkup = gm ? "$" + gm[1] : "—";
      }

      // Your share
      const shareMatches = [...pageText.matchAll(/Your share\s*\((\d+)%\)\s*\$([\d,.]+)/gi)];
      if (shareMatches.length > 0) {
        const amounts = shareMatches.map(m => ({ pct: m[1], raw: m[2], val: parseFloat(m[2].replace(/,/g, "")) }));
        amounts.sort((a, b) => b.val - a.val);
        thisMonth.yourSharePct = amounts[0].pct + "%";
        thisMonth.yourShare    = "$" + amounts[0].raw;
      } else {
        thisMonth.yourSharePct = "80%";
        thisMonth.yourShare    = "—";
      }

      // DForge share
      const dforgeMatches = [...pageText.matchAll(/DForge\s*(?:share)?\s*\((\d+)%\)\s*\$([\d,.]+)/gi)];
      if (dforgeMatches.length > 0) {
        const amounts = dforgeMatches.map(m => ({ pct: m[1], raw: m[2], val: parseFloat(m[2].replace(/,/g, "")) }));
        amounts.sort((a, b) => b.val - a.val);
        thisMonth.dforgeSharePct = amounts[0].pct + "%";
        thisMonth.dforgeShare    = "$" + amounts[0].raw;
      } else {
        thisMonth.dforgeSharePct = "20%";
        thisMonth.dforgeShare    = "—";
      }

      // Total trades — pick highest count (monthly will be biggest)
      const tradeMatches = [...pageText.matchAll(/([\d,]+)\s*trades?/gi)];
      if (tradeMatches.length > 0) {
        const counts = tradeMatches.map(m => parseInt(m[1].replace(/,/g, ""), 10));
        thisMonth.trades = Math.max(...counts).toLocaleString();
      } else {
        thisMonth.trades = "—";
      }

      // Traders
      const tradersMatches = [...pageText.matchAll(/([\d,]+)\s*traders?/gi)];
      if (tradersMatches.length > 0) {
        const counts = tradersMatches.map(m => parseInt(m[1].replace(/,/g, ""), 10));
        thisMonth.traders = Math.max(...counts).toLocaleString();
      } else {
        thisMonth.traders = "—";
      }

      // Win rate
      const winRateMatch = pageText.match(/Win rate[\s\S]{0,30}?([\d.]+)%/i);
      thisMonth.winRate = winRateMatch ? winRateMatch[1] + "%" : null;


      // ══════════════════════════════════════════════════════════════════
      // 2. COMBINED TOTAL
      // The "Combined total" tab on dforge shows the same gross markup.
      // We reuse the already-extracted value; if the page has a separate
      // "Combined total" section with its own dollar amount, grab that too.
      // ══════════════════════════════════════════════════════════════════
      const combined = {};
      const ctIdx = pageText.indexOf("Combined total");
      if (ctIdx !== -1) {
        const ctWindow = pageText.slice(ctIdx, ctIdx + 300);
        const amtMatch = ctWindow.match(/\$\s*([\d,.]+)/);
        combined.amount = amtMatch ? "$" + amtMatch[1] : thisMonth.grossMarkup;
      } else {
        // Fall back to gross markup — same value
        combined.amount = thisMonth.grossMarkup || "—";
      }

      // ══════════════════════════════════════════════════════════════════
      // 3. RECENT TRADES TABLE
      // ══════════════════════════════════════════════════════════════════
      const trades = [];
      // Find the table
      const table = document.querySelector("table");
      if (table) {
        // Get headers
        const headers = [...table.querySelectorAll("thead th, thead td")].map(
          (th) => th.textContent.trim().toLowerCase().replace(/\s+/g, "_")
        );

        // Get rows
        const rows = [...table.querySelectorAll("tbody tr")];
        for (const row of rows.slice(0, 50)) { // cap at 50 rows
          const cells = [...row.querySelectorAll("td")];
          const rowData = {};
          cells.forEach((td, i) => {
            rowData[headers[i] || `col_${i}`] = td.textContent.trim().replace(/\s+/g, " ");
          });
          if (Object.keys(rowData).length > 0) trades.push(rowData);
        }
      }

      return { thisMonth, combined, trades };
    });

    console.log("✅ Data extracted. Trades:", data.trades.length);
    return data;
  } finally {
    await browser.close();
    console.log("🧹 Browser closed.");
  }
}

// ─── API ────────────────────────────────────────────────────────────────────
app.get("/api/commissions", async (req, res) => {
  const now          = Date.now();
  const forceRefresh = req.query.refresh === "true";

  if (!forceRefresh && cache.data && cache.fetchedAt && now - cache.fetchedAt < CACHE_TTL_MS) {
    console.log("📦 Returning cached data.");
    return res.json({ success: true, cached: true, fetchedAt: new Date(cache.fetchedAt).toISOString(), ...cache.data });
  }

  try {
    const data = await scrapeDforgeCommissions();
    cache = { data, fetchedAt: Date.now() };
    return res.json({ success: true, cached: false, fetchedAt: new Date(cache.fetchedAt).toISOString(), ...data });
  } catch (err) {
    console.error("❌ Scraping error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🌐 Server → http://localhost:${PORT}`);
  console.log(`📡 API    → http://localhost:${PORT}/api/commissions\n`);
});

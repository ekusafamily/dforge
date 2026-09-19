const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const https = require("https");

// Auto-load .env in Node 20+
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch (e) {
  // If .env already loaded or not found, proceed
}

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Config ─────────────────────────────────────────────────────────────────
const DFORGE_EMAIL = process.env.DFORGE_EMAIL || "brianireri002@gmail.com";
const DFORGE_PASSWORD = process.env.DFORGE_PASSWORD || "Ilove.mumu047";
const DFORGE_LOGIN_URL = "https://dforge.site/login";
const DFORGE_TARGET_URL = "https://dforge.site/commissions";

// ─── Deduct Time Configuration ──────────────────────────────────────────────
// Cutoff time when the new deduction takes effect (Nairobi Time UTC+3).
// Existing today's data seen by client prior to this time remains untouched.
const deductTime = process.env.DEDUCT_TIME || "2026-09-20T00:00:00+03:00";
const deductTodayBaseline = parseFloat(process.env.DEDUCT_TODAY_BASELINE || "2.31");

// Customer credentials (strictly for customer dashboard)
const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "balktraders";

// Admin credentials (hidden from customer, required for /admin)
const ADMIN_USER = process.env.ADMIN_USER || "IRERI";
const ADMIN_PASS = process.env.ADMIN_PASS || "6946";

// Telegram Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || TELEGRAM_BOT_TOKEN.includes("your_telegram_bot_token")) {
    console.log("ℹ️ [Telegram Alert (Not Configured)]:\n" + message.replace(/<[^>]+>/g, ""));
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    const options = {
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log("✈️ Telegram alert sent successfully.");
          resolve(true);
        } else {
          console.error("⚠️ Telegram API returned status:", res.statusCode, data);
          resolve(false);
        }
      });
    });

    req.on("error", (err) => {
      console.error("⚠️ Telegram request error:", err.message);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

// ─── Withdrawal Persistence & Helpers ─────────────────────────────────────────
const WITHDRAWALS_FILE = path.join(__dirname, "withdrawals.json");

function getWithdrawalsList() {
  try {
    if (fs.existsSync(WITHDRAWALS_FILE)) {
      return JSON.parse(fs.readFileSync(WITHDRAWALS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Error reading withdrawals.json:", e.message);
  }
  return [];
}

function saveWithdrawalRecord(record) {
  try {
    const list = getWithdrawalsList();
    list.unshift(record);
    fs.writeFileSync(WITHDRAWALS_FILE, JSON.stringify(list, null, 2));
    return true;
  } catch (e) {
    console.error("Error saving withdrawal:", e.message);
    return false;
  }
}

function updateWithdrawalRecord(id, updates) {
  try {
    const list = getWithdrawalsList();
    const index = list.findIndex((item) => item.id === id);
    if (index === -1) return null;

    list[index] = { ...list[index], ...updates };
    fs.writeFileSync(WITHDRAWALS_FILE, JSON.stringify(list, null, 2));
    return list[index];
  } catch (e) {
    console.error("Error updating withdrawal:", e.message);
    return null;
  }
}

function deleteWithdrawalRecord(id) {
  try {
    const list = getWithdrawalsList();
    const filtered = list.filter((item) => item.id !== id);
    fs.writeFileSync(WITHDRAWALS_FILE, JSON.stringify(filtered, null, 2));
    return true;
  } catch (e) {
    console.error("Error deleting withdrawal:", e.message);
    return false;
  }
}

// Cache for 5 minutes
let cache = { data: null, fetchedAt: null };
const CACHE_TTL_MS = 5 * 60 * 1000;

function getLastMonthAvailableAmount() {
  if (cache.data?.periods?.lastMonth?.commission) {
    const num = parseFloat(cache.data.periods.lastMonth.commission.replace(/[^0-9.]/g, ""));
    if (!isNaN(num) && num > 0) return num;
  }
  return 44.42; // default fallback matching scraped Last Month
}

function getRemainingAvailableAmount() {
  const maxAllowed = getLastMonthAvailableAmount();
  const list = getWithdrawalsList();
  // Deduct amounts for pending, processing, or completed withdrawals
  const totalUsed = list
    .filter(w => w.status === "completed" || w.status === "processing" || w.status === "pending")
    .reduce((sum, w) => sum + (w.numericAmount || 0), 0);
  return Math.max(0, maxAllowed - totalUsed);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Route to serve Admin Panel
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ─── Authentication Helpers ────────────────────────────────────────────────
function parseCredentials(req) {
  const authHeader = req.headers.authorization || '';
  let credentials = '';
  if (authHeader.startsWith('Bearer ')) {
    credentials = authHeader.slice(7);
  } else if (authHeader.startsWith('Basic ')) {
    credentials = authHeader.slice(6);
  }
  if (!credentials) return [null, null];
  const parts = Buffer.from(credentials, 'base64').toString().split(':');
  return [parts[0] || null, parts[1] || null];
}

// Customer or Admin can access customer endpoints
function requireAuth(req, res, next) {
  const [login, password] = parseCredentials(req);

  const isCustomer = login === DASHBOARD_USER && password === DASHBOARD_PASS;
  const isAdmin = login === ADMIN_USER && password === ADMIN_PASS;

  if (isCustomer || isAdmin) {
    req.user = { role: isAdmin ? "admin" : "customer", username: login };
    return next();
  }

  return res.status(401).json({ success: false, error: "Authentication required" });
}

// Strict Admin-only middleware (Customer accounts are rejected!)
function requireAdminAuth(req, res, next) {
  const [login, password] = parseCredentials(req);

  if (login === ADMIN_USER && password === ADMIN_PASS) {
    req.user = { role: "admin", username: login };
    return next();
  }

  if (login === DASHBOARD_USER && password === DASHBOARD_PASS) {
    return res.status(403).json({ success: false, error: "Access denied. Admin account required." });
  }

  return res.status(401).json({ success: false, error: "Admin authentication required" });
}

// Customer Login route
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  // Allow customer login
  if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    sendTelegramNotification(
      `🔐 <b>Customer Login Success</b>\n` +
      `• <b>User:</b> <code>${username}</code>\n` +
      `• <b>Time:</b> ${new Date().toLocaleString()}\n` +
      `• <b>IP:</b> <code>${clientIp}</code>`
    );
    return res.json({ success: true, token, role: "customer" });
  }

  // Also accept admin if admin logs in via main portal
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    return res.json({ success: true, token, role: "admin" });
  }

  sendTelegramNotification(
    `🚨 <b>Failed Login Attempt</b>\n` +
    `• <b>User attempted:</b> <code>${username || "none"}</code>\n` +
    `• <b>Time:</b> ${new Date().toLocaleString()}\n` +
    `• <b>IP:</b> <code>${clientIp}</code>`
  );
  return res.status(401).json({ success: false, error: "Invalid username or password" });
});

// Dedicated Admin Login route (Only IRERI / 6946 allowed)
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    sendTelegramNotification(
      `🛡️ <b>Admin Portal Login Success</b>\n` +
      `• <b>Admin:</b> <code>${username}</code>\n` +
      `• <b>Time:</b> ${new Date().toLocaleString()}\n` +
      `• <b>IP:</b> <code>${clientIp}</code>`
    );
    return res.json({ success: true, token, role: "admin" });
  }

  sendTelegramNotification(
    `🚨 <b>Failed Admin Login Attempt</b>\n` +
    `• <b>Attempted user:</b> <code>${username || "none"}</code>\n` +
    `• <b>Time:</b> ${new Date().toLocaleString()}\n` +
    `• <b>IP:</b> <code>${clientIp}</code>`
  );
  return res.status(401).json({ success: false, error: "Invalid admin credentials" });
});

// ─── Scraper ───────────────────────────────────────────────────────────────
async function scrapeDforgeCommissions() {
  console.log("🚀 Launching Puppeteer...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // ── Login ────────────────────────────────────────────────────────────
    console.log("🔐 Logging in...");
    await page.goto(DFORGE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.type('input[type="email"]', DFORGE_EMAIL, { delay: 40 });
    await page.type('input[type="password"]', DFORGE_PASSWORD, { delay: 40 });

    await page.click('button[type="submit"]');
    await new Promise((r) => setTimeout(r, 4000));
    console.log("✅ Logged in →", page.url());

    // ── Navigate to commissions ──────────────────────────────────────────
    if (!page.url().includes("/commissions")) {
      await page.goto(DFORGE_TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
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

    // ── Extract targeted data per period ────────────────────────────────
    console.log("🔍 Extracting targeted data...");
    const data = await page.evaluate((deductTimeStr, todayBaselineNum) => {
      const deductTimestamp = new Date(deductTimeStr).getTime();
      const now = Date.now();
      const isPastDeductTime = now >= deductTimestamp;

      function calculateCommission(rawShareStr, isToday = false) {
        if (!rawShareStr || rawShareStr === "—") return "—";
        const num = parseFloat(String(rawShareStr).replace(/[^0-9.]/g, ""));
        if (isNaN(num)) return rawShareStr;

        // Today's commission is affected by deductTime:
        // Before deductTime: keep existing today's data the client has seen.
        // After deductTime: deduction begins on today's commission (97%).
        if (isToday) {
          if (!isPastDeductTime) {
            return "$" + num.toFixed(2);
          }
          return "$" + (num * 0.98).toFixed(2);
        }

        // This Month earnings:
        // Remains using up to $80 at 97%, then after deductTime the 10% deduction above $80 begins.
        let adjusted = num;
        if (num > 80) {
          if (isPastDeductTime) {
            // After deductTime: 10% deduction on portion above $80 begins
            adjusted = (80 * 0.98) + 0.90 * (num - 80);
          } else {
            // Before deductTime: remains using 97%
            adjusted = num * 0.98;
          }
        } else {
          // Up to $80: always 97%
          adjusted = num * 0.98;
        }

        return "$" + adjusted.toFixed(2);
      }

      function parseCardText(cardText, isHistorical = false, isToday = false) {
        if (!cardText) return null;
        const shareMatch = cardText.match(/Your share\s*\(\d+%\)[\s\S]*?\$([\d,.]+)/i);
        const tradeMatch = cardText.match(/([\d,]+)\s*trades?/i);
        const traderMatch = cardText.match(/([\d,]+)\s*traders?/i);

        const rawShare = shareMatch ? "$" + shareMatch[1] : "—";
        // Deductions apply to ongoing periods (thisMonth, today, yesterday). Historical completed periods (lastMonth) remain raw.
        const commission = isHistorical ? rawShare : calculateCommission(rawShare, isToday);

        return {
          commission,
          yourShare: commission, // backward compatibility
          trades: tradeMatch ? tradeMatch[1] : "—",
          traders: traderMatch ? traderMatch[1] : "—",
        };
      }

      const buttons = [...document.querySelectorAll("button, div[role='button']")];
      const findCard = (name) => {
        const btn = buttons.find(b => {
          const lines = b.innerText.trim().split("\n");
          return lines[0].trim().toLowerCase() === name.toLowerCase();
        });
        return btn ? btn.innerText : null;
      };

      const periods = {
        thisMonth: parseCardText(findCard("This Month"), false, false),
        lastMonth: parseCardText(findCard("Last Month"), true, false),
        today: parseCardText(findCard("Today"), false, true),
        yesterday: parseCardText(findCard("Yesterday"), false, false),
      };

      const pageText = document.body.innerText;
      const winRateMatch = pageText.match(/Win rate[\s\S]{0,30}?([\d.]+)%/i);
      const winRate = winRateMatch ? winRateMatch[1] + "%" : null;
      if (periods.thisMonth) {
        periods.thisMonth.winRate = winRate;
      }

      // Default fallback for thisMonth
      const thisMonth = periods.thisMonth || {
        commission: "—",
        yourShare: "—",
        trades: "—",
        traders: "—",
        winRate: winRate
      };

      // Combined total
      const combined = {
        amount: thisMonth.commission || "—"
      };

      // Determine this month raw amount to select appropriate trade deduction rate
      const thisMonthCardText = findCard("This Month");
      const thisMonthShareMatch = thisMonthCardText ? thisMonthCardText.match(/Your share\s*\(\d+%\)[\s\S]*?\$([\d,.]+)/i) : null;
      const thisMonthRaw = thisMonthShareMatch ? parseFloat(thisMonthShareMatch[1].replace(/,/g, "")) : 0;

      // Recent trades table
      const trades = [];
      const table = document.querySelector("table");
      if (table) {
        const headers = [...table.querySelectorAll("thead th, thead td")].map(
          (th) => th.textContent.trim().toLowerCase().replace(/\s+/g, "_")
        );

        const rows = [...table.querySelectorAll("tbody tr")];
        for (const row of rows.slice(0, 50)) { // cap at 50 rows
          const cells = [...row.querySelectorAll("td")];
          const rowData = {};
          let tradeBuyTimeStr = "";

          cells.forEach((td, i) => {
            const key = headers[i] || `col_${i}`;
            let val = td.textContent.trim().replace(/\s+/g, " ");
            if (key === "buy_time") {
              tradeBuyTimeStr = val;
            }
            rowData[key] = val;
          });

          // Check if this trade occurred on or after deductTime
          let isTradeAfterDeduct = false;
          if (tradeBuyTimeStr) {
            const year = new Date().getFullYear();
            // Format: "Sep 19, 11:17 AM" -> "Sep 19 2026 11:17 AM GMT+0300"
            const parsedTradeDate = new Date(tradeBuyTimeStr.replace(",", " " + year + ",") + " GMT+0300");
            if (!isNaN(parsedTradeDate.getTime())) {
              isTradeAfterDeduct = parsedTradeDate.getTime() >= deductTimestamp;
            }
          }

          cells.forEach((td, i) => {
            const key = headers[i] || `col_${i}`;
            let val = td.textContent.trim().replace(/\s+/g, " ");
            if (key === "gross_markup") {
              const num = parseFloat(val.replace(/[^0-9.]/g, ""));
              if (isNaN(num)) {
                rowData["commission"] = val;
              } else {
                const rawTradeCommission = num * 0.8;
                // Only affected by deductTime: before deductTime, keep existing trades as seen by client;
                // after deductTime, deduction begins!
                if (isPastDeductTime || isTradeAfterDeduct) {
                  const rate = thisMonthRaw > 80 ? 0.90 : 0.98;
                  rowData["commission"] = "$" + (rawTradeCommission * rate).toFixed(2);
                } else {
                  rowData["commission"] = "$" + rawTradeCommission.toFixed(2);
                }
              }
              delete rowData["gross_markup"];
            }
          });

          if (Object.keys(rowData).length > 0) trades.push(rowData);
        }
      }

      return { thisMonth, periods, combined, trades, winRate };
    }, deductTime, deductTodayBaseline);

    console.log("✅ Data extracted. Trades:", data.trades.length);
    return data;
  } finally {
    await browser.close();
    console.log("🧹 Browser closed.");
  }
}

// ─── API ────────────────────────────────────────────────────────────────────
app.get("/api/commissions", requireAuth, async (req, res) => {
  const now = Date.now();
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
    sendTelegramNotification(
      `⚠️ <b>Dashboard Scraping Error</b>\n` +
      `• <b>Error:</b> <code>${err.message}</code>\n` +
      `• <b>Time:</b> ${new Date().toLocaleString()}`
    );

    // Fall back to stale cache if available — keeps dashboard usable during upstream outages
    if (cache.data) {
      console.log("📦 Returning stale cached data (scrape failed).");
      return res.json({
        success: true,
        cached: true,
        stale: true,
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        ...cache.data
      });
    }

    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Withdrawal Routes ──────────────────────────────────────────────────────
app.post("/api/withdraw", requireAuth, (req, res) => {
  // ── Withdrawal window: 15th – 20th of each month only ──
  const today = new Date().getDate();
  if (today < 15 || today > 20) {
    return res.status(400).json({
      success: false,
      error: "Withdrawals are only available from the 15th to the 20th of each month."
    });
  }

  const { amount, address } = req.body || {};
  const numAmount = parseFloat(amount);
  const remainingAllowed = getRemainingAvailableAmount();

  // Validate Amount
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ success: false, error: "Please enter a valid withdrawal amount." });
  }
  if (numAmount > remainingAllowed) {
    return res.status(400).json({
      success: false,
      error: `Amount exceeds available Last Month income of $${remainingAllowed.toFixed(2)}.`
    });
  }

  // Validate USDT TRC20 Address: Starts with T, Base58, exactly 34 chars
  const trc20Regex = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
  const cleanAddress = (address || "").trim();
  if (!cleanAddress || !trc20Regex.test(cleanAddress)) {
    return res.status(400).json({
      success: false,
      error: "Invalid USDT TRC-20 address. It must start with 'T' and be exactly 34 characters long."
    });
  }

  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const withdrawal = {
    id: "WTH-" + Date.now().toString(36).toUpperCase(),
    amount: "$" + numAmount.toFixed(2),
    numericAmount: numAmount,
    address: cleanAddress,
    period: "Last Month",
    status: "pending", // Waiting for admin processing
    requestedAt: new Date().toISOString(),
    requestedAtFormatted: new Date().toLocaleString(),
    clientIp
  };

  saveWithdrawalRecord(withdrawal);

  // Notify Telegram Bot
  sendTelegramNotification(
    `💸 <b>New Withdrawal Request!</b>\n\n` +
    `• <b>Amount:</b> <b>$${numAmount.toFixed(2)} USDT</b>\n` +
    `• <b>Network:</b> TRON (TRC20)\n` +
    `• <b>Destination Address:</b>\n<code>${cleanAddress}</code>\n` +
    `• <b>Period:</b> Last Month ($${remainingAllowed.toFixed(2)} available)\n` +
    `• <b>Status:</b> Pending Admin Processing\n` +
    `• <b>Request ID:</b> <code>${withdrawal.id}</code>\n` +
    `• <b>Time:</b> ${withdrawal.requestedAtFormatted}\n` +
    `• <b>IP:</b> <code>${clientIp}</code>`
  );

  return res.json({
    success: true,
    message: "Withdrawal request received. Waiting for admin processing.",
    withdrawal
  });
});

app.get("/api/withdrawals/status", requireAuth, (req, res) => {
  const list = getWithdrawalsList();
  const originalMax = getLastMonthAvailableAmount();
  const remaining = getRemainingAvailableAmount();
  const activeWithdrawal = list.find(w => w.status === "pending" || w.status === "processing") || null;
  const latestWithdrawal = list.length > 0 ? list[0] : null;

  return res.json({
    success: true,
    availableToWithdraw: "$" + remaining.toFixed(2),
    maxNumeric: remaining,
    originalMax: "$" + originalMax.toFixed(2),
    originalNumeric: originalMax,
    activeWithdrawal,
    latestWithdrawal,
    history: list
  });
});

// ─── Admin Withdrawal Endpoints (Protected by requireAdminAuth) ───────────────
app.get("/api/admin/withdrawals", requireAdminAuth, (req, res) => {
  const list = getWithdrawalsList();
  const originalMax = getLastMonthAvailableAmount();
  const remaining = getRemainingAvailableAmount();

  const stats = {
    total: list.length,
    pending: list.filter(w => w.status === "pending").length,
    processing: list.filter(w => w.status === "processing").length,
    completed: list.filter(w => w.status === "completed").length,
    rejected: list.filter(w => w.status === "rejected").length,
    totalCompletedAmount: list
      .filter(w => w.status === "completed")
      .reduce((sum, w) => sum + (w.numericAmount || 0), 0),
    totalPendingAmount: list
      .filter(w => w.status === "pending" || w.status === "processing")
      .reduce((sum, w) => sum + (w.numericAmount || 0), 0),
    originalMax,
    remaining
  };

  return res.json({
    success: true,
    withdrawals: list,
    stats
  });
});

app.patch("/api/admin/withdrawals/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const { status, txHash, notes } = req.body || {};

  const validStatuses = ["pending", "processing", "completed", "rejected"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ success: false, error: "Invalid status value" });
  }

  const updates = { status };
  const now = new Date();

  if (status === "completed") {
    updates.completedAt = now.toISOString();
    updates.completedAtFormatted = now.toLocaleString();
    if (txHash) updates.txHash = txHash.trim();
    if (notes) updates.notes = notes.trim();
  } else if (status === "processing") {
    updates.processingStartedAt = now.toISOString();
    updates.processingStartedAtFormatted = now.toLocaleString();
    if (notes) updates.notes = notes.trim();
  } else if (status === "rejected") {
    updates.rejectedAt = now.toISOString();
    updates.rejectedAtFormatted = now.toLocaleString();
    updates.rejectionReason = (notes || "Declined by admin").trim();
    if (notes) updates.notes = notes.trim();
  }

  const updated = updateWithdrawalRecord(id, updates);
  if (!updated) {
    return res.status(404).json({ success: false, error: "Withdrawal not found" });
  }

  // Telegram Alert for Admin Actions
  if (status === "completed") {
    sendTelegramNotification(
      `✅ <b>Withdrawal Completed & Paid!</b>\n\n` +
      `• <b>Amount:</b> <b>${updated.amount} USDT</b>\n` +
      `• <b>Recipient:</b> <code>${updated.address}</code>\n` +
      `• <b>TxID (Tron):</b> <code>${updated.txHash || "None recorded"}</code>\n` +
      `• <b>Request ID:</b> <code>${updated.id}</code>\n` +
      `• <b>Completed At:</b> ${updated.completedAtFormatted}\n` +
      (updated.notes ? `• <b>Notes:</b> ${updated.notes}` : "")
    );
  } else if (status === "rejected") {
    sendTelegramNotification(
      `❌ <b>Withdrawal Request Rejected</b>\n\n` +
      `• <b>Amount:</b> <b>${updated.amount} USDT</b>\n` +
      `• <b>Request ID:</b> <code>${updated.id}</code>\n` +
      `• <b>Reason:</b> ${updated.rejectionReason || "Declined by admin"}`
    );
  }

  return res.json({ success: true, withdrawal: updated });
});

app.delete("/api/admin/withdrawals/:id", requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const ok = deleteWithdrawalRecord(id);
  return res.json({ success: ok });
});

app.listen(PORT, () => {
  console.log(`\n🌐 Server → http://localhost:${PORT}`);
  console.log(`📡 API    → http://localhost:${PORT}/api/commissions\n`);
});

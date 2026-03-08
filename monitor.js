const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Shared data directory (same as Jean's if possible) ───────────────────────
const DATA_DIR = process.env.DATA_DIR || "/tmp/jean-data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filename, fallback = {}) {
  try {
    const fp = path.join(DATA_DIR, filename);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {}
  return fallback;
}
function saveJSON(filename, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2)); } catch {}
}

// ─── State ────────────────────────────────────────────────────────────────────
// seenAlerts: tracks what we've already sent so we never duplicate
const seenAlerts = loadJSON("seen_alerts.json", {});
function markSeen(key) { seenAlerts[key] = Date.now(); saveJSON("seen_alerts.json", seenAlerts); }
function alreadySeen(key) {
  if (!seenAlerts[key]) return false;
  // Re-alert after 7 days even for same item
  return (Date.now() - seenAlerts[key]) < 7 * 24 * 60 * 60 * 1000;
}

// ─── Send alert to Jean via Jean's internal webhook ───────────────────────────
// Jean exposes a local HTTP endpoint that the monitor calls to trigger a message
async function sendAlertToJean(chatId, alertData) {
  const jeanUrl = process.env.JEAN_INTERNAL_URL;
  if (!jeanUrl) {
    console.log(`[Monitor] No JEAN_INTERNAL_URL set. Alert for ${chatId}:`, alertData.summary);
    return;
  }
  try {
    const res = await fetch(`${jeanUrl}/internal/alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-monitor-secret": process.env.MONITOR_SECRET || "jean-monitor-secret",
      },
      body: JSON.stringify({ chatId, alertData }),
    });
    if (!res.ok) console.error(`[Monitor] Jean webhook failed: ${res.status}`);
    else console.log(`[Monitor] Alert sent to Jean for chat ${chatId}`);
  } catch (err) {
    console.error("[Monitor] Failed to reach Jean:", err.message);
  }
}

// ─── Core monitor: search for a wine ─────────────────────────────────────────
async function searchWineMarket(wine, targetPrice, currency) {
  const prompt = `You are a wine market monitor agent. Search for current auction listings, recent hammer prices, and retail availability for: "${wine}"

Search for:
1. Any active auction lots RIGHT NOW (Sotheby's, Christie's, Hart Davis Hart, Zachys, Acker, iDealwine, WineBid)
2. Recent hammer prices from the last 30 days
3. Current retail prices from major merchants
4. Any upcoming auctions featuring this wine in the next 60 days

The user's target price is ${currency} ${targetPrice}.

Respond in this EXACT JSON format (no markdown, just raw JSON):
{
  "wine": "${wine}",
  "hasAlert": true or false,
  "alertReason": "why this is notable (empty if no alert)",
  "currentMarketPrice": "estimated current price or range",
  "targetPrice": "${currency} ${targetPrice}",
  "isNearTarget": true if current price within 15% of target,
  "isBelowTarget": true if available below target price,
  "activeAuctions": ["list of active lots found with house and estimate"],
  "recentHammerPrices": ["list of recent sales with price and date"],
  "upcomingAuctions": ["upcoming sales mentioning this wine"],
  "recommendation": "BUY / WATCH / PASS / HOLD",
  "summary": "2-3 sentence summary of market status"
}

Only set hasAlert=true if something is genuinely actionable: price below target, rare lot available, or significant price movement.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[Monitor] Search error for ${wine}:`, err.message);
    return null;
  }
}

// ─── Auction calendar monitor ─────────────────────────────────────────────────
async function checkAuctionCalendar() {
  const prompt = `Search for upcoming fine wine auctions in the next 30 days at major auction houses: Sotheby's, Christie's, Hart Davis Hart, Zachys, Acker Merrall & Condit, Bonhams, iDealwine, Wineauctioneer.

Find actual scheduled sales with dates and locations.

Respond in EXACT JSON format:
{
  "upcomingAuctions": [
    {
      "house": "auction house name",
      "saleName": "name of the sale",
      "date": "date of sale",
      "location": "city",
      "url": "if found",
      "highlights": "notable lots or regions featured"
    }
  ],
  "summary": "brief overview of upcoming auction activity"
}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("[Monitor] Auction calendar error:", err.message);
    return null;
  }
}

// ─── Market news monitor ──────────────────────────────────────────────────────
async function checkMarketNews() {
  const prompt = `Search for breaking fine wine market news from the last 48 hours. Look for:
- Major auction results or records broken
- New vintage releases or en primeur news  
- Significant producer news (acquisitions, winemaker changes)
- Market index movements (Liv-ex)
- New critic scores released (Parker, Wine Spectator, Jancis Robinson)

Respond in EXACT JSON format:
{
  "hasNews": true or false,
  "newsItems": [
    {
      "headline": "brief headline",
      "detail": "1-2 sentence summary",
      "relevance": "why this matters to wine investors/collectors",
      "source": "publication or source"
    }
  ],
  "summary": "overall market mood in one sentence"
}

Only include genuinely notable news. Max 3 items.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("[Monitor] News error:", err.message);
    return null;
  }
}

// ─── Main monitoring run ──────────────────────────────────────────────────────
async function runMonitorCycle() {
  console.log(`\n[${new Date().toISOString()}] Monitor cycle starting...`);

  const watchlists = loadJSON("watchlists.json");
  const memories   = loadJSON("memories.json");
  const alertUsers = loadJSON("alerts.json", []);

  // 1. Check market news (once per cycle, shared for all users)
  console.log("[Monitor] Checking market news...");
  const news = await checkMarketNews();

  // 2. Check auction calendar (once per cycle)
  console.log("[Monitor] Checking auction calendar...");
  const calendar = await checkAuctionCalendar();

  // 3. Check each user's watchlist
  for (const chatId of alertUsers) {
    const wl = watchlists[chatId] || [];
    const mem = memories[chatId] || {};
    const alerts = [];

    // Check news for this user
    if (news?.hasNews && news.newsItems?.length > 0) {
      const newsKey = `news_${chatId}_${news.newsItems[0]?.headline?.slice(0,30)}`;
      if (!alreadySeen(newsKey)) {
        alerts.push({ type: "news", data: news });
        markSeen(newsKey);
      }
    }

    // Check auction calendar
    if (calendar?.upcomingAuctions?.length > 0) {
      const calKey = `calendar_${chatId}_${calendar.upcomingAuctions[0]?.date}`;
      if (!alreadySeen(calKey)) {
        alerts.push({ type: "calendar", data: calendar });
        markSeen(calKey);
      }
    }

    // Check each watchlist wine
    for (const item of wl) {
      console.log(`[Monitor] Checking: ${item.wine} for user ${chatId}`);
      const result = await searchWineMarket(item.wine, item.targetPrice, item.currency);

      if (result?.hasAlert) {
        const alertKey = `wine_${chatId}_${item.wine}_${result.recommendation}_${Math.floor(Date.now()/3600000)}`;
        if (!alreadySeen(alertKey)) {
          alerts.push({ type: "watchlist", wine: item.wine, data: result });
          markSeen(alertKey);
        }
      }

      // Rate limit: wait 2s between searches
      await new Promise(r => setTimeout(r, 2000));
    }

    // Send consolidated alert to Jean if anything found
    if (alerts.length > 0) {
      await sendAlertToJean(String(chatId), {
        alerts,
        userProfile: mem.notes || "Wine enthusiast",
        summary: `${alerts.length} alert(s) found: ${alerts.map(a => a.type).join(", ")}`,
      });
    }
  }

  console.log(`[Monitor] Cycle complete. Processed ${alertUsers.length} users.`);
}

// ─── Schedule ─────────────────────────────────────────────────────────────────
// Every 30 minutes
cron.schedule("*/30 * * * *", () => {
  runMonitorCycle().catch(err => console.error("[Monitor] Cycle error:", err));
});

// Also run once on startup after 10 seconds
setTimeout(() => {
  runMonitorCycle().catch(err => console.error("[Monitor] Startup error:", err));
}, 10000);

console.log("🔍 Wine Monitor Agent running — checking every 30 minutes.");

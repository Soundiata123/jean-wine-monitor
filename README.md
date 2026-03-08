# 🔍 Wine Monitor Agent

Background agent that runs 24/7, monitors auctions and market news, and sends alerts to Jean Le Sommelier who forwards them to you.

## What it does every 30 minutes:
- Searches active auction lots for every wine on your watchlist
- Checks recent hammer prices vs your target prices
- Scans for breaking wine market news
- Checks upcoming auction calendars
- Sends findings to Jean → Jean formats and messages you

## Setup on Railway (separate service)

### Step 1 — Create new Railway service
1. Go to railway.app → your existing project
2. Click **+ New Service → GitHub Repo**
3. Create a NEW GitHub repo called `jean-wine-monitor`
4. Upload: `monitor.js` and `package.json`
5. Select the new repo in Railway

### Step 2 — Add Variables to Monitor service
```
ANTHROPIC_API_KEY=same key as Jean's
MONITOR_SECRET=jean-monitor-secret
JEAN_INTERNAL_URL=https://[jean-service-url].railway.app
DATA_DIR=/tmp/jean-data
```

### Step 3 — Add Variables to Jean service
```
MONITOR_SECRET=jean-monitor-secret
INTERNAL_PORT=3001
```

### Step 4 — Get Jean's internal URL
1. In Railway → Jean service → Settings → Networking
2. Copy the public domain (e.g. jean-le-sommelier.railway.app)
3. Paste as JEAN_INTERNAL_URL in the Monitor's variables

### Step 5 — Deploy both
Railway auto-deploys when you push. Both services run independently.

## Alert flow
```
Monitor searches web every 30min
  → Finds actionable intel
  → POST /internal/alert to Jean
  → Jean formats it beautifully
  → Jean sends you a Telegram message
```

## Cost
Both services run on Railway free tier ($5 credit/month total).

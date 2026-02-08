# Meme Coin Twitter Scanner

Monitor OKX Meme Pump new coins (SOL & BSC chains), automatically verify if each coin's linked Twitter account has posted the contract address. When a match is found, push real-time alerts to an HTML dashboard.

## How It Works

```
OKX Meme Pump Page (Puppeteer)
  -> Detect new coins (contract address + Twitter handle)
  -> Fetch Twitter user's recent 5 tweets
  -> Check if any tweet contains the contract address
  -> If match: push notification to HTML dashboard via WebSocket
```

## Prerequisites

- **Node.js 18+** (https://nodejs.org)
- **A Twitter/X burner account** (NOT your main account - risk of ban)

## Setup

### 1. Install dependencies

```bash
cd meme-twitter-scanner
npm install
```

This will automatically download Chromium (~170MB) for Puppeteer.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your Twitter burner account credentials:

```
TWITTER_USERNAME=your_burner_username
TWITTER_PASSWORD=your_burner_password
TWITTER_EMAIL=your_burner_email
```

### 3. Run

```bash
npm start
```

Then open http://localhost:3000 in your browser.

## Configuration Options (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `TWITTER_USERNAME` | - | Twitter burner account username |
| `TWITTER_PASSWORD` | - | Twitter burner account password |
| `TWITTER_EMAIL` | - | Twitter burner account email |
| `PORT` | 3000 | Web server port |
| `TWITTER_CHECK_INTERVAL` | 1000 | Milliseconds between Twitter requests (1s) |
| `MAX_TWEETS_PER_USER` | 5 | Number of recent tweets to check per user |
| `CACHE_TTL_MINUTES` | 30 | Skip re-checking same Twitter within this window |
| `OKX_SCAN_INTERVAL` | 5000 | Milliseconds between OKX page scans |
| `MONITOR_CHAINS` | sol,bsc | Chains to monitor (comma separated) |

## Architecture

```
src/
  index.js              # Main entry - wires everything together
  server.js             # Express HTTP + WebSocket server
  monitors/
    okx-scraper.js      # Puppeteer: scrapes OKX Meme Pump page
                        #   - Network interception (captures internal API data)
                        #   - WebSocket message capture
                        #   - DOM scraping (fallback)
  twitter/
    checker.js          # Twitter verification with rate limiting
                        #   - Cookie caching (avoids repeated login)
                        #   - Auto rate-limit detection + pause
                        #   - Result caching (30min dedup)
  utils/
    cache.js            # Simple TTL cache
    logger.js           # Colored console logger
public/
  index.html            # Dashboard with real-time WebSocket updates
```

## Twitter Safety

The tool uses these measures to protect your burner account:

- **1 request/second** rate (configurable)
- **Cookie caching** - login once, reuse session
- **429 auto-pause** - pauses 15 minutes on rate limit
- **3-error backoff** - pauses 2 minutes after 3 consecutive errors
- **30-minute result cache** - won't re-check same account

**IMPORTANT:**
- Use a dedicated burner account, NOT your personal account
- Do NOT run on cloud servers (AWS/GCP/Azure IPs are flagged)
- Run on your local computer only

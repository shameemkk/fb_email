# FB Email Scraper API

Fast Express.js API with Playwright to extract emails from Facebook pages.

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

Start the API server:
```bash
npm start
```

The server runs on `http://localhost:3000`

**API Endpoints:**
- `GET /` - API information
- `GET /health` - Health check
- `POST /scrape` - Scrape email from a Facebook URL

**Example API call:**
```bash
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.facebook.com/name"}'
```



## Project Structure

```
fb_email/
├── scrape.js                      # Express API server
├── package.json                   # Node dependencies
└── README.md                      # This file
```

## How It Works

The scraper uses Playwright to:
1. Launch a headless Chromium browser
2. Navigate to the Facebook page
3. Wait for dynamic content to load
4. Search for email addresses in `<span>` elements containing '@'
5. Fall back to regex search if no span elements found
6. Block heavy assets (images, media, fonts) for speed

## Performance

Playwright is significantly faster than traditional scrapers because:
- Modern async/await architecture
- Parallel operations
- Intelligent asset blocking
- No full browser overhead (headless mode)

Typical run time: **2-4 seconds**.

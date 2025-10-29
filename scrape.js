import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 3000;

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// User agents pool for rotation
const USER_AGENTS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
];

function getRandomUserAgent() {
	return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function scrapeEmail(url) {
	const browser = await chromium.launch({
		headless: true,
		args: [
			"--disable-blink-features=AutomationControlled",
			"--no-sandbox",
			"--disable-dev-shm-usage",
		],
	});

	const randomUserAgent = getRandomUserAgent();
	console.log(`Using User-Agent: ${randomUserAgent}`);
	
	const context = await browser.newContext({
		userAgent: randomUserAgent,
		locale: "en-US",
	});

	// Speed optimization: block heavy assets
	await context.route("**/*", (route) => {
		if (["image", "media", "font"].includes(route.request().resourceType())) {
			route.abort();
		} else {
			route.continue();
		}
	});

	const page = await context.newPage();
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.waitForTimeout(1500);

	const emails = new Set();

	// Strategy 1: Find all spans containing '@' symbol
	const spans = await page.locator("//span[contains(text(), '@')]").all();
	for (const span of spans) {
		const text = (await span.textContent()).trim();
		if (EMAIL_REGEX.test(text)) {
			emails.add(text);
		}
	}

	// Strategy 2: Fallback regex search on entire HTML
	if (emails.size === 0) {
		const html = await page.content();
		const match = html.match(EMAIL_REGEX);
		if (match) {
			emails.add(match[0]);
		}
	}

	await context.close();
	await browser.close();

	return emails;
}

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get('/', (req, res) => {
	res.json({
		message: 'Facebook Email Scraper API',
		endpoints: {
			'GET /': 'API info',
			'POST /scrape': 'Scrape email from a Facebook URL body should contain url',
			'GET /health': 'Health check'
		}
	});
});

app.get('/health', (req, res) => {
	res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/scrape', async (req, res) => {
	try {
		const { url } = req.body;
		
		if (!url) {
			return res.status(400).json({ error: 'URL is required' });
		}
		
		console.log(`Scraping: ${url}`);
		const emails = await scrapeEmail(url);
		
		if (emails.size > 0) {
			res.json({
				success: true,
				emails: Array.from(emails),
				url
			});
		} else {
			res.json({
				success: false,
				email: null,
				message: 'No email found',
				url
			});
		}
	} catch (error) {
		console.error('Scraping error:', error);
		res.status(500).json({
			error: 'Failed to scrape email',
			message: error.message
		});
	}
});

// Start server
app.listen(PORT, () => {
	console.log(`🚀 Server running on http://localhost:${PORT}`);
});


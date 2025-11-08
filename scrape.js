import express from 'express';
import cors from 'cors';
import cluster from 'cluster';
import os from 'os';
import { chromium } from 'playwright';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config({quiet:true});

const PORT = parseInt(process.env.PORT) || 3000;
const NUM_WORKERS = parseInt(process.env.NUM_WORKERS) || os.cpus().length;
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 10000;
const QUEUE_MAX_SIZE = parseInt(process.env.QUEUE_MAX_SIZE) || 50000;

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

// Request Queue for managing high concurrency
class RequestQueue {
	constructor(maxConcurrent = 100, maxSize = 1000) {
		this.maxConcurrent = maxConcurrent;
		this.maxSize = maxSize;
		this.queue = [];
		this.active = 0;
		this.processing = false;
	}

	async enqueue(task) {
		return new Promise((resolve, reject) => {
			if (this.queue.length >= this.maxSize) {
				reject(new Error('Queue is full'));
				return;
			}

			this.queue.push({ task, resolve, reject });
			this.process();
		});
	}

	async process() {
		if (this.processing || this.active >= this.maxConcurrent || this.queue.length === 0) {
			return;
		}

		this.processing = true;

		while (this.active < this.maxConcurrent && this.queue.length > 0) {
			const { task, resolve, reject } = this.queue.shift();
			this.active++;

			task()
				.then(resolve)
				.catch(reject)
				.finally(() => {
					this.active--;
					this.process();
				});
		}

		this.processing = false;
	}

	getStats() {
		return {
			queueLength: this.queue.length,
			active: this.active,
			maxConcurrent: this.maxConcurrent,
			maxSize: this.maxSize
		};
	}
}

// Browser Pool for connection reuse
class BrowserPool {
	constructor(maxBrowsers = 10) {
		this.maxBrowsers = maxBrowsers;
		this.browsers = [];
		this.available = [];
		this.initializing = false;
	}

	async getBrowser() {
		if (this.available.length > 0) {
			return this.available.shift();
		}

		if (this.browsers.length < this.maxBrowsers) {
			return await this.createBrowser();
		}

		// Wait for an available browser
		return new Promise((resolve) => {
			const checkInterval = setInterval(() => {
				if (this.available.length > 0) {
					clearInterval(checkInterval);
					resolve(this.available.shift());
				}
			}, 100);
		});
	}

	async createBrowser() {
		const browser = await chromium.launch({
			headless: true,
			args: [
				"--disable-blink-features=AutomationControlled",
				"--no-sandbox",
				"--disable-dev-shm-usage",
			],
		});

		this.browsers.push(browser);
		// Don't add to available - it will be used immediately
		return browser;
	}

	releaseBrowser(browser) {
		if (this.browsers.includes(browser) && !this.available.includes(browser)) {
			this.available.push(browser);
		}
	}

	async closeAll() {
		await Promise.all(this.browsers.map(browser => browser.close()));
		this.browsers = [];
		this.available = [];
	}
}

async function scrapeEmail(url, browserPool) {
	let browser;
	let context;
	
	try {
		browser = await browserPool.getBrowser();
		const randomUserAgent = getRandomUserAgent();
		
		context = await browser.newContext({
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
		browserPool.releaseBrowser(browser);

		return emails;
	} catch (error) {
		if (context) {
			try {
				await context.close();
			} catch (e) {
				// Ignore cleanup errors
			}
		}
		if (browser) {
			browserPool.releaseBrowser(browser);
		}
		throw error;
	}
}

// Worker process setup
function setupWorker() {
	const app = express();
	
	// Calculate per-worker limits
	const perWorkerConcurrent = Math.ceil(MAX_CONCURRENT_REQUESTS / NUM_WORKERS);
	const perWorkerQueueSize = Math.ceil(QUEUE_MAX_SIZE / NUM_WORKERS);
	const maxBrowsersPerWorker = Math.max(5, Math.ceil(10 / NUM_WORKERS));
	
	// Initialize queue and browser pool for this worker
	const requestQueue = new RequestQueue(perWorkerConcurrent, perWorkerQueueSize);
	const browserPool = new BrowserPool(maxBrowsersPerWorker);

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
				'GET /health': 'Health check',
				'GET /stats': 'Queue and worker statistics'
			},
			worker: {
				id: cluster.worker.id,
				pid: process.pid
			}
		});
	});

	app.get('/health', (req, res) => {
		res.json({ 
			status: 'ok', 
			timestamp: new Date().toISOString(),
			worker: {
				id: cluster.worker.id,
				pid: process.pid
			}
		});
	});

	app.get('/stats', (req, res) => {
		res.json({
			worker: {
				id: cluster.worker.id,
				pid: process.pid
			},
			queue: requestQueue.getStats(),
			browserPool: {
				total: browserPool.browsers.length,
				available: browserPool.available.length,
				max: browserPool.maxBrowsers
			}
		});
	});

	app.post('/scrape', async (req, res) => {
		try {
			const { url } = req.body;
			
			if (!url) {
				return res.status(400).json({ error: 'URL is required' });
			}
			
			// Enqueue the scraping task
			const emails = await requestQueue.enqueue(() => scrapeEmail(url, browserPool));
			
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
			console.error(`[Worker ${cluster.worker.id}] Scraping error:`, error);
			res.status(500).json({
				error: 'Failed to scrape email',
				message: error.message,
				worker: cluster.worker.id
			});
		}
	});

	// Start server
	const server = app.listen(PORT, () => {
		console.log(`🚀 Worker ${cluster.worker.id} (PID: ${process.pid}) running on http://localhost:${PORT}`);
	});

	// Graceful shutdown
	process.on('SIGTERM', async () => {
		console.log(`Worker ${cluster.worker.id} received SIGTERM, closing server...`);
		server.close(async () => {
			await browserPool.closeAll();
			process.exit(0);
		});
	});

	return { app, requestQueue, browserPool };
}

// Cluster master setup
if (cluster.isPrimary) {
	console.log(`📦 Master process (PID: ${process.pid}) starting ${NUM_WORKERS} workers...`);
	console.log(`⚙️  Configuration:`);
	console.log(`   - Workers: ${NUM_WORKERS}`);
	console.log(`   - Max Concurrent Requests: ${MAX_CONCURRENT_REQUESTS}`);
	console.log(`   - Queue Max Size: ${QUEUE_MAX_SIZE}`);
	console.log(`   - Per Worker Concurrent: ${Math.ceil(MAX_CONCURRENT_REQUESTS / NUM_WORKERS)}`);
	console.log(`   - Port: ${PORT}`);

	// Fork workers
	for (let i = 0; i < NUM_WORKERS; i++) {
		const worker = cluster.fork();
		console.log(`   ✓ Worker ${i + 1} started (PID: ${worker.process.pid})`);
	}

	// Handle worker exit
	cluster.on('exit', (worker, code, signal) => {
		console.log(`⚠️  Worker ${worker.id} (PID: ${worker.process.pid}) died. Code: ${code}, Signal: ${signal}`);
		console.log(`🔄 Starting a new worker...`);
		const newWorker = cluster.fork();
		console.log(`   ✓ New worker started (PID: ${newWorker.process.pid})`);
	});

	// Handle worker online
	cluster.on('online', (worker) => {
		console.log(`✅ Worker ${worker.id} (PID: ${worker.process.pid}) is online`);
	});

	// Graceful shutdown
	process.on('SIGTERM', () => {
		console.log('Master received SIGTERM, shutting down workers...');
		for (const id in cluster.workers) {
			cluster.workers[id].kill();
		}
	});

	process.on('SIGINT', () => {
		console.log('Master received SIGINT, shutting down workers...');
		for (const id in cluster.workers) {
			cluster.workers[id].kill();
		}
	});
} else {
	// Worker process
	setupWorker();
}


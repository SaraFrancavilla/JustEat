import { readFileSync } from 'fs';
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env manually
try {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const envPath = join(__dirname, '..', '.env');
	const envContent = readFileSync(envPath, 'utf8');
	envContent.split('\n').forEach(line => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) return;
		const [key, ...valueParts] = trimmed.split('=');
		const value = valueParts.join('=').replace(/^['"]|['"]$/g, '');
		if (key && !process.env[key]) {
			process.env[key] = value;
			console.log(`[ENV] Set ${key} = ${value}`);
		}
	});
	console.log('[ENV] Loaded .env configuration');
} catch (err) {
	console.log('[ENV] Warning:', err.message);
}

async function askToken() {
	if (process.env.DELIVEROO_TOKEN?.trim()) {
        console.log("Using token from environment variable.");
    return;
    }

	const rl = createInterface({ input, output });
	try {
		const token = (await rl.question("Insert your Deliveroo token: ")).trim();
		if (token) {
			process.env.DELIVEROO_TOKEN = token;
		}
	} finally {
		rl.close();
	}
}

console.log("Welcome to the Deliveroo Agent!");
await askToken();

const { CFG } = await import("./config.js");
await import("./world/events.js");
const { tick } = await import("./mainLoop.js");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runLoop() {
	while (true) {
		await tick();
		await sleep(CFG.TICK_RATE_MS);
	}
}

runLoop().catch(err => {
	console.error('[LOOP] Fatal error:', err);
	process.exitCode = 1;
});

console.log("Deliveroo Agent is ready!");
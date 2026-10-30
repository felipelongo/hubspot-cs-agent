import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.CONSOLE_URL || 'http://localhost:8787';
const out = 'docs/demo/screenshots';
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(`${base}/login`);
await page.screenshot({ path: `${out}/01-login.png`, fullPage: true });
await page.fill('input[name="password"]', 'demo');
await page.click('button');
await page.waitForURL(`${base}/`);
await page.screenshot({ path: `${out}/02-queue.png`, fullPage: true });

const proposal = page.locator('a[href^="/proposals/"]').first();
const proposalHref = await proposal.getAttribute('href');
if (!proposalHref) throw new Error('Queue has no proposal link');
await proposal.click();
await page.waitForURL(/\/proposals\//);
await page.screenshot({ path: `${out}/03-proposal.png`, fullPage: true });
const body = await page.locator('main').innerText();
if (!body.includes('action_hash') && !/^[a-f0-9]{64}$/m.test(body) && !body.toLowerCase().includes('hash')) {
  throw new Error('Proposal page does not show a hash');
}

await page.goto(`${base}/runs`);
await page.screenshot({ path: `${out}/04-runs.png`, fullPage: true });
const run = page.locator('a[href^="/runs/"]').first();
if (await run.count()) {
  await run.click();
  await page.screenshot({ path: `${out}/05-run.png`, fullPage: true });
}

await page.goto(`${base}/audit`);
await page.screenshot({ path: `${out}/06-audit.png`, fullPage: true });
await page.goto(`${base}/metrics`);
await page.screenshot({ path: `${out}/07-metrics.png`, fullPage: true });
if (!(await page.locator('main').innerText()).includes('25 minutes')) {
  throw new Error('Metrics page is missing the hours-saved assumption');
}

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/`);
await page.screenshot({ path: `${out}/08-queue-mobile.png`, fullPage: true });

await browser.close();
console.log(`Saved screenshots to ${out}. Opened ${proposalHref}.`);

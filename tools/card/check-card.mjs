import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

// All personal values are read in memory from the supplied HTML. No captures,
// downloaded vCards, decoded QR payloads or browser traces are persisted.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--root') {
  console.error('Usage: node tools/card/check-card.mjs --root <card-directory>');
  process.exit(1);
}
const root = await realpath(resolve(args[1]));
const utf8 = new TextDecoder('utf-8', { fatal: true });
const files = new Set(['index.html', 'style.css', 'app.js', 'qr.js']);
const textual = new Set(['.html', '.css', '.js', '.svg', '.txt']);
const assetTypes = new Set(['.svg', '.png', '.woff', '.txt']);
const results = [];
let server;
let browser;

async function check(name, action) {
  try {
    await action();
    results.push({ name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    // Assertion payloads can contain actual contact details; omit them from logs.
    results.push({ name, status: 'FAIL' });
    console.error(`FAIL ${name} (${error.name})`);
  }
}

async function assetFiles(dir = 'assets') {
  for (const item of await readdir(resolve(root, dir), { withFileTypes: true })) {
    assert(!item.isSymbolicLink(), 'Asset symlinks are forbidden');
    const name = `${dir}/${item.name}`;
    if (item.isDirectory()) await assetFiles(name);
    else {
      assert(item.isFile() && assetTypes.has(extname(name)), 'Unexpected asset type');
      files.add(name);
    }
  }
}

async function internalReference(value, base) {
  if (!value || value.startsWith('#')) return;
  assert(!/^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(value), 'Only relative resources are allowed');
  const pathname = decodeURIComponent(value.split(/[?#]/)[0]);
  const target = resolve(dirname(resolve(root, base)), pathname);
  assert(target.startsWith(root + sep), 'Reference leaves root');
  const name = relative(root, target).split(sep).join('/');
  assert(files.has(name), 'Reference outside published resource whitelist');
  assert((await stat(target)).isFile(), 'Resource does not exist');
}

const unescapeVcard = value => value.replace(/\\([nN,;\\])/g, (_, c) => /n/i.test(c) ? '\n' : c);
function vcardFields(value) {
  assert(value.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'));
  assert(value.endsWith('END:VCARD\r\n'));
  assert(!/(?<!\r)\n/.test(value));
  const map = new Map();
  for (const line of value.split('\r\n').filter(Boolean)) {
    const index = line.indexOf(':');
    assert(index > 0);
    const key = line.slice(0, index).split(';')[0].toUpperCase();
    const values = map.get(key) || [];
    values.push(line.slice(index + 1));
    map.set(key, values);
  }
  return map;
}

async function decodedQr(page) {
  // The successful-download toast can overlap the QR near the viewport edge.
  // Wait for the observable confirmation to close before assessing scannability.
  await page.waitForFunction(() => !document.querySelector('.toast')?.classList.contains('is-visible'));
  const png = PNG.sync.read(await page.locator('.qr-code svg').screenshot({ animations: 'disabled' }));
  assert(png.width <= 4096 && png.height <= 4096);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'dontInvert' });
  if (!decoded) {
    const error = new Error('Rendered QR must decode independently');
    error.name = 'QRPixelDecodeError';
    throw error;
  }
  return decoded.data;
}

try {
  await check('UTF-8, resource whitelist, relative links and script syntax', async () => {
    await assetFiles();
    for (const name of files) {
      const target = await realpath(resolve(root, name));
      assert(target.startsWith(root + sep));
      const bytes = await readFile(target);
      assert(bytes.length < 2_000_000, 'Resource size budget exceeded');
      if (!textual.has(extname(name))) continue;
      const source = utf8.decode(bytes);
      assert(!source.includes('\uFFFD'), 'Replacement character in source');
      if (extname(name) === '.js') assert.equal(spawnSync(process.execPath, ['--check', target], { stdio: 'ignore' }).status, 0);
      if (extname(name) === '.css') {
        assert(!/@import\b/i.test(source), 'Stylesheet imports are not inventoried');
        for (const match of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) await internalReference(match[1], name);
      }
      if (extname(name) === '.html') {
        assert(!/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(source), 'Inline script forbidden');
        for (const match of source.matchAll(/\b(?:src|poster)\s*=\s*["']([^"']+)["']/gi)) await internalReference(match[1], name);
      }
      if (extname(name) === '.svg') assert(!/<script\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:|\/\/)/i.test(source), 'Active or remote SVG content');
    }
  });
  assert(!results.some(r => r.status === 'FAIL'), 'Static validation failed');

  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      // Deliberately mount below a prefix to exercise GitHub Pages relative paths.
      assert(pathname.startsWith('/card/'));
      const name = pathname.slice('/card/'.length) || 'index.html';
      assert(files.has(name));
      const body = await readFile(resolve(root, name));
      response.writeHead(200, { 'Content-Type': mime[extname(name)], 'Cache-Control': 'no-store' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/card/`;
  browser = await chromium.launch({ headless: true, ...(process.env.CARD_BROWSER_EXECUTABLE ? { executablePath: process.env.CARD_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors = [];
  const responses = [];
  page.on('pageerror', () => errors.push('javascript'));
  page.on('requestfailed', () => errors.push('request'));
  page.on('response', response => { if (response.status() >= 400) responses.push(response.status()); });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.__cardCsp = [];
    document.addEventListener('securitypolicyviolation', event => window.__cardCsp.push(event.effectiveDirective));
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const person = await page.evaluate(() => {
    const text = name => document.querySelector(`[data-field="${name}"]`)?.textContent.trim() || '';
    const href = name => document.querySelector(`[data-field="${name}"]`)?.getAttribute('href') || '';
    const address = document.querySelector('[data-field="address"]');
    return { fullName: ['given', 'additional', 'family'].map(text).filter(Boolean).join(' '), given: text('given'), family: text('family'), additional: text('additional'), org: text('org'), title: text('title'), telephone: decodeURIComponent(href('tel').slice(4)).replace(/\s/g, ''), email: decodeURIComponent(href('email').slice(7)).split('?')[0], emailText: document.querySelector('[data-field="email"] strong')?.textContent.trim() || '', canonical: document.querySelector('#carte').dataset.cardUrl, website: document.querySelector('#carte').dataset.website, locality: address?.dataset.locality || '', country: address?.dataset.country || '' };
  });

  await check('HTML contact, unique email, metadata, CSP and allowed links', async () => {
    assert.equal(await page.locator('[data-field="email"]').count(), 1);
    assert.equal(await page.locator('a[href^="mailto:"]').count(), 1);
    assert.equal(person.email, person.emailText);
    assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email));
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), person.canonical);
    assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), person.canonical);
    assert.equal(new URL(person.canonical).protocol, 'https:');
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert(policy.split(';').map(s => s.trim()).includes(directive));
    assert(!/unsafe-inline|unsafe-eval/.test(policy));
    assert.equal(await page.locator('meta[name="referrer"]').getAttribute('content'), 'no-referrer');
    const allowedHosts = new Set(['wa.me', new URL(person.canonical).hostname]);
    if (person.website) allowedHosts.add(new URL(person.website).hostname);
    const links = await page.locator('[href]').evaluateAll(nodes => nodes.map(n => ({ href: n.getAttribute('href'), stylesheet: n.matches('link[rel="stylesheet"]') })));
    for (const link of links) {
      if (link.stylesheet) await internalReference(link.href, 'index.html');
      else if (/^https:/i.test(link.href)) assert(allowedHosts.has(new URL(link.href).hostname));
      else assert(/^(?:tel:|mailto:|#)/.test(link.href), 'Unexpected link scheme');
    }
    assert.equal(await page.locator('[data-field="whatsapp"]').getAttribute('href'), `https://wa.me/${person.telephone.replace(/\D/g, '')}`);
  });

  let vcard;
  await check('real vCard download and structured contact fields including email', async () => {
    const pending = page.waitForEvent('download');
    await page.locator('[data-action="save"]').click();
    const download = await pending;
    assert(download.suggestedFilename().endsWith('.vcf'));
    assert.equal(await download.failure(), null);
    vcard = utf8.decode(await readFile(await download.path()));
    const fields = vcardFields(vcard);
    for (const key of ['N', 'FN', 'ORG', 'TITLE', 'TEL', 'EMAIL']) assert.equal(fields.get(key)?.length, 1);
    assert.equal(unescapeVcard(fields.get('FN')[0]), person.fullName);
    assert.equal(unescapeVcard(fields.get('ORG')[0]), person.org);
    assert.equal(unescapeVcard(fields.get('TITLE')[0]), person.title);
    assert.equal(fields.get('TEL')[0], person.telephone);
    assert.equal(fields.get('EMAIL')[0], person.email);
    assert.deepEqual(fields.get('N')[0].split(/(?<!\\);/).map(unescapeVcard), [person.family, person.given, person.additional, '', '']);
    assert(!fields.has('URL') || fields.get('URL')[0] === person.website);
  });
  await check('independent decoding of rendered contact QR code', async () => {
    assert(vcard);
    assert.equal(await decodedQr(page), vcard);
  });
  await check('independent decoding of rendered link QR code', async () => {
    await page.locator('[data-qr-mode="link"]').click();
    assert.equal(await page.locator('[data-qr-mode="link"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await decodedQr(page), person.canonical);
  });

  await check('mobile and desktop fit, images, fonts and reduced motion', async () => {
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(100);
      const layout = await page.evaluate(() => {
        const rect = document.querySelector('.card').getBoundingClientRect();
        return { width: innerWidth, scroll: document.documentElement.scrollWidth, left: rect.left, right: rect.right, images: [...document.images].every(i => i.complete && i.naturalWidth > 0), fonts: document.fonts.check('600 17px Manrope') && document.fonts.check('400 17px "Source Sans 3"'), animations: document.getAnimations().filter(a => a.playState === 'running').length, transform: getComputedStyle(document.querySelector('.card')).transform };
      });
      assert(layout.scroll <= width && layout.left >= 0 && layout.right <= width);
      assert(layout.images && layout.fonts);
      assert.equal(layout.animations, 0);
      assert.equal(layout.transform, 'none');
    }
  });
  await check('normal load has no JavaScript, resource or CSP error', async () => {
    assert.equal(errors.length + responses.length, 0);
    assert.deepEqual(await page.evaluate(() => window.__cardCsp), []);
  });
  await context.close();

  await check('without JavaScript contact links remain usable', async () => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 812 } });
    try {
      const fallback = await ctx.newPage();
      await fallback.goto(url);
      for (const field of ['tel', 'email', 'whatsapp']) assert(await fallback.locator(`[data-field="${field}"]`).isVisible());
      assert(!(await fallback.locator('.card-actions').isVisible()));
      assert(!(await fallback.locator('.qr-block').isVisible()));
      assert.equal(await fallback.locator('[data-field="email"]').getAttribute('href'), `mailto:${person.email}`);
    } finally { await ctx.close(); }
  });
  for (const mode of ['missing', 'encode-failure']) {
    await check(`QR ${mode} degrades safely; download still works`, async () => {
      const ctx = await browser.newContext({ reducedMotion: 'reduce', acceptDownloads: true });
      try {
        const fallback = await ctx.newPage();
        fallback.setDefaultTimeout(12_000);
        await fallback.route('**/qr.js', route => mode === 'missing' ? route.abort() : route.fulfill({ contentType: 'text/javascript', body: 'window.SILSQR={encode:function(){throw new RangeError("synthetic test failure");}};' }));
        await fallback.goto(url);
        assert(!(await fallback.locator('.qr-block').isVisible()));
        const pending = fallback.waitForEvent('download');
        await fallback.locator('[data-action="save"]').click();
        const download = await pending;
        assert.equal(await download.failure(), null);
        assert.equal(utf8.decode(await readFile(await download.path())), vcard);
      } finally { await ctx.close(); }
    });
  }
} catch {
  results.push({ name: 'test environment and setup', status: 'FAIL' });
  console.error('FAIL test environment and setup (check root, npm ci and Chromium installation)');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
  console.log(JSON.stringify({ checks: results, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length }));
  process.exitCode = results.length && results.every(r => r.status === 'PASS') ? 0 : 1;
}

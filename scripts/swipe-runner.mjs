// The swipe bot's browser runner (GitHub Actions, .github/workflows/swipe.yml: a real browser for minutes at a time, which
// Vercel functions can't hold). For each brand, one step a run, oldest first, one brand at a time with pauses:
//   signup     open the site, wait for the popup, put swipe+<slug>@kaizenmarketing.agency in its email signup (or the
//              footer's), submit → the welcome flow
//   browse     a day after the welcome arrived: open a link from the welcome email (so the brand knows who's browsing),
//              then view two or three products → the browse-abandon flow
//   cart       a day later: add a product to the cart and leave → the cart-abandon flow
//   checkout   two days later, where the store allows it (Shopify): start checkout with the email only, then leave
// Never buys anything (post-purchase flows only come from a real order). Never solves or bypasses a CAPTCHA or bot wall:
// the brand is marked "needs a human signup" (the email lead gets an item). Respects robots.txt for every path it opens.
// One identity per brand: its own plus-address and its own cookies, kept between runs.
// Reads and writes the swipe tables over SUPABASE_DB_URL; refuses to sign anything up while the swipe mailbox is
// unresolved or auto-forwards (app_settings.swipe, checked by the app every 15 minutes).
//   node scripts/swipe-runner.mjs [--limit 10] [--only glossier,kosas] [--step signup]
import pg from "pg";
import puppeteer from "puppeteer-core";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : a), []));
const LIMIT = Number(args.limit ?? 8);
const ONLY = args.only ? String(args.only).split(",") : null;
const STEP = args.step ?? null;
const DOMAIN = "kaizenmarketing.agency";
const CAPTCHA = /(recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|captcha-delivery|px-captcha|arkoselabs|funcaptcha|g-recaptcha|h-captcha|cf-chl|are you a robot|verify you are human|press (?:&|and) hold)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.log("SUPABASE_DB_URL not set: nothing to do.");
  process.exit(0);
}
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

const { rows: st } = await db.query("select value from app_settings where key = 'swipe'");
const status = st[0]?.value ?? null;
if (!status?.mailbox) {
  console.log("The swipe mailbox isn't resolved yet (the app checks it every 15 minutes): stopping.");
  await db.end();
  process.exit(0);
}
if (status.forwarding?.enabled) {
  console.log(`The swipe mailbox (${status.mailbox}) auto-forwards to ${status.forwarding.to}: signing nothing up.`);
  await db.end();
  process.exit(0);
}
const { rows: pause } = await db.query("select value from app_settings where key = 'swipe_runner'");
if (pause[0]?.value?.paused) {
  console.log("The swipe runner is paused.");
  await db.end();
  process.exit(0);
}

const event = (brand, kind, ok, detail) => db.query("insert into swipe_events (brand_id, kind, ok, detail) values ($1, $2, $3, $4)", [brand.id, kind, ok, String(detail ?? "").slice(0, 500)]);
const setBrand = (brand, patch) => {
  const keys = Object.keys(patch);
  return db.query(`update swipe_brands set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [brand.id, ...keys.map((k) => (patch[k] !== null && typeof patch[k] === "object" ? JSON.stringify(patch[k]) : patch[k]))]);
};

// Due work: new brands to sign up; a browse a day after the welcome; a cart a day after that; a checkout two days later
const { rows: brands } = await db.query(
  `select b.*, (select count(*) from swipe_emails e where e.brand_id = b.id and e.flow_type = 'welcome') as welcomes,
          (select e.html_path from swipe_emails e where e.brand_id = b.id order by e.received_at asc limit 1) as first_html
   from swipe_brands b where b.status in ('new', 'subscribed', 'active') ${ONLY ? "and b.slug = any($1)" : ""} order by b.updated_at asc`,
  ONLY ? [ONLY] : [],
);
const day = 86_400_000;
const now = Date.now();
const work = [];
for (const b of brands) {
  if (b.status === "new" && (!STEP || STEP === "signup")) work.push({ b, step: "signup" });
  else if (b.signed_up_at && !b.browsed_at && Number(b.emails) > 0 && now - Date.parse(b.signed_up_at) > day && (!STEP || STEP === "browse")) work.push({ b, step: "browse" });
  else if (b.browsed_at && !b.carted_at && now - Date.parse(b.browsed_at) > day && (!STEP || STEP === "cart")) work.push({ b, step: "cart" });
  else if (b.carted_at && !b.checkout_at && b.platform === "shopify" && now - Date.parse(b.carted_at) > 2 * day && (!STEP || STEP === "checkout")) work.push({ b, step: "checkout" });
}
const batch = work.slice(0, LIMIT);
console.log(`${batch.length} step(s) to run: ${batch.map((w) => `${w.b.slug}:${w.step}`).join(", ") || "none"}`);
if (!batch.length) {
  await db.end();
  process.exit(0);
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1366,900"] });
const robotsCache = new Map();
async function allowed(site, path) {
  const origin = new URL(site).origin;
  if (!robotsCache.has(origin)) {
    const txt = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    robotsCache.set(origin, txt);
  }
  const robots = robotsCache.get(origin);
  // The "*" group's rules; the longest matching rule wins
  const rules = [];
  let agents = [];
  let listing = false;
  for (const raw of robots.split(/\r?\n/)) {
    const l = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!listing) agents = [];
      listing = true;
      agents.push(v.toLowerCase());
    } else if (k === "allow" || k === "disallow") {
      listing = false;
      if (agents.includes("*") && v) rules.push({ allow: k === "allow", path: v });
    }
  }
  const hits = rules.filter((r) => new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`).test(path));
  if (!hits.length) return true;
  hits.sort((a, b) => b.path.length - a.path.length || (a.allow ? -1 : 1));
  return hits[0].allow;
}

async function walled(page) {
  const html = await page.content().catch(() => "");
  const frames = page.frames().map((f) => f.url()).join(" ");
  return CAPTCHA.test(html) || CAPTCHA.test(frames);
}

async function open(page, site, path) {
  if (!(await allowed(site, path))) throw Object.assign(new Error(`robots.txt disallows ${path}`), { robots: true });
  await page.goto(new URL(path, site).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await sleep(jitter(3000, 6000));
}

async function signup(page, b) {
  const address = `swipe+${b.slug}@${DOMAIN}`;
  await open(page, b.website, "/");
  if (await walled(page)) return { needsHuman: "A CAPTCHA or bot check on the site" };
  // The popup usually comes after a few seconds or a scroll
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => undefined);
  await sleep(jitter(5000, 8000));
  const isShopify = await page.evaluate(() => Boolean(window.Shopify)).catch(() => false);
  const tryFill = async () => {
    const handles = await page.$$('input[type="email"], input[name*="email" i], input[placeholder*="email" i], input[autocomplete="email"]');
    for (const h of handles) {
      const visible = await h.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 40 && r.height > 10 && s.visibility !== "hidden" && s.display !== "none";
      });
      if (!visible) continue;
      await h.click({ clickCount: 3 }).catch(() => undefined);
      await h.type(address, { delay: jitter(40, 90) });
      // The form's own submit button, else Enter
      const submitted = await h.evaluate((el) => {
        const form = el.closest("form");
        const btn = form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (!submitted) await h.press("Enter");
      return true;
    }
    return false;
  };
  let done = await tryFill();
  if (!done) {
    // The footer's newsletter form
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await sleep(jitter(2500, 4000));
    done = await tryFill();
  }
  if (!done) return { needsHuman: "No email signup form found on the home page" };
  await sleep(jitter(4000, 7000));
  if (await walled(page)) return { needsHuman: "A CAPTCHA appeared after submitting the signup" };
  return { ok: true, platform: isShopify ? "shopify" : null };
}

async function browse(page, b) {
  // A link from the welcome email first (its tracking link sets who's browsing), then products on the brand's site
  const { rows } = await db.query("select links from swipe_emails where brand_id = $1 and flow_type = 'welcome' order by received_at asc limit 1", [b.id]);
  const link = (rows[0]?.links ?? [])[0];
  let linked = false;
  if (link) {
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45_000 }).then(() => (linked = true)).catch(() => undefined);
    await sleep(jitter(4000, 7000));
  }
  await open(page, b.website, "/");
  if (await walled(page)) return { needsHuman: "A CAPTCHA or bot check while browsing" };
  const links = await page.$$eval('a[href*="/products/"], a[href*="/product/"], a[href*="/shop/"]', (as) => [...new Set(as.map((a) => a.getAttribute("href")))].filter(Boolean).slice(0, 12));
  if (!links.length) return { ok: true, note: "No product links found to browse" };
  for (const href of links.slice(0, 3)) {
    const path = href.startsWith("http") ? new URL(href).pathname : href;
    await open(page, b.website, path).catch(() => undefined);
    await page.evaluate(() => window.scrollBy(0, 900)).catch(() => undefined);
    await sleep(jitter(4000, 8000));
  }
  return { ok: true, note: `${Math.min(3, links.length)} products viewed${linked ? "" : " (the welcome email's link wasn't available to open first)"}` };
}

async function cart(page, b) {
  await open(page, b.website, "/");
  const links = await page.$$eval('a[href*="/products/"], a[href*="/product/"]', (as) => [...new Set(as.map((a) => a.getAttribute("href")))].filter(Boolean).slice(0, 6));
  if (!links.length) return { ok: false, note: "No product page found" };
  const path = links[0].startsWith("http") ? new URL(links[0]).pathname : links[0];
  await open(page, b.website, path);
  if (await walled(page)) return { needsHuman: "A CAPTCHA or bot check on the product page" };
  const added = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, input[type="submit"]')].find((el) => /add to (cart|bag)/i.test(el.textContent || el.value || "") && !el.disabled);
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  await sleep(jitter(4000, 7000));
  // Nothing past the cart: never a purchase
  return added ? { ok: true } : { ok: false, note: "No add-to-cart button found" };
}

async function checkout(page, b) {
  // Shopify: the checkout with the subscriber's email typed in, then leave (no payment, nothing submitted past contact)
  if (!(await allowed(b.website, "/checkout"))) return { ok: false, note: "robots.txt disallows /checkout" };
  await open(page, b.website, "/checkout");
  if (await walled(page)) return { needsHuman: "A CAPTCHA or bot check at checkout" };
  const email = await page.$('input[type="email"], input[name="email"], input#email');
  if (!email) return { ok: false, note: "No email field at checkout" };
  await email.type(`swipe+${b.slug}@${DOMAIN}`, { delay: jitter(40, 90) });
  await email.evaluate((el) => el.blur());
  await sleep(jitter(5000, 8000));
  return { ok: true };
}

const STEPS = { signup, browse, cart, checkout };
const KIND = { signup: "signup", browse: "browse", cart: "cart", checkout: "checkout" };
const COL = { signup: "signed_up_at", browse: "browsed_at", cart: "carted_at", checkout: "checkout_at" };
const summary = [];
for (const { b, step } of batch) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  try {
    // This brand's identity: its own cookies, kept between runs
    const cookies = b.session?.cookies ?? [];
    if (cookies.length) await page.setCookie(...cookies).catch(() => undefined);
    const r = await STEPS[step](page, b);
    const kept = await page.cookies().catch(() => []);
    if (r.needsHuman) {
      await event(b, "needs_human", false, r.needsHuman);
      await setBrand(b, { status: "needs_human", note: r.needsHuman, session: { cookies: kept } });
      summary.push(`${b.slug}: needs a human (${r.needsHuman})`);
    } else if (r.ok) {
      await event(b, KIND[step], true, r.note ?? null);
      await setBrand(b, { [COL[step]]: new Date().toISOString(), ...(step === "signup" ? { status: "subscribed", platform: r.platform ?? null } : {}), session: { cookies: kept } });
      summary.push(`${b.slug}: ${step} done${r.note ? ` (${r.note})` : ""}`);
    } else {
      await event(b, KIND[step], false, r.note ?? "didn't work");
      // Mark it done anyway so the next step can run; the note says what happened
      await setBrand(b, { [COL[step]]: new Date().toISOString(), note: r.note ?? null, session: { cookies: kept } });
      summary.push(`${b.slug}: ${step} skipped (${r.note})`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await event(b, e?.robots ? "blocked" : "error", false, msg);
    if (e?.robots) await setBrand(b, { status: "needs_human", note: msg });
    summary.push(`${b.slug}: ${step} failed (${msg.slice(0, 120)})`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
  // A pause between brands: polite, and never a burst
  await sleep(jitter(15_000, 30_000));
}
await browser.close();
await db.end();
console.log(summary.join("\n"));

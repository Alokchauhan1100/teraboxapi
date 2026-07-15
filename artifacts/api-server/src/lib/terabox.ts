import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { logger } from "./logger";

// Session cookie is read from the TERABOX_COOKIE secret. Refresh it (via the
// environment/secrets panel) whenever TeraBox logs the session out.
function getTeraboxCookie(): string {
  const cookie = process.env.TERABOX_COOKIE;
  if (!cookie) {
    throw new TeraboxError(
      "TERABOX_COOKIE is not configured. Set it as a secret to enable TeraBox downloads.",
      500,
    );
  }
  return cookie;
}

const COOKIE_DOMAINS = [
  ".1024tera.com",
  ".terabox.app",
  ".terabox.com",
  ".terasharefile.com",
  ".1024terabox.com",
  ".teraboxurl.com",
  ".teraboxlink.com",
  ".4funbox.com",
  ".momerybox.com",
  ".teraboxapp.com",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class TeraboxError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface TeraboxNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  fsId: string;
  children?: TeraboxNode[] | null;
}

export interface ResolvedShare {
  title: string;
  tree: TeraboxNode[];
}

function parseCookieHeader(raw: string) {
  const out: { name: string; value: string; domain: string; path: string }[] = [];
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    for (const domain of COOKIE_DOMAINS) {
      out.push({ name, value, domain, path: "/" });
    }
  }
  return out;
}

let browserPromise: Promise<Browser> | null = null;

function buildProxyConfig():
  | { server: string; username?: string; password?: string }
  | undefined {
  const raw = process.env.PLAYWRIGHT_PROXY;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const server = `${url.protocol}//${url.hostname}:${url.port}`;
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    console.log(`[proxy] using ${server} username=${username ?? "(none)"}`);
    return { server, username, password };
  } catch {
    // plain host:port with no credentials
    console.log(`[proxy] using raw server: ${raw}`);
    return { server: raw };
  }
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const executablePath =
      process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
      undefined;
    const proxy = buildProxyConfig();
    browserPromise = chromium
      .launch({
        executablePath,
        proxy,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1400, height: 1000 },
    locale: "en-US",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error - stubbing a browser global that only exists at runtime
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });
  await context.addCookies(parseCookieHeader(getTeraboxCookie()));
  return context;
}

// ---------------------------------------------------------------------------
// Cookie health check
// ---------------------------------------------------------------------------

export interface CookieHealthResult {
  valid: boolean;
  reason: string;
}

/**
 * Validates that the TERABOX_COOKIE session is alive by opening a real
 * Playwright browser context (with the cookie applied) and navigating to the
 * TeraBox main page. If TeraBox redirects us to a login/auth page the session
 * is dead; if we land on the main app it is alive.
 *
 * Fetch-based checks against TeraBox JSON APIs are unreliable here because
 * those endpoints need Baidu's BDUSS token, not the ndus session cookie that
 * TeraBox's own web UI uses. The browser approach is the only reliable method.
 *
 * This is intentionally not called inside resolveDownload — the actual
 * share/download API response already surfaces session errors (errno -6,
 * 31045, etc.) with actionable messages via describeTeraboxErrno(). This
 * function is only used by the GET /api/terabox/cookie-status diagnostic
 * endpoint so operators can check the session without triggering a full
 * download flow.
 */
export async function checkCookieHealth(): Promise<CookieHealthResult> {
  const context = await newContext();
  try {
    const page = await context.newPage();
    try {
      await page.goto("https://www.terabox.com/main", { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(2000);
    } catch {
      // Navigation errors (timeout, network) — can't determine status.
      return { valid: false, reason: "Could not reach TeraBox to check session status." };
    }

    const finalUrl = page.url();
    const isLoginPage =
      finalUrl.includes("/login") ||
      finalUrl.includes("/signin") ||
      finalUrl.includes("passport") ||
      finalUrl.includes("account/login");

    if (isLoginPage) {
      return {
        valid: false,
        reason:
          "The TERABOX_COOKIE session is expired or logged out — TeraBox redirected to the login page. " +
          "Every dlink generated from this session will fail (error_code 31045) on the user's device. " +
          "Update TERABOX_COOKIE with a fresh browser session cookie.",
      };
    }

    return { valid: true, reason: "Session is active." };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Browser-based file download
// ---------------------------------------------------------------------------

export interface BrowserDownloadResult {
  filePath: string;
  dir: string;
}

/**
 * Downloads a TeraBox dlink using Playwright's Chromium browser instead of a
 * bare fetch(). This is necessary because TeraBox's CDN signs individual-file
 * dlinks to the generating session — the CDN then rejects requests that don't
 * carry the matching session cookie AND the right browser TLS fingerprint. A
 * plain Node.js fetch (even with the cookie header) gets HTTP 403 / error_code
 * 31045 because its TLS fingerprint looks like a bot. Chromium presents an
 * authentic browser TLS handshake + full session context, which the CDN
 * accepts.
 *
 * The `waitForEvent("download")` timeout is intentionally short (20 s): if the
 * CDN hasn't started streaming within 20 s it has almost certainly blocked the
 * request, and the caller should fall back to handing the user the raw link.
 */
export async function downloadDlinkViaBrowser(
  dlink: string,
  filename: string,
): Promise<BrowserDownloadResult> {
  const sanitized = filename.replace(/[/\\:*?"<>|]/g, "_").slice(0, 200) || "video";
  const dir = await mkdtemp(path.join(tmpdir(), "terabox-dl-"));
  const filePath = path.join(dir, sanitized);

  const context = await newContext();
  try {
    const page = await context.newPage();

    // Kick off navigation (will "fail" once the browser starts downloading)
    // and race it against the download event.
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
    page.goto(dlink).catch(() => {});

    let download: Awaited<typeof downloadPromise>;
    try {
      download = await downloadPromise;
    } catch {
      throw new TeraboxError(
        "TeraBox did not send the file within the expected time — the CDN may have blocked this request.",
      );
    }

    await download.saveAs(filePath);
    const failure = await download.failure();
    if (failure) {
      throw new TeraboxError(`Browser download failed: ${failure}`);
    }

    logger.info({ filename, filePath }, "TeraBox file downloaded via Playwright browser");
    return { filePath, dir };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof TeraboxError) throw err;
    throw new TeraboxError(
      `Browser download error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await context.close();
  }
}

interface ListParams {
  origin: string;
  shorturl: string;
  app_id: string;
  jsToken: string;
  channel: string;
  clienttype: string;
  web: string;
}

async function captureListParams(page: Page, url: string): Promise<ListParams> {
  let listParams: ListParams | null = null;
  let sawLoginRedirect = false;
  let foundResolve: (() => void) | undefined;
  const found = new Promise<void>((resolve) => {
    foundResolve = resolve;
  });
  const onResponse = (res: import("playwright-core").Response) => {
    const resUrl = res.url();
    if (!listParams && resUrl.includes("/share/list")) {
      const u = new URL(resUrl);
      listParams = {
        origin: u.origin,
        shorturl: u.searchParams.get("shorturl") ?? "",
        app_id: u.searchParams.get("app_id") ?? "",
        jsToken: u.searchParams.get("jsToken") ?? "",
        channel: u.searchParams.get("channel") ?? "",
        clienttype: u.searchParams.get("clienttype") ?? "",
        web: u.searchParams.get("web") ?? "",
      };
      foundResolve?.();
    }
  };
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Don't rely on a fixed sleep: on slower/cloud egress networks (e.g. a
    // Render datacenter reaching TeraBox's servers) the /share/list XHR can
    // take much longer to fire than it does from a fast dev connection. Wait
    // for the response itself, up to a generous ceiling, instead of racing a
    // short fixed timeout.
    await Promise.race([found, page.waitForTimeout(20000)]);
    const finalUrl = page.url();
    sawLoginRedirect =
      finalUrl.includes("/login") ||
      finalUrl.includes("/signin") ||
      finalUrl.includes("passport") ||
      finalUrl.includes("account/login");
  } catch (err) {
    throw new TeraboxError(
      `Could not load the share page: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    page.off("response", onResponse);
  }
  if (!listParams) {
    if (sawLoginRedirect) {
      throw new TeraboxError(
        "TeraBox redirected to a login page instead of loading the share — the TERABOX_COOKIE session is expired or banned. Refresh TERABOX_COOKIE with a fresh browser session cookie.",
        400,
      );
    }
    throw new TeraboxError(
      "This does not look like a valid TeraBox share link, or the share is unavailable. " +
        "If this link works from a browser but keeps failing here, TeraBox may be blocking this server's " +
        "IP address (common for datacenter IPs on hosts like Render) — set PLAYWRIGHT_PROXY to a residential/ISP proxy URL to route around it.",
      400,
    );
  }
  return listParams;
}

// TeraBox's numeric API error codes ("errno") that we've seen in practice,
// mapped to messages that actually tell the user something actionable.
// Full list is undocumented; unmapped codes fall through to a generic
// message that still surfaces the raw code for troubleshooting.
function describeTeraboxErrno(errno: number, fallbackMsg?: string): string {
  switch (errno) {
    case 31045:
      // This code appears in two places:
      //   1. Server-side, from share/download — the session cookie is invalid
      //      or banned, so the signed dlink is poisoned before it's even sent.
      //   2. Client-side, on the user's device — confirms the dlink was
      //      generated by a dead session (not an IP restriction, since the user's
      //      own residential IP also gets this error).
      // In both cases the fix is the same: refresh TERABOX_COOKIE.
      return (
        "The download link is invalid because the bot's TeraBox session cookie (TERABOX_COOKIE) " +
        "is expired or has been banned. This is NOT an IP restriction — users on residential IPs " +
        "receive the same error, confirming the session itself is the problem. " +
        "Update the TERABOX_COOKIE environment variable with a fresh browser session cookie to fix this."
      );
    case -9:
      return "TeraBox says this file no longer exists in the share. It may have been removed or moved by the uploader.";
    case -6:
      return "TeraBox rejected this request as unauthorized. The share may require login, be private, or our connected account's session may have expired.";
    case -12:
      return "TeraBox rejected the request parameters. Please re-resolve the share link and try again.";
    case 105:
      return "TeraBox says this share link is invalid or malformed.";
    case 110:
    case 112:
      return "TeraBox reports this share has expired or was cancelled by the uploader.";
    case 2:
      return "TeraBox rejected the request due to invalid parameters — please re-resolve the share link and try again.";
    default:
      return `TeraBox returned an error (code ${errno}${fallbackMsg ? `: ${fallbackMsg}` : ""}). This is coming from TeraBox itself, not this app — the share link may be broken, expired, or restricted.`;
  }
}

async function listDir(page: Page, params: ListParams, dir: string): Promise<any[]> {
  const data = await page.evaluate(async (p: ListParams & { dir: string }) => {
    const qs = new URLSearchParams();
    qs.set("clientfrom", "h5");
    qs.set("psign", "0");
    qs.set("clienttype", p.clienttype);
    qs.set("channel", p.channel);
    qs.set("page", "1");
    qs.set("num", "100");
    qs.set("web", p.web);
    qs.set("shorturl", p.shorturl);
    qs.set("root", p.dir === "/" ? "1" : "0");
    if (p.dir !== "/") qs.set("dir", p.dir);
    qs.set("by", "time");
    qs.set("order", "desc");
    qs.set("app_id", p.app_id);
    qs.set("jsToken", p.jsToken);
    const res = await fetch(p.origin + "/share/list?" + qs.toString(), {
      credentials: "include",
    });
    return (await res.json()) as { list?: unknown[]; errno?: number; error_code?: number; error_msg?: string };
  }, { ...params, dir });
  const errno = data?.errno ?? data?.error_code;
  if (errno !== undefined && errno !== 0 && !data?.list) {
    logger.warn({ errno, error_msg: data?.error_msg, dir }, "TeraBox share/list returned an error");
    throw new TeraboxError(describeTeraboxErrno(errno, data?.error_msg), 502);
  }
  return data?.list ?? [];
}

// Maps fsId -> ordered list of ancestor folder *names* that must be clicked
// through (in the browser UI) from the root view to reach that file/folder's
// containing directory. Populated as a side effect of walk() so resolveDownload
// can group selections by UI-reachable folder rather than by raw path string
// (TeraBox auto-descends into a lone top-level folder, so path prefixes do not
// always correspond to a visible navigation step).
type AncestorMap = Map<string, string[]>;

async function walk(
  page: Page,
  params: ListParams,
  dir: string,
  depth: number,
  ancestorNames: string[],
  ancestorMap: AncestorMap,
): Promise<TeraboxNode[]> {
  if (depth > 8) return [];
  const items = await listDir(page, params, dir);
  const results: TeraboxNode[] = [];
  for (const item of items) {
    const node: TeraboxNode = {
      name: item.server_filename,
      path: item.path,
      isDir: item.isdir === "1" || item.isdir === 1,
      size: Number(item.size || 0),
      fsId: String(item.fs_id),
    };
    ancestorMap.set(node.fsId, ancestorNames);
    if (node.isDir) {
      node.children = await walk(page, params, item.path, depth + 1, [
        ...ancestorNames,
        node.name,
      ], ancestorMap);
    }
    results.push(node);
  }
  return results;
}

function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("ERR_TIMED_OUT") ||
    msg.includes("ERR_CONNECTION_") ||
    msg.includes("ERR_NAME_NOT_RESOLVED") ||
    msg.includes("ERR_NETWORK_CHANGED") ||
    msg.includes("ERR_SOCKET_NOT_CONNECTED")
  );
}

// Some hosting providers have flaky (rather than permanently blocked)
// outbound connectivity to TeraBox's servers — a goto() will occasionally
// hard-timeout (net::ERR_TIMED_OUT) even though the very next attempt from a
// fresh context succeeds. Retry a couple of times on those specific
// transient network errors before giving up, since a single failed
// connection attempt isn't proof of a permanent block.
const MAX_RESOLVE_ATTEMPTS = 3;

export async function resolveShare(url: string): Promise<ResolvedShare> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RESOLVE_ATTEMPTS; attempt++) {
    const context = await newContext();
    try {
      const page = await context.newPage();
      const params = await captureListParams(page, url);
      const tree = await walk(page, params, "/", 0, [], new Map());
      const title = await page.title();
      return { title: title || "TeraBox share", tree };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RESOLVE_ATTEMPTS && isTransientNetworkError(err)) {
        logger.warn(
          { attempt, url },
          "TeraBox resolveShare hit a transient network error, retrying",
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw err;
    } finally {
      await context.close();
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Reusable share session — lets a caller resolve a share ONCE and then
// download several files from it without re-opening a browser, reloading the
// share page, and re-walking the whole file tree for every single file.
//
// This matters beyond performance: hammering the same share link with a
// brand-new browser context + full page load for every file in a "download
// all" batch looks nothing like normal human browsing and is exactly the
// pattern anti-bot/rate-limiting systems key on. Reusing one session for the
// whole batch (one page load, one tree walk, then just clicking between
// files) is both faster and far less likely to get throttled or blocked
// partway through a batch.
// ---------------------------------------------------------------------------

export interface ShareSession {
  context: BrowserContext;
  page: Page;
  tree: TeraboxNode[];
  ancestorMap: AncestorMap;
}

export async function openShareSession(url: string): Promise<ShareSession> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RESOLVE_ATTEMPTS; attempt++) {
    const context = await newContext();
    try {
      const page = await context.newPage();
      const params = await captureListParams(page, url);
      const ancestorMap: AncestorMap = new Map();
      const tree = await walk(page, params, "/", 0, [], ancestorMap);
      return { context, page, tree, ancestorMap };
    } catch (err) {
      await context.close().catch(() => {});
      lastErr = err;
      if (attempt < MAX_RESOLVE_ATTEMPTS && isTransientNetworkError(err)) {
        logger.warn(
          { attempt, url },
          "TeraBox openShareSession hit a transient network error, retrying",
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function closeShareSession(session: ShareSession): Promise<void> {
  await session.context.close().catch(() => {});
}

function flatten(nodes: TeraboxNode[]): TeraboxNode[] {
  const out: TeraboxNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children) out.push(...flatten(n.children));
  }
  return out;
}

async function navigateIntoFolder(page: Page, ancestorNames: string[]): Promise<void> {
  for (const name of ancestorNames) {
    // TeraBox sometimes auto-descends into a lone top-level folder on page
    // load, so the row we're looking for may already be gone (we're already
    // inside it). Only click if the row is actually present; otherwise
    // assume we're already there.
    const row = page.locator(".file-item-name", { hasText: name }).first();
    const isPresent = await row.count().catch(() => 0);
    if (isPresent > 0) {
      try {
        await row.click({ timeout: 10000 });
        await page.waitForTimeout(1200);
      } catch (err) {
        // Surface this as a clear, actionable TeraboxError instead of a raw
        // Playwright timeout — the generic catch in bot.ts collapses any
        // non-TeraboxError into an unhelpful "Could not resolve this file."
        // This most often happens when a share's folder layout shifts
        // between resolving the list and clicking into it (e.g. mid-batch
        // download of many files back to back).
        throw new TeraboxError(
          `Could not navigate into folder "${name}" — the page layout may have changed. Please re-resolve the share link and try again. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }
}

interface DownloadResult {
  dlink: string;
  isZip: boolean;
}

async function triggerDownload(
  page: Page,
  fsIds: Set<string>,
  siblingOrder: TeraboxNode[],
): Promise<DownloadResult> {
  const rows = page.locator(".file-item-listmode");
  let count = await rows.count();
  // The row list can still be re-rendering right after navigating into a
  // folder (React commit lands a beat after the click settles), so a single
  // immediate count check is flaky. Poll briefly before giving up.
  for (let attempt = 0; count !== siblingOrder.length && attempt < 8; attempt++) {
    await page.waitForTimeout(500);
    count = await rows.count();
  }

  // Shares that contain exactly one file often render a dedicated
  // preview/download page with no selectable row list at all (there's
  // nothing to choose between) — TeraBox skips the checkbox UI entirely.
  // When we're only after that single file, there's nothing to select:
  // fall through to the Download button below instead of erroring out.
  const isSingleFilePreviewPage = count === 0 && siblingOrder.length === 1 && fsIds.size === 1;

  if (count !== siblingOrder.length && !isSingleFilePreviewPage) {
    throw new TeraboxError(
      `The share's file list didn't match what we expected (found ${count} items, expected ${siblingOrder.length}). This usually means the folder structure changed since resolving — please re-resolve the share link and try again.`,
    );
  }

  for (let i = 0; i < count; i++) {
    const node = siblingOrder[i];
    const row = rows.nth(i);
    const isChecked = ((await row.getAttribute("class")) ?? "").includes("checked");
    const shouldBeChecked = fsIds.has(node.fsId);
    if (isChecked !== shouldBeChecked) {
      const box = row.locator(".checkbox-box").first();
      await box.click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // Give the app a moment to settle its selection-derived state (e.g. total
  // size/price recompute) before we act on the Download button — clicking
  // immediately after the last checkbox can race with that update.
  await page.waitForTimeout(1200);

  // TeraBox occasionally shows an interstitial (cookie/consent banner, "get
  // the app" promo, login nag) that sits on top of the real download button.
  // These are best-effort dismissals — harmless no-ops if none are present.
  const dismissSelectors = [
    '[class*="dialog"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
    '.wp-s-pop-close',
    '.g-dialog-close',
    'button:has-text("Not now")',
    'button:has-text("Cancel")',
  ];
  for (const sel of dismissSelectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout: 1500 }).catch(() => {});
    }
  }

  let captured: DownloadResult | null = null;
  const apiErrorBox: { value: { errno: number; msg?: string } | null } = { value: null };
  const seen: { url: string; status: number; body: string }[] = [];
  const onResponse = async (res: import("playwright-core").Response) => {
    const url = res.url();
    if (/\/share\/download/i.test(url)) {
      let fullBody = "";
      try {
        fullBody = await res.text();
      } catch {
        fullBody = "";
      }
      seen.push({ url, status: res.status(), body: fullBody.slice(0, 500) });
      if (!captured && fullBody) {
        try {
          const json = JSON.parse(fullBody);
          if (json?.dlink) {
            captured = { dlink: json.dlink, isZip: /batchdownload/i.test(json.dlink) };
          } else {
            const errno = json?.errno ?? json?.error_code;
            if (typeof errno === "number" && errno !== 0 && !apiErrorBox.value) {
              apiErrorBox.value = { errno, msg: json?.error_msg };
            }
          }
        } catch {
          // ignore non-JSON responses
        }
      }
    }
  };
  page.on("response", onResponse);
  // Single-file preview pages sometimes render more than one element that
  // matches a plain "Download" text match (e.g. a promo banner's "Download
  // App" button alongside the real per-file download action). Try each
  // candidate in order, and click a couple of times if the first attempt
  // produces no matching network response — TeraBox's UI occasionally needs
  // a first click to reveal a submenu ("Download to computer") and a second
  // to actually fire the request.
  const buttonCandidates = [
    'button:has-text("Download")',
    '[class*="download"][class*="btn"]',
    '[class*="download-btn"]',
    'a:has-text("Download")',
  ];
  try {
    for (let round = 0; round < 2 && !captured; round++) {
      for (const sel of buttonCandidates) {
        if (captured) break;
        const btn = page.locator(sel).first();
        const present = await btn.count().catch(() => 0);
        if (!present) continue;
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ timeout: 10000, force: true }).catch(() => {});
        await page.waitForTimeout(3500);
        if (captured) break;
      }
    }
  } finally {
    page.off("response", onResponse);
  }

  if (!captured) {
    logger.warn(
      {
        rowCount: count,
        fsIdsCount: fsIds.size,
        seenResponses: seen,
        pageUrl: page.url(),
        pageTitle: await page.title().catch(() => undefined),
        apiError: apiErrorBox.value,
        downloadButtonCounts: await Promise.all(
          buttonCandidates.map(async (sel) => ({
            sel,
            count: await page.locator(sel).count().catch(() => -1),
          })),
        ),
      },
      "TeraBox triggerDownload: no dlink captured",
    );
    if (apiErrorBox.value) {
      throw new TeraboxError(describeTeraboxErrno(apiErrorBox.value.errno, apiErrorBox.value.msg));
    }
    if (fsIds.size > 1) {
      // TeraBox silently no-ops the zip-download click (no dialog, no error
      // response) once the selected batch exceeds a size cap tied to the
      // share/account's plan tier — confirmed empirically: ~47MB across 4
      // files succeeds, ~86MB across 5 files silently fails on the same
      // share link. There's no clean way to detect the exact cap up front,
      // so surface this as an actionable message instead of a generic one.
      throw new TeraboxError(
        "TeraBox couldn't prepare this batch as a zip — likely because the combined file size is over what this account tier allows for one download. Try downloading fewer files at a time.",
      );
    }
    throw new TeraboxError(
      "TeraBox did not return a download link. The share link may require a different account or has expired.",
    );
  }
  return captured;
}

export interface DownloadTarget {
  url: string;
  isZip: boolean;
  filename: string;
}

/**
 * Downloads one file (or a same-folder batch) from an already-open
 * ShareSession. Safe to call repeatedly against the same session for
 * multiple files — only re-navigates folders and re-triggers the download,
 * without reloading the share page or re-walking the tree.
 */
export async function downloadFromSession(
  session: ShareSession,
  fsIds: string[],
  filename?: string,
): Promise<DownloadTarget> {
  if (fsIds.length === 0) {
    throw new TeraboxError("No files selected.", 400);
  }
  const { page, tree, ancestorMap } = session;
  const flat = flatten(tree);
  const byId = new Map(flat.map((n) => [n.fsId, n]));

  const targets = fsIds.map((id) => {
    const node = byId.get(id);
    if (!node) {
      throw new TeraboxError(`File ${id} was not found in this share.`, 400);
    }
    return node;
  });

  const ancestorKeys = new Set(
    targets.map((n) => JSON.stringify(ancestorMap.get(n.fsId) ?? [])),
  );
  if (ancestorKeys.size > 1) {
    throw new TeraboxError(
      "Please select files from a single folder at a time.",
      400,
    );
  }
  const ancestorNames = ancestorMap.get(targets[0]!.fsId) ?? [];

  await navigateIntoFolder(page, ancestorNames);

  let siblingOrder = tree;
  for (const name of ancestorNames) {
    const folder = siblingOrder.find((n) => n.isDir && n.name === name);
    siblingOrder = folder?.children ?? [];
  }

  const result = await triggerDownload(page, new Set(fsIds), siblingOrder);
  const defaultName =
    targets.length === 1 ? targets[0]!.name : `${filename ?? "download"}.zip`;
  const finalName = filename && targets.length === 1 ? filename : defaultName;

  // Hand the signed URL straight back to the browser so the end user's own
  // IP performs the actual byte fetch. Do NOT proxy the bytes through this
  // server — our egress IP may be blocked by TeraBox's CDN, and even when
  // it isn't, the signed dlink is tied to the session that generated it.
  // A dead/banned TERABOX_COOKIE session will produce a dlink that fails
  // with error_code 31045 on the user's device — the pre-flight health
  // check above should catch this before we ever reach this point.
  return {
    url: result.dlink,
    isZip: result.isZip,
    filename: finalName,
  };
}

/**
 * Convenience one-shot wrapper: opens a session, downloads a single target,
 * closes the session. Use openShareSession + downloadFromSession directly
 * when downloading multiple files from the same share (e.g. batch "download
 * all") to avoid re-resolving the share for every file.
 */
export async function resolveDownload(
  url: string,
  fsIds: string[],
  filename?: string,
): Promise<DownloadTarget> {
  const session = await openShareSession(url);
  try {
    return await downloadFromSession(session, fsIds, filename);
  } finally {
    await closeShareSession(session);
  }
}

export function getUserAgent(): string {
  return USER_AGENT;
}

export async function shutdownBrowser(): Promise<void> {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch (err) {
      logger.warn({ err }, "Error closing terabox browser");
    }
    browserPromise = null;
  }
}

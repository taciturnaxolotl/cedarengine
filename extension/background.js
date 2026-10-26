/**
 * The courier.
 *
 * Three of cedarengine's sources are behind a login a server cannot hold: the
 * directory and the course search want an SSO session, and the campus store
 * wants an AWS WAF challenge solved by a real browser. This is a real browser,
 * and you are already signed into all of them. So the extension does no thinking of its own — it
 * asks the engine what to fetch, fetches it, and posts back what came out.
 *
 * The engine decides which name prefixes are still hiding rows, which students
 * have no booklist yet, and when a sweep has seen everybody. Keeping all of
 * that on the server side means this file never has to be updated when the
 * sweep logic gets smarter.
 */

const DEFAULTS = {
  engine: "http://127.0.0.1:3000",
  token: "",
  term: "",
  everyHours: 12,
  batch: 40,
  delayMs: 150,
  autoSync: true,
};

const ALARM = "cedarengine-sync";
const DIRECTORY = "https://selfservice.cedarville.edu";
const DIRECTORY_PAGE = `${DIRECTORY}/CedarInfo/Directory`;
/** The registrar, not a load test. Never faster than this between pages. */
const CATALOG_DELAY_MS = 300;
const STORE_PAGE = "https://store.cedarville.edu/textbook/index/search";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });

async function setStatus(patch) {
  const now = { ...(await chrome.storage.local.get("status")).status, ...patch, at: Date.now() };
  await chrome.storage.local.set({ status: now });
  return now;
}

/** Talking to the engine. Every route but /health wants the bearer token. */
async function engine(path, body) {
  const { engine: base, token } = await settings();
  const response = await fetch(base.replace(/\/$/, "") + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) throw new Error("the engine rejected the token");
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

// ---- the directory -------------------------------------------------------

class SignedOut extends Error {
  constructor() {
    super("signed out of Self-Service");
  }
}

/** One directory query, with your own session cookie riding along. */
async function directoryQuery(last, first) {
  const params = new URLSearchParams();
  if (last) params.set("LastNameSearch", last);
  if (first) params.set("FirstNameSearch", first);

  const response = await fetch(`${DIRECTORY}/CedarInfo/Directory/SearchResultsJson?${params}`, {
    credentials: "include",
    // Signed out, Self-Service 302s to the Microsoft SSO page. Following that
    // cross-origin redirect with these headers trips a CORS preflight that the
    // SSO host does not answer, so the fetch throws instead of reporting the
    // real problem. Stopping at the redirect keeps it a clean "signed out".
    redirect: "manual",
    headers: { "x-requested-with": "XMLHttpRequest", accept: "*/*" },
  });
  if (response.type === "opaqueredirect" || response.redirected) throw new SignedOut();
  if (response.status === 401 || response.status === 403) throw new SignedOut();
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) throw new SignedOut();
  return data;
}

/**
 * A data-free check that the SSO session is live. The directory landing page is
 * HTML behind the same login and returns 200 when signed in; a redirect off it
 * means signed out. (The course-search page 302s even when authenticated, so it
 * is no good as a probe.)
 */
async function selfServiceReady() {
  try {
    const response = await fetch(DIRECTORY_PAGE, {
      credentials: "include",
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    return response.ok && response.type !== "opaqueredirect" && !response.redirected;
  } catch {
    return false;
  }
}

/**
 * Auth first. Self-Service needs an SSO session the server cannot hold, so make
 * one is live before the sweep leans on it. If signed out, open the sign-in
 * page and wait a few minutes for the person to finish rather than failing the
 * whole run on the first query.
 */
async function ensureSelfService() {
  if (await selfServiceReady()) return true;
  await chrome.tabs.create({ url: DIRECTORY_PAGE, active: true });
  for (let waited = 0; waited < 180_000; waited += 3000) {
    await setStatus({
      phase: "signin",
      note: `waiting for sign-in · ${Math.round(waited / 1000)}s`,
    });
    await sleep(3000);
    if (await selfServiceReady()) {
      await setStatus({ phase: "directory", note: null });
      return true;
    }
  }
  return false;
}

export async function syncDirectory({ refresh = false } = {}) {
  const { batch, delayMs } = await settings();
  let plan = await engine("/v1/sync/start", { kind: "directory", refresh, limit: batch });
  const sweep = plan.sweep;
  let asked = 0;
  let added = 0;

  while (plan.queries?.length) {
    const results = [];
    for (const query of plan.queries) {
      results.push({
        last: query.last,
        first: query.first,
        people: await directoryQuery(query.last, query.first),
      });
      asked++;
      await setStatus({ phase: "directory", note: null, asked, added, queued: plan.pending });
      if (delayMs) await sleep(delayMs);
    }

    const posted = await engine("/v1/sync/directory", { sweep, results, limit: batch });
    added += posted.added;
    plan = posted;
    if (posted.done) break;
  }

  return setStatus({
    phase: "idle",
    directoryAt: Date.now(),
    asked,
    added,
    queued: 0,
  });
}

// ---- the catalog ---------------------------------------------------------

/**
 * Signed out, Self-Service bounces to its login page, which bounces again to
 * the SAML provider. Either way the URL stops being a course search URL. These
 * pages follow their internal redirects rather than stopping at them, so the
 * final URL is the signal — unlike the directory JSON endpoint, which answers
 * straight and is read with redirect:"manual".
 */
const bounced = (response) =>
  !response.url.startsWith(DIRECTORY) || response.url.includes("/Account/Login");

/**
 * Ellucian's antiforgery token, scraped from the search page. The cookie it is
 * bound to lands in the browser's own jar, so only the token is kept here. This
 * uses the authenticated /Student/Student/Courses/* area: the anonymous
 * /Student/Courses/* catalog the server collector used is now gated, which is
 * why collecting it moved into the signed-in browser.
 */
async function courseSearchToken() {
  const response = await fetch(`${DIRECTORY}/Student/Student/Courses/Search`, {
    credentials: "include",
    headers: { accept: "text/html" },
  });
  if (bounced(response)) throw new SignedOut();
  const html = await response.text();
  const token = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("no antiforgery token on the course search page");
  return token;
}

async function courseJson(token, path, body) {
  const response = await fetch(DIRECTORY + path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      __RequestVerificationToken: token,
      // Ellucian sends exactly this malformed content type; mirroring it.
      ...(body ? { "content-type": "application/json, charset=UTF-8" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (bounced(response)) throw new SignedOut();
  const data = await response.json().catch(() => null);
  if (!data) throw new Error(`${path} returned something other than JSON`);
  return data;
}

/** Every page of one search, deduplicated by id as sections shift between pages. */
async function everyPage(token, criteria, key, onPage) {
  const byId = new Map();
  for (let page = 1, total = 1; page <= total; page++) {
    const result = await courseJson(token, "/Student/Student/Courses/PostSearchCriteria", {
      quantityPerPage: 100,
      searchResultsView: "SectionListing",
      ...criteria,
      pageNumber: page,
    });
    total = Math.max(result.TotalPages ?? 1, 1);
    for (const item of result[key] ?? [])
      if (item?.Id && !byId.has(item.Id)) byId.set(item.Id, item);
    await onPage?.(page, total);
    if (page < total) await sleep(CATALOG_DELAY_MS);
  }
  return [...byId.values()];
}

export async function syncCatalog() {
  await setStatus({ phase: "catalog", terms: 0, failed: [], catalogError: null });
  const token = await courseSearchToken();
  const vocabulary = await courseJson(token, "/Student/Student/Courses/GetCatalogAdvancedSearch");
  const listed = (vocabulary.Terms ?? []).map((term) => term.Item1);

  const plan = await engine("/v1/sync/start", { kind: "catalog", listed });
  const { sweep } = plan;
  const wanted = [...(plan.terms ?? []), ...(plan.allCourses ? ["ALL"] : [])];
  const filed = new Set();

  const fetchOne = async (term) => {
    const progress = (phase) => (page, pages) =>
      setStatus({ phase: "catalog", term, page: `${phase} ${page}/${pages}` });
    // The every-course listing has no sections, and no term to narrow it.
    const all = term === "ALL";
    const criteria = all ? {} : { terms: [term] };
    const sections = all ? [] : await everyPage(token, criteria, "Sections", progress("sections"));
    const courses = await everyPage(
      token,
      { ...criteria, searchResultsView: "CatalogListing" },
      "CourseFullModels",
      progress("courses"),
    );
    const posted = await engine("/v1/sync/catalog", { sweep, term, sections, courses });
    if (!posted.kept) filed.add(term);
  };

  try {
    for (const term of wanted) {
      try {
        await fetchOne(term);
      } catch (error) {
        // A signed-out session sinks everything; one bad term sinks only itself.
        if (error instanceof SignedOut) throw error;
      }
    }
  } finally {
    // Close the sweep even when signed out partway, so it is not left dangling
    // and claims nothing it did not fetch.
    const failed = wanted.filter((term) => !filed.has(term));
    await engine("/v1/sync/catalog", { sweep, done: true, failed });
  }

  const failed = wanted.filter((term) => !filed.has(term));
  return setStatus({ phase: "idle", catalogAt: Date.now(), terms: filed.size, failed });
}

// ---- booklists -----------------------------------------------------------

/**
 * Runs inside the store page.
 *
 * It has to: the booklist endpoint is guarded by an AWS WAF token that only a
 * real request from the page's own origin carries. When the token dies mid-run
 * the fetch comes back as a challenge page, so a run of those means the page
 * needs re-solving — which only a reload can do. It hands that back to the
 * service worker rather than trying to refresh the token itself; the token
 * lives in the cookie jar now, not on any object this world can reach.
 */
function harvestInPage(ids, delayMs) {
  const grab = (block, label) => {
    const match = block.match(new RegExp(`${label}:\\s*([^<]*?)\\s*</span>`, "i"));
    return match ? match[1].trim() : null;
  };

  const parse = (html) => {
    const books = [];
    for (const block of html.split("book-container").slice(1)) {
      const title = block.match(/book-title">\s*([^<]*?)\s*<\/div>/i);
      books.push({
        title: title ? title[1].trim() : null,
        department: grab(block, "Department"),
        course: grab(block, "Course"),
        section: grab(block, "Section"),
        isbn: grab(block, "ISBN-13"),
        edition: grab(block, "Edition"),
        status: grab(block, "Status"),
      });
    }
    return books;
  };

  return (async () => {
    const rows = [];
    let consecutive = 0;
    for (const id of ids) {
      try {
        const response = await fetch(`/textbook/index/books?student_id=${id}&_=${Date.now()}`, {
          headers: { "x-requested-with": "XMLHttpRequest" },
        });
        const text = await response.text();
        // The WAF answers with a challenge page rather than an error status.
        if (!text.includes("book-container") && !text.includes("book-list-container")) {
          throw new Error("challenged");
        }
        rows.push({ id: String(id), books: parse(text) });
        consecutive = 0;
      } catch {
        // A short run of challenges means the token is dead. Hand what we have
        // back so the worker can reload the page and re-solve before resuming.
        if (++consecutive >= 5) return { rows, challenged: true };
      }
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { rows, challenged: false };
  })();
}

/** Resolve once a tab has finished loading, however it got there. */
async function awaitComplete(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "complete") return;
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * One cheap request the WAF also guards, carrying no personal data. A solved
 * page answers with the book-list shell; the challenge answers with neither it
 * nor a book-container. This is the only honest "is the page ready" signal:
 * `complete` fires on the challenge interstitial too, and AwsWafIntegration is
 * gone once the token lands in the cookie jar.
 */
function probeReadyInPage() {
  return (async () => {
    try {
      const response = await fetch(`/textbook/index/books?student_id=0&_=${Date.now()}`, {
        headers: { "x-requested-with": "XMLHttpRequest" },
      });
      const text = await response.text();
      return text.includes("book-container") || text.includes("book-list-container");
    } catch {
      return false;
    }
  })();
}

/**
 * The store sits behind an AWS WAF challenge. A freshly opened or token-expired
 * tab reports "complete" on the challenge page itself, before the token cookie
 * exists, so harvesting right away loses the whole first batch. Reload until a
 * guarded probe actually comes back solved, or give up rather than spin.
 */
async function waitForStoreReady(tabId, tries = 6) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    await awaitComplete(tabId);
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: probeReadyInPage,
    });
    if (probe?.result) return true;
    await setStatus({ phase: "booklists", note: `warming store · ${attempt}/${tries}` });
    if (attempt < tries) {
      await chrome.tabs.reload(tabId);
      await sleep(1500);
    }
  }
  return false;
}

/** The store tab, opened once and reused, left on the search page. */
async function storeTab() {
  const [existing] = await chrome.tabs.query({ url: "https://store.cedarville.edu/*" });
  if (existing) {
    await awaitComplete(existing.id);
    return existing;
  }
  const tab = await chrome.tabs.create({ url: STORE_PAGE, active: false });
  await awaitComplete(tab.id);
  return tab;
}

export async function syncBooklists({ term } = {}) {
  const config = await settings();
  const manifest = await engine("/v1/sync/manifest");
  const wanted = term || config.term || manifest.term;

  let plan = await engine("/v1/sync/start", { kind: "booklists", term: wanted, limit: 500 });
  const sweep = plan.sweep;
  let collected = 0;
  let tab = await storeTab();

  // Auth first: don't harvest until the WAF challenge is actually solved, or the
  // whole opening batch is wasted against the interstitial.
  if (!(await waitForStoreReady(tab.id))) {
    return setStatus({
      phase: "idle",
      term: wanted,
      collected,
      error:
        "the campus store would not clear its challenge — open it in a tab once, then sync again",
    });
  }

  while (plan.ids?.length) {
    const slice = plan.ids.slice(0, config.batch);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: harvestInPage,
      args: [slice, config.delayMs],
    });

    const { rows = [], challenged = false } = result?.result ?? {};
    if (rows.length) {
      const posted = await engine("/v1/sync/booklists", { sweep, term: wanted, rows });
      collected += rows.length;
      plan = posted;
      await setStatus({
        phase: "booklists",
        note: null,
        term: wanted,
        collected,
        queued: posted.remaining,
      });
      if (posted.done) break;
    }

    if (challenged) {
      // The token died mid-sweep. Reload to re-solve, and wait for the page to
      // actually come back before harvesting again rather than guessing at 4s.
      tab = await storeTab();
      if (!(await waitForStoreReady(tab.id))) {
        return setStatus({
          phase: "idle",
          term: wanted,
          collected,
          error: "the store stopped clearing its challenge mid-sweep",
        });
      }
    }
    if (!rows.length && !challenged) break; // nothing moving; stop rather than spin
  }

  return setStatus({ phase: "idle", booklistsAt: Date.now(), term: wanted, collected });
}

// ---- directory photos ----------------------------------------------------

/**
 * One student photo, fetched signed in. The directory lists it as a relative
 * campus-portal link that needs the session, so this is the courier's job too.
 * Returns the image base64-encoded, "miss" when the portal has no photo for
 * them, or null when the request itself failed and is worth another try later.
 */
async function fetchPhoto(url) {
  let response;
  try {
    response = await fetch(DIRECTORY + url, { credentials: "include", redirect: "manual" });
  } catch {
    return null; // network blip; leave them for the next run
  }
  if (response.type === "opaqueredirect" || response.redirected) throw new SignedOut();
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.startsWith("image/")) return "miss";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) return "miss";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { contentType, base64: btoa(binary) };
}

export async function syncPhotos() {
  const { batch, delayMs } = await settings();
  let plan = await engine("/v1/sync/start", { kind: "photos", limit: 500 });
  const sweep = plan.sweep;
  let stored = 0;

  while (plan.ids?.length) {
    const slice = plan.ids.slice(0, batch);
    const rows = [];
    const missed = [];
    for (const { id, url } of slice) {
      const photo = await fetchPhoto(url);
      if (photo === "miss") missed.push(String(id));
      else if (photo) rows.push({ id: String(id), ...photo });
      await setStatus({ phase: "photos", stored, queued: plan.remaining });
      if (delayMs) await sleep(delayMs);
    }

    // Every id that resolved — a photo or a confirmed miss — is recorded, so
    // the next plan moves past it. Only an all-blip batch makes no progress.
    if (!rows.length && !missed.length) break;
    const posted = await engine("/v1/sync/photos", { sweep, rows, missed });
    stored += posted.stored;
    plan = posted;
    await setStatus({ phase: "photos", note: null, stored, queued: posted.remaining });
    if (posted.done) break;
  }

  return setStatus({ phase: "idle", photosAt: Date.now(), stored });
}

// ---- the loop ------------------------------------------------------------

export async function syncAll({ refresh = false } = {}) {
  try {
    await setStatus({ phase: "directory", error: null, catalogError: null });
    // Auth first: get the SSO session live before the directory and catalog
    // lean on it, instead of failing the first query and recovering after.
    if (!(await ensureSelfService())) {
      return setStatus({ phase: "idle", error: "sign in to Self-Service, then sync again" });
    }
    await syncDirectory({ refresh });
    // The catalog failing is no reason to skip booklists, unless the session
    // is gone, in which case nothing else would work either.
    await syncCatalog().catch((error) => {
      if (error instanceof SignedOut) throw error;
      return setStatus({ catalogError: String(error.message ?? error) });
    });
    await syncBooklists();
    // Photos lean on the same Self-Service session, so they ride along at the
    // end once the directory is known.
    await syncPhotos();
    return setStatus({ phase: "idle", error: null });
  } catch (error) {
    if (error instanceof SignedOut) {
      await chrome.tabs.create({ url: DIRECTORY_PAGE, active: true });
      return setStatus({ phase: "idle", error: "sign in to Self-Service, then sync again" });
    }
    return setStatus({ phase: "idle", error: String(error.message ?? error) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handlers = {
    sync: () => syncAll({ refresh: message.refresh }),
    directory: () => syncDirectory({ refresh: message.refresh }),
    catalog: () => syncCatalog(),
    booklists: () => syncBooklists({ term: message.term }),
    photos: () => syncPhotos(),
    manifest: () => engine("/v1/sync/manifest"),
    status: async () => (await chrome.storage.local.get("status")).status ?? {},
  };
  const handler = handlers[message.type];
  if (!handler) return false;
  handler().then(
    (result) => respond({ ok: true, result }),
    (error) => respond({ ok: false, error: String(error.message ?? error) }),
  );
  return true; // the response is async
});

async function schedule() {
  const { everyHours, autoSync } = await settings();
  await chrome.alarms.clear(ALARM);
  if (autoSync) chrome.alarms.create(ALARM, { periodInMinutes: Math.max(everyHours, 1) * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) syncAll();
});
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.everyHours || changes.autoSync) schedule();
});

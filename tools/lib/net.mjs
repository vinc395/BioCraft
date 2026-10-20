// Small network helpers shared by the source fetchers (Node 18+, no dependencies).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Node gives each address 250 ms before trying the next; a slow IPv4 handshake (servers in
// Europe) then loses to an unreachable IPv6 route and every request times out.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

export const UA =
  "BioCanvas-library-builder/0.1 (+local scientific illustration library; polite fetcher)";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with retries and exponential backoff. Returns the Response (ok) or throws. */
export async function fetchRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { "user-agent": UA, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
      });
      if (res.ok) return res;
      if (res.status === 404) {
        const e = new Error(`404 ${url}`);
        e.status = 404;
        throw e;
      }
      lastErr = new Error(`HTTP ${res.status} ${url}`);
      lastErr.status = res.status;
    } catch (e) {
      if (e.status === 404) throw e;
      lastErr = e;
    }
    await sleep(800 * 2 ** i);
  }
  throw lastErr;
}

export async function fetchText(url, opts) {
  return (await fetchRetry(url, opts)).text();
}

export async function fetchJson(url, opts) {
  return (await fetchRetry(url, opts)).json();
}

/** Download url to file unless it already exists with non-zero size. */
export async function download(url, file, opts) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return "skip";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.from(await (await fetchRetry(url, opts)).arrayBuffer());
  const tmp = file + ".part";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return "ok";
}

/** Run async fn over items with a concurrency limit; reports progress every `every` items. */
export async function pool(items, limit, fn, { label = "items", every = 100 } = {}) {
  let next = 0, done = 0, failed = 0;
  const results = new Array(items.length);
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failed++;
        results[i] = { error: String(e.message || e) };
      }
      done++;
      if (done % every === 0 || done === items.length)
        console.log(`  ${label}: ${done}/${items.length}${failed ? ` (${failed} failed)` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}

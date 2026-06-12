/**
 * CORS proxy Cloudflare Worker
 *
 * 使い方: GET https://cors-proxy.r74.tech/?url=https%3A//pseudo-scp-jp.wdfiles.com/local--code/...
 *
 * 安全策:
 * - 許可ホストを ALLOWED_HOSTS に限定
 * - GET のみ
 * - 1MB 上限
 * - Cache-Control: 短時間キャッシュ
 *
 * 全 response (成功/エラー問わず) に Access-Control-Allow-Origin: * を必ず付与する。
 *
 * Deploy:
 *   cd workers/cors-proxy && bunx wrangler deploy
 *   または Cloudflare dashboard で worker を作って worker.js の内容を貼り付け、
 *   route を cors-proxy.r74.tech/* に紐付け。
 */

const ALLOWED_HOSTS = [
  "wdfiles.com",
  "wikidot.com",
  "scp-jp.wikidot.com",
  "pseudo-scp-jp.wikidot.com",
];
const MAX_BYTES = 1_000_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** 全 response に必ず CORS header を付ける helper。 */
function corsResponse(body, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

export default {
  /**
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsResponse(null, { status: 204 });
    }
    if (request.method !== "GET") {
      return corsResponse("Method not allowed", { status: 405 });
    }

    const target = url.searchParams.get("url");
    if (!target) {
      return corsResponse("Missing url query parameter", { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return corsResponse("Invalid url", { status: 400 });
    }
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      return corsResponse("Only http(s) is supported", { status: 400 });
    }
    if (!ALLOWED_HOSTS.some((h) => targetUrl.hostname === h || targetUrl.hostname.endsWith("." + h))) {
      return corsResponse("Host not allowed", { status: 403 });
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: "GET",
        redirect: "follow",
        cf: { cacheTtl: 60, cacheEverything: true },
      });
    } catch (err) {
      return corsResponse("Upstream fetch failed: " + (err && err.message), { status: 502 });
    }

    const text = await upstream.text();
    if (text.length > MAX_BYTES) {
      return corsResponse("Response too large", { status: 413 });
    }

    return corsResponse(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  },
};

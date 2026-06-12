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
 */

const ALLOWED_HOSTS = [
  "wdfiles.com",
  "wikidot.com",
];
const MAX_BYTES = 1_000_000;

export default {
  /**
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const target = url.searchParams.get("url");
    if (!target) {
      return new Response("Missing url query parameter", { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid url", { status: 400 });
    }
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
      return new Response("Only http(s) is supported", { status: 400 });
    }
    if (!ALLOWED_HOSTS.some((h) => targetUrl.hostname === h || targetUrl.hostname.endsWith("." + h))) {
      return new Response("Host not allowed", { status: 403 });
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: "GET",
        redirect: "follow",
        cf: { cacheTtl: 60, cacheEverything: true },
      });
    } catch (err) {
      return new Response("Upstream fetch failed: " + (err && err.message), { status: 502 });
    }

    const text = await upstream.text();
    if (text.length > MAX_BYTES) {
      return new Response("Response too large", { status: 413 });
    }

    return new Response(text, {
      status: upstream.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  },
};

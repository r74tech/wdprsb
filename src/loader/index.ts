import { documentToPage, type PageData } from "../engine";

// 読み込み元URLは利用者のブラウザからの任意GETになるため、安全側に倒す:
// - http(s)スキームのみ許可
// - credentials: "omit"（Cookie等を送らない）
// - 件数・サイズに上限
// - CORS/取得失敗はURLごとに明示エラー
const MAX_URLS = 20;
const MAX_BYTES = 1_000_000; // 1MB/件

export interface LoadError {
  url: string;
  message: string;
}

export interface LoadResult {
  pages: PageData[];
  errors: LoadError[];
}

/**
 * `?src=` を解釈してURL一覧を返す。
 * `?src=a,b,c`（カンマ区切り）と `?src=a&src=b`（繰り返し）の両方に対応。
 */
export function parseSrcParam(search: string): string[] {
  const urls = new URLSearchParams(search)
    .getAll("src")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return urls.slice(0, MAX_URLS);
}

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// frontmatterにpathnameが無い場合のフォールバック（URL末尾セグメントの拡張子を除いたもの）。
function fallbackPathname(url: string): string {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return segment.replace(/\.[^.]+$/, "") || "page";
  } catch {
    return "page";
  }
}

/** CORS proxy として動かす Cloudflare Worker のエンドポイント。 ?url=<encoded> を受ける。 */
const CORS_PROXY_URL = "https://cors-proxy.r74.tech/";

/**
 * 直接 fetch を試み, CORS error / network error なら自前 Cloudflare Worker proxy 経由で再 fetch する.
 * wdfiles.com 等 Access-Control-Allow-Origin を返さない wikidot host への対応.
 */
async function fetchTextWithCorsFallback(
  url: string,
): Promise<{ text: string; declaredLength: string | null }> {
  try {
    const res = await fetch(url, { credentials: "omit", redirect: "follow" });
    if (res.ok) {
      return { text: await res.text(), declaredLength: res.headers.get("content-length") };
    }
  } catch {
    // CORS / network → proxy にフォールバック
  }
  const proxied = `${CORS_PROXY_URL}?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxied, { credentials: "omit", redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} (proxy)`);
  return { text: await res.text(), declaredLength: res.headers.get("content-length") };
}

async function fetchPage(url: string): Promise<PageData> {
  if (!isAllowedUrl(url)) {
    throw new Error("http(s)のURLのみ読み込めます");
  }
  const { text, declaredLength } = await fetchTextWithCorsFallback(url);
  if (declaredLength && Number(declaredLength) > MAX_BYTES) {
    throw new Error("サイズ上限(1MB)を超えています");
  }
  if (text.length > MAX_BYTES) {
    throw new Error("サイズ上限(1MB)を超えています");
  }
  return documentToPage(text, fallbackPathname(url), url);
}

/** 複数URLを並列取得し、成功ページと失敗エラーを返す（順序は入力順を保持）。 */
export async function loadPagesFromUrls(urls: string[]): Promise<LoadResult> {
  const settled = await Promise.allSettled(urls.map(fetchPage));
  const pages: PageData[] = [];
  const errors: LoadError[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      pages.push(result.value);
    } else {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ url: urls[index]!, message });
    }
  });
  return { pages, errors };
}

/**
 * 内蔵includeライブラリを読み込む。
 *
 * `<BASE_URL>/lib/manifest.json` がファイル名の配列（["credit-start.ftml", ...]）を返し、
 * 各ファイルを並列でfetchして library:true 付きでstoreに加える。タブには出さず、
 * include解決と内部リンク解決のためだけに使う。manifest不在(404)はサイレント。
 */
export async function loadLibrary(): Promise<LoadResult> {
  // BASE_URLは"/"等の相対パスなので、window.location.originと結合して絶対URL化する。
  // fetchPage内のisAllowedUrlがhttp(s)のみ通すため、絶対URLでないと弾かれる。
  const base = new URL(import.meta.env.BASE_URL || "/", window.location.origin);
  const manifestUrl = new URL("lib/manifest.json", base).toString();
  let files: string[];
  try {
    const res = await fetch(manifestUrl, { credentials: "omit" });
    if (!res.ok) return { pages: [], errors: [] };
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return { pages: [], errors: [] };
    files = data.filter((value): value is string => typeof value === "string").slice(0, MAX_URLS);
  } catch {
    return { pages: [], errors: [] };
  }

  const settled = await Promise.allSettled(
    files.map(async (file) => {
      const url = new URL(`lib/${file}`, base).toString();
      const page = await fetchPage(url);
      return { ...page, library: true };
    }),
  );
  const pages: PageData[] = [];
  const errors: LoadError[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      pages.push(result.value);
    } else {
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ url: `lib/${files[index]!}`, message });
    }
  });
  return { pages, errors };
}

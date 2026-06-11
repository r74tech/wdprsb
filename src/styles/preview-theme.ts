// プレビューiframeに注入するテーマCSSのローダ群。
// 目的:
// 1. iframe内のスタイル適用(レンダリング)
// 2. 親(eruda)の Elements/Styles から cssRules を読めるようにする(同一originのinline化)
//
// base(cloudfront): CORSヘッダなし → 親fetchが弾かれるため public/theme/base.css に同梱。
// sigma-9: github.io(CORS可) → 親fetchして相対url() を絶対化してinline化。

const BASE_THEME_LOCAL_PATH = "theme/base.css";
// base.css 内の相対 url() を解決するための元の配信URL(cloudfront)。
// inline化するとiframe baseURIに対して相対解決されてしまうので、元の場所に向け直す。
const BASE_THEME_ORIGIN_URL =
  "https://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--theme/base/css/style.css";
export const SIGMA9_URL = "https://scp-jp.github.io/files/util/main/styles/sigma-9.min.css";

/**
 * CSSテキスト内の相対 url(...) と @import を baseUrl で絶対化する。
 * inline <style> として注入すると、相対パスは iframe の baseURI 基準で解釈されてしまうので
 * 元のホスト基準で解決し直す。
 */
function rewriteCssUrls(css: string, baseUrl: string): string {
  const resolve = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    if (/^(https?:|data:|blob:|\/\/)/i.test(trimmed)) return trimmed;
    try {
      return new URL(trimmed, baseUrl).toString();
    } catch {
      return trimmed;
    }
  };
  let out = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_m, quote, url) => {
    return `url(${quote}${resolve(url)}${quote})`;
  });
  out = out.replace(/@import\s+(['"])([^'"]+)\1/g, (_m, quote, url) => {
    return `@import ${quote}${resolve(url)}${quote}`;
  });
  return out;
}

let baseCache: Promise<string> | null = null;
let sigma9Cache: Promise<string> | null = null;

/**
 * base テーマ(同梱)を取得。中身は元cloudfrontのstyle.cssそのままで、
 * `url(../images/...)` 等の相対参照を多数含むので、元のURL基準で絶対化する。
 */
export function loadBaseCss(): Promise<string> {
  if (!baseCache) {
    const origin = new URL(import.meta.env.BASE_URL || "/", window.location.origin);
    const url = new URL(BASE_THEME_LOCAL_PATH, origin).toString();
    baseCache = fetch(url, { credentials: "omit" })
      .then((res) => (res.ok ? res.text() : ""))
      .then((css) => (css ? rewriteCssUrls(css, BASE_THEME_ORIGIN_URL) : ""))
      .catch(() => "");
  }
  return baseCache;
}

/** sigma-9のCSSテキストを取得し、相対パスを SIGMA9_URL 基準で絶対化して返す。 */
export function loadSigma9Css(): Promise<string> {
  if (!sigma9Cache) {
    sigma9Cache = fetch(SIGMA9_URL, { credentials: "omit" })
      .then((res) => (res.ok ? res.text() : ""))
      .then((css) => (css ? rewriteCssUrls(css, SIGMA9_URL) : ""))
      .catch(() => "");
  }
  return sigma9Cache;
}

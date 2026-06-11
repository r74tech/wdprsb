// Wikidotのページ名正規化。render側 RenderContext.normalizePageName と同じ規則に
// 揃えることで、PageStoreのキー / pageExists / include fetcher / 内部リンク捕捉が
// すべて同一の正規化結果で突き合わせられる。
export function normalizePageName(page: string): string {
  let normalized = page.toLowerCase();
  normalized = normalized.replace(/:\s+/g, ":");
  normalized = normalized.replace(/\s+/g, "-").trim();
  if (!normalized.startsWith("/")) {
    normalized = normalized.replace(/\//g, "-");
  }
  return normalized;
}

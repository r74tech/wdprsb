import { normalizePageName } from "./normalize";
import { parseDocument } from "./document";

export interface PageData {
  /** 正規化前の表示用pathname。 */
  pathname: string;
  tags?: string[];
  title?: string;
  /** 本文Wikitext。 */
  body: string;
  /** 読み込み元URL（ローカル編集ページはundefined）。 */
  source?: string;
  /** trueなら共通includeライブラリ用のページ。タブ非表示、include解決には参加する。 */
  library?: boolean;
}

/** 正規化済みpathnameをキーとするページ集合。 */
export type PageStore = Map<string, PageData>;

export function createStore(): PageStore {
  return new Map();
}

/** ページ配列から正規化キーのPageStoreを構築する。 */
export function buildStore(pages: PageData[]): PageStore {
  const store = createStore();
  for (const page of pages) {
    setPage(store, page);
  }
  return store;
}

export function setPage(store: PageStore, page: PageData): void {
  store.set(normalizePageName(page.pathname), page);
}

export function getPage(store: PageStore, pathname: string): PageData | undefined {
  return store.get(normalizePageName(pathname));
}

export function hasPage(store: PageStore, pathname: string): boolean {
  return store.has(normalizePageName(pathname));
}

/**
 * 1ファイル分のテキストをドキュメントとして解釈しPageDataへ変換する。
 * frontmatterにpathnameが無い場合はfallbackPathname（URL末尾等）を使う。
 */
export function documentToPage(
  text: string,
  fallbackPathname: string,
  source?: string,
): PageData {
  const doc = parseDocument(text);
  return {
    pathname: doc.pathname || fallbackPathname,
    tags: doc.tags,
    title: doc.title,
    body: doc.body,
    source,
  };
}

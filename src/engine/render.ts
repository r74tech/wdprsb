import {
  parse,
  resolveIncludes,
  extractDataRequirements,
  resolveModules,
  type IncludeFetcher,
} from "@wdprlib/parser";
import { renderToHtml, createSettings, type WikitextSettings } from "@wdprlib/render";
import { normalizePageName } from "./normalize";
import { getPage, hasPage, type PageStore } from "./store";

// pageモード: include/module/toc有効 + allowStyleElements=true で [[module CSS]] の
// <style> をhtml出力にinlineさせる。プレビューはiframeに隔離するのでSPA全体へは漏れない。
// allowHtmlBlocks=falseで [[html]] ブロックを無効化（静的ホスティングでiframeのsrc配信不可のため）。
const SETTINGS: WikitextSettings = {
  ...createSettings("page"),
  allowHtmlBlocks: false,
};

export interface RenderResult {
  html: string;
  error?: string;
}

/**
 * 指定ページをWikitext→HTMLへレンダリングする。
 * ページ間 [[include]] はstore内のページに限定して解決し、外部fetchはしない。
 * [[module CSS]]等のモジュールは resolveModules で解決し、styleはhtmlにinlineされる。
 */
export async function renderPage(store: PageStore, pathname: string): Promise<RenderResult> {
  const page = getPage(store, pathname);
  if (!page) {
    return { html: "", error: `ページ "${pathname}" が見つかりません` };
  }

  try {
    const fetcher: IncludeFetcher = (ref) => {
      // :site:page のsiteは無視し、page部分でstoreを引く。
      // 複数サイト由来のページを束ねたときにクロスサイトincludeも解決できる。
      // fetcherはローカルstore限定なので外部取得は一切しない（安全）。
      const target = getPage(store, ref.page);
      return target ? target.body : null;
    };

    const expanded = resolveIncludes(page.body, fetcher, { settings: SETTINGS });
    const { ast } = parse(expanded, { settings: SETTINGS });

    const { requirements, compiledListPagesTemplates, compiledListUsersTemplates } =
      extractDataRequirements(ast);

    const resolved = await resolveModules(
      ast,
      {
        getPageTags: () => page.tags ?? [],
        // sandboxはDBを持たないのでListPagesは空を返す（site情報のみダミー）。
        fetchListPages: () => ({
          pages: [],
          totalCount: 0,
          site: { title: page.title ?? page.pathname, name: "sandbox", domain: "localhost" },
        }),
      },
      {
        parse: (input: string) => parse(input, { settings: SETTINGS }).ast,
        compiledListPagesTemplates,
        compiledListUsersTemplates,
        requirements,
      },
    );

    const html = renderToHtml(resolved, {
      settings: SETTINGS,
      footnotes: resolved.footnotes,
      page: {
        pageName: page.pathname,
        tags: page.tags,
        pageExists: (p) => hasPage(store, p),
      },
    });
    return { html };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { html: "", error: message };
  }
}

export { normalizePageName };

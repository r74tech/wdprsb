import { normalizePageName, type PageData } from "../engine";

interface PageTabsProps {
  pages: PageData[];
  /** 正規化済みの選択中pathname。 */
  active: string;
  onSelect: (normalizedPathname: string) => void;
}

export function PageTabs({ pages, active, onSelect }: PageTabsProps) {
  return (
    <div className="page-tabs" role="tablist">
      {pages.map((page) => {
        const key = normalizePageName(page.pathname);
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={isActive ? "page-tab active" : "page-tab"}
            onClick={() => onSelect(key)}
            title={page.pathname}
          >
            {page.title ?? page.pathname}
          </button>
        );
      })}
    </div>
  );
}

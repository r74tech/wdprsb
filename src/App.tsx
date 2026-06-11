import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "./components/Editor";
import { Preview } from "./components/Preview";
import { PageTabs } from "./components/PageTabs";
import {
  buildStore,
  renderPage,
  normalizePageName,
  type PageData,
  type RenderResult,
} from "./engine";
import { parseSrcParam, loadPagesFromUrls, loadLibrary, type LoadError } from "./loader";
import startBody from "./samples/start.ftml?raw";
import demoBody from "./samples/demo.ftml?raw";

type Collapsed = "none" | "editor" | "preview";

const DEFAULT_PAGES: PageData[] = [
  { pathname: "start", title: "サンプル", body: startBody },
  { pathname: "demo", title: "demo", tags: ["sample"], body: demoBody },
];

export default function App() {
  // ?src= が指定されていれば初期サンプルではなくリモート読み込みを行う。
  const initialUrls = useMemo(() => parseSrcParam(window.location.search), []);
  // ?devtools=1 のときだけ iframe 内に eruda を注入する(allow-scripts併用)。
  // セキュリティ上の影響が大きいのでマウント時に確認モーダルを出し、承諾後に有効化。
  const devtoolsRequested = useMemo(
    () => new URLSearchParams(window.location.search).get("devtools") === "1",
    [],
  );
  const [devtoolsEnabled, setDevtoolsEnabled] = useState(false);
  const [showDevtoolsConfirm, setShowDevtoolsConfirm] = useState(false);
  useEffect(() => {
    if (devtoolsRequested && !devtoolsEnabled) setShowDevtoolsConfirm(true);
  }, [devtoolsRequested, devtoolsEnabled]);
  const [pages, setPages] = useState<PageData[]>(initialUrls.length > 0 ? [] : DEFAULT_PAGES);
  const [active, setActive] = useState<string>(
    initialUrls.length > 0 ? "" : normalizePageName(DEFAULT_PAGES[0]!.pathname),
  );
  const [loading, setLoading] = useState(initialUrls.length > 0);
  const [loadErrors, setLoadErrors] = useState<LoadError[]>([]);
  const [result, setResult] = useState<RenderResult>({ html: "" });
  const [collapsed, setCollapsed] = useState<Collapsed>("none");
  const [ratio, setRatio] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const store = useMemo(() => buildStore(pages), [pages]);
  const activePage = pages.find((page) => normalizePageName(page.pathname) === active);
  // ライブラリページはタブに出さない（include解決と内部リンク解決にのみ参加）。
  const visiblePages = useMemo(() => pages.filter((page) => !page.library), [pages]);
  const knownPages = useMemo(
    () => new Set(pages.map((page) => normalizePageName(page.pathname))),
    [pages],
  );

  // プレビュー内の内部リンククリック: 読み込み済みページなら切替、無ければ何もしない。
  const handleNavigate = useCallback(
    (pathname: string): boolean => {
      const key = normalizePageName(pathname);
      if (knownPages.has(key)) {
        setActive(key);
        return true;
      }
      return false;
    },
    [knownPages],
  );

  // 内蔵ライブラリ(public/lib/)と?src=の両方をマウント時に並列読み込み。
  // ライブラリページはタブ非表示・include解決と内部リンク解決にのみ参加する。
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      initialUrls.length > 0
        ? loadPagesFromUrls(initialUrls)
        : Promise.resolve({ pages: [], errors: [] }),
      loadLibrary(),
    ]).then(([src, lib]) => {
      if (cancelled) return;
      setLoading(false);
      setLoadErrors([...src.errors, ...lib.errors]);
      const userPages = src.pages.length > 0 ? src.pages : initialUrls.length === 0 ? DEFAULT_PAGES : [];
      setPages([...userPages, ...lib.pages]);
      if (src.pages.length > 0) {
        setActive(normalizePageName(src.pages[0]!.pathname));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialUrls]);

  // store/activeの変化をデバウンスしてレンダリング（編集中の連続parseを抑制）。
  // renderPageはmodule解決のため非同期。古い結果で上書きしないようcancelガードを置く。
  useEffect(() => {
    if (pages.length === 0) {
      setResult({ html: "", error: loading ? "読み込み中…" : "表示するページがありません" });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void renderPage(store, active).then((next) => {
        if (!cancelled) setResult(next);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [store, active, pages.length, loading]);

  const handleChange = (value: string) => {
    setPages((prev) =>
      prev.map((page) =>
        normalizePageName(page.pathname) === active ? { ...page, body: value } : page,
      ),
    );
  };

  const startDrag = useCallback(() => {
    const onMove = (e: MouseEvent) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      setRatio(Math.min(0.85, Math.max(0.15, (e.clientX - rect.left) / rect.width)));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // iframe/CodeMirrorがマウスイベントを奪うとwindowのmousemoveが届かなくなる。
    // ドラッグ中はworkspaceに.draggingを付け、CSSでiframeとエディタのpointer-eventsを止める。
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const editorStyle =
    collapsed === "none" ? { flexBasis: `${ratio * 100}%`, flexGrow: 0 } : { flex: 1 };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          wdpr<span className="brand-accent">sandbox</span>
        </div>
        <div className="topbar-meta">Wikidot live preview</div>
        <button
          type="button"
          className={devtoolsEnabled ? "devtools-toggle active" : "devtools-toggle"}
          onClick={() => {
            if (devtoolsEnabled) {
              setDevtoolsEnabled(false);
            } else {
              setShowDevtoolsConfirm(true);
            }
          }}
          title="DevToolsモードを切替"
        >
          DevTools {devtoolsEnabled ? "ON" : "OFF"}
        </button>
      </header>

      {showDevtoolsConfirm && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-box">
            <div className="modal-title">DevToolsを有効にしますか?</div>
            <div className="modal-body">
              プレビューの中身を詳しく調べられるDevToolsを起動します。
              <br />
              <br />
              これを有効にすると、プレビューに表示しているWikidotページに含まれる
              JavaScriptがブラウザ上で実行されるようになります。
              信頼できないURLを<code>?src=</code>で開いている場合、
              悪意のあるコードが動いてしまう可能性があります。
              <br />
              <br />
              <strong>信頼できる内容を確認するときだけ有効にしてください。</strong>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn modal-btn-cancel"
                onClick={() => {
                  setShowDevtoolsConfirm(false);
                  const url = new URL(window.location.href);
                  url.searchParams.delete("devtools");
                  window.history.replaceState({}, "", url);
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="modal-btn modal-btn-confirm"
                onClick={() => {
                  setDevtoolsEnabled(true);
                  setShowDevtoolsConfirm(false);
                }}
              >
                有効化する
              </button>
            </div>
          </div>
        </div>
      )}

      {loadErrors.length > 0 && (
        <div className="load-errors">
          {loadErrors.map((err) => (
            <span key={err.url} className="load-error">
              読み込み失敗: {err.url}（{err.message}）
            </span>
          ))}
        </div>
      )}

      <div className={dragging ? "workspace dragging" : "workspace"} ref={workspaceRef}>
        {collapsed === "editor" ? (
          <button
            type="button"
            className="collapsed-strip"
            onClick={() => setCollapsed("none")}
            title="エディタを開く"
          >
            <span className="collapsed-label">Wikidot</span>
          </button>
        ) : (
          <section className="panel" style={editorStyle}>
            <div className="panel-head">
              <PageTabs pages={visiblePages} active={active} onSelect={setActive} />
              <div className="panel-head-actions">
                <span className="lang-chip">wikidot</span>
                <button
                  type="button"
                  className="collapse-btn"
                  title="プレビューを隠す"
                  onClick={() => setCollapsed("preview")}
                >
                  ⟩
                </button>
              </div>
            </div>
            <div className="panel-body">
              <Editor value={activePage?.body ?? ""} onChange={handleChange} />
            </div>
          </section>
        )}

        {collapsed === "none" && (
          <div
            className="split-bar"
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startDrag}
          />
        )}

        {collapsed === "preview" ? (
          <button
            type="button"
            className="collapsed-strip"
            onClick={() => setCollapsed("none")}
            title="プレビューを開く"
          >
            <span className="collapsed-label">Result</span>
          </button>
        ) : (
          <section className="panel" style={{ flex: 1 }}>
            <div className="panel-head">
              <span className="panel-title">Result</span>
              <div className="panel-head-actions">
                <span className="panel-path">{activePage?.pathname ?? ""}</span>
                <button
                  type="button"
                  className="collapse-btn"
                  title="コードを隠す"
                  onClick={() => setCollapsed("editor")}
                >
                  ⟨
                </button>
              </div>
            </div>
            <div className="panel-body panel-body-preview">
              <Preview
                html={result.html}
                error={result.error}
                onNavigate={handleNavigate}
                devtools={devtoolsEnabled}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

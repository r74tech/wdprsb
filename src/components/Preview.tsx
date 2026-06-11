import { useEffect, useRef, useState } from "react";
import { initWdprRuntime, type WdprRuntime } from "@wdprlib/runtime";
import { buildShellDocument } from "./wikidotPage";
import { loadBaseCss, loadSigma9Css } from "../styles/preview-theme";

interface PreviewProps {
  html: string;
  error?: string;
  /** 内部ページリンクのクリック時に呼ばれる。遷移できた場合true。 */
  onNavigate: (pathname: string) => boolean;
  /** trueのときiframeに allow-scripts + eruda 注入。確認モーダル通過後にのみ渡される。 */
  devtools?: boolean;
}

// プレビューはiframeに描画する。理由:
// - iframeは本物の<html>/<body>/:rootを持つ別ドキュメントなので、テーマCSS・@import・
//   ユーザーの[[module CSS]]がそのままネイティブに機能する（Shadow DOMでは:rootが効かない）。
// - 完全に隔離されSPA全体へスタイルが漏れない。ページ移動でも残留しない。
// - srcdocは親オリジンを継承する同一オリジンなので、親から contentDocument を操作できる。
//
// srcdocはテーマを読むだけの最小シェル。Wikidotの完全なDOM骨格は読み込み後に一度だけ
// JSで注入し、以降は本文(#page-content)だけ更新する（iframe再読込・テーマ再取得を避ける）。
const SHELL_DOCUMENT = buildShellDocument();

// eruda は _curNode/_$detail などのprivateフィールドに依存する自前pluginを差すため、
// 動作確認済みの 3.4.3 に固定する (上流の DOM 構造変更で壊れないように)。
const ERUDA_SRC = "https://cdn.jsdelivr.net/npm/eruda@3.4.3";
// 自前 inspector の bundle (predev/prebuildでbun build される)。
const INSPECTOR_SRC = `${import.meta.env.BASE_URL}devtools/style-inspector.js`;

export function Preview({ html, error, onNavigate, devtools = false }: PreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const runtimeRef = useRef<WdprRuntime | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  // devtoolsの切替はsandbox属性の差し替えで、新しいsandboxを反映するにはiframeのリロードが要る。
  // 変わったらloadedを落として、新しいload eventで再初期化する。
  useEffect(() => {
    setLoaded(false);
    runtimeRef.current?.destroy();
    runtimeRef.current = undefined;
  }, [devtools]);

  // クリックリスナーは#page-contentに張る。最新のonNavigateはrefで参照する。
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // 内部リンクのクリック処理。 iframe contentDocument が iOS 等で再生成されたとき
  // にも handleLoad 経由で attach するため、 useRef で安定したハンドラを保持する。
  const onClickRef = useRef<(event: MouseEvent) => void>(() => {});
  onClickRef.current = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (target?.closest(".wdpr-credit-fader")) {
      event.preventDefault();
      const win = iframeRef.current?.contentWindow;
      if (win) win.location.hash = "";
      return;
    }
    const anchor = target?.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href === "") return;
    if (href.startsWith("#")) {
      // srcdoc iframeでは <a href="#x"> のベースURIが親URLになり、踏むとiframeが
      // 親SPAを読み込みに行って本文が消える。 既定動作を止め、 iframeのlocation.hashを
      // 直接書き換えてfragment-only navigationにする。
      event.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const win = iframeRef.current?.contentWindow;
      if (win) win.location.hash = id ? `#${id}` : "";
      return;
    }
    if (href.startsWith("javascript:")) {
      event.preventDefault();
      return;
    }
    if (href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      event.preventDefault();
      window.open((anchor as HTMLAnchorElement).href, "_blank", "noopener,noreferrer");
      return;
    }
    // 内部ページリンク (/page または相対)。 iframe 内 navigation を必ず止める
    // (止めないと iframe の中に親SPAが読み込まれて入れ子になる)。
    event.preventDefault();
    event.stopPropagation();
    const path = decodeURIComponent((href.replace(/^\//, "").split(/[?#]/)[0] ?? ""));
    if (path) onNavigateRef.current(path);
  };

  const handleLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (doc?.body) {
      // SKELETON は srcdoc 内に既に含まれている (wikidotPage.ts:buildShellDocument)。
      // iOS Safari の load event 再発火に備え、 ここでは innerHTML を触らない。
      // テーマCSS注入は重複チェックで冪等にする。
      void Promise.all([loadBaseCss(), loadSigma9Css()]).then(([baseCss, sigmaCss]) => {
        const target = iframeRef.current?.contentDocument;
        if (!target) return;
        if (target.querySelector('style[data-wdpr-theme="base"]')) return;
        if (baseCss) {
          const s = target.createElement("style");
          s.dataset.wdprTheme = "base";
          s.textContent = baseCss;
          target.head.appendChild(s);
        }
        if (sigmaCss) {
          const s = target.createElement("style");
          s.dataset.wdprTheme = "sigma-9";
          s.textContent = sigmaCss;
          target.head.appendChild(s);
        }
      });

      if (devtools) {
        // devtoolsモードのみ: eruda をiframeに注入し起動(Elements/Sourcesのみ)。
        const erudaScript = doc.createElement("script");
        erudaScript.src = ERUDA_SRC;
        erudaScript.onload = () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const win = iframeRef.current?.contentWindow as any;
            if (!win) return;
            // 過去の使用で保存された位置等をクリアし、既定の右下に戻す。
            try {
              const ls = win.localStorage;
              for (let i = ls.length - 1; i >= 0; i--) {
                const key = ls.key(i);
                if (key && key.toLowerCase().includes("eruda")) ls.removeItem(key);
              }
            } catch {
              // localStorage参照不可は無視
            }
            win.eruda?.init({ tool: ["elements", "sources"] });
            // 自前 styleInspector を後追いで注入。eruda起動済みの状態で install() を呼ぶ。
            const ins = doc.createElement("script");
            ins.src = INSPECTOR_SRC;
            ins.onload = () => {
              try {
                win.__wdprStyleInspector?.install?.(win);
              } catch {
                // inspector 起動失敗もプレビューは妨げない
              }
            };
            doc.head.appendChild(ins);
          } catch {
            // 初期化失敗でもプレビューは妨げない
          }
        };
        doc.body.appendChild(erudaScript);
      }

      // click handler を pageContent と body 両方に capture phase で attach。
      // iOS Safari は iframe が再 load されると contentDocument が新しくなるので、
      // load のたびに dataset guard で 1回だけ attach する。 capture + stopPropagation で
      // iframe 内の他 listener (eruda の要素選択等) より先に拾い、 入れ子 navigation を
      // 確実に止める。 body と pageContent 両方に張るのは、 SKELETON 内の他要素のリンクも
      // 取りこぼさないため。
      const dispatchClick = (event: MouseEvent) => onClickRef.current(event);
      const attachClick = (el: HTMLElement | null) => {
        if (!el || el.dataset.wdprClickAttached === "1") return;
        el.dataset.wdprClickAttached = "1";
        el.addEventListener("click", dispatchClick, { capture: true });
      };
      attachClick(doc.body);
      attachClick(doc.getElementById("page-content"));
    }
    setLoaded(true);
  };

  useEffect(() => {
    if (!loaded) return;
    const doc = iframeRef.current?.contentDocument;
    const pageContent = doc?.getElementById("page-content");
    if (!doc || !pageContent) return;

    runtimeRef.current?.destroy();
    runtimeRef.current = undefined;

    if (error) {
      pageContent.replaceChildren();
      const errorEl = doc.createElement("div");
      errorEl.className = "wdpr-preview-error";
      errorEl.textContent = error;
      pageContent.appendChild(errorEl);
      return;
    }

    // renderToHtmlの出力はwdpr側でサニタイズ済み。iframe(allow-same-originのみ)で隔離もしている。
    pageContent.innerHTML = html;

    // scp-jp.github.io の credit backmodule iframe は fader クリックで親URLのhashを消すJSだが、
    // sandboxでscriptを止めているので動かない。divに差し替え、親側のclick handler
    // (`.wdpr-credit-fader`) で同等の「hashを空にする」処理を行わせる。
    pageContent.querySelectorAll('iframe[src*="credit/backmodule/"]').forEach((node) => {
      const fader = doc.createElement("div");
      fader.className = "wdpr-credit-fader";
      fader.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;cursor:pointer;";
      node.replaceWith(fader);
    });

    try {
      runtimeRef.current = initWdprRuntime({ root: pageContent });
    } catch {
      // runtime初期化失敗はプレビュー表示自体を妨げない
    }
  }, [html, error, loaded]);

  useEffect(() => () => runtimeRef.current?.destroy(), []);

  // devtools オフ時は sandbox 属性を一切付けない (通常 iframe = 親 origin 継承)。
  // iOS Safari (WebKit) は srcdoc + sandbox="allow-same-origin" の組み合わせで
  // iframe を opaque origin として扱う既知の挙動があり、 親から contentDocument の
  // DOM 操作 (innerHTML / appendChild) が拒否されて真っ白になる事象を確認。
  // sandbox 属性なしでも、 wdpr の render 出力は allowHtmlBlocks=false で <script>/<form>
  // を含まない sanitize 済み HTML なので XSS リスクは限定的、 <a> クリックは Preview の
  // capture リスナーで preventDefault 済み。
  // devtools オン時は eruda 起動のため allow-scripts を付与する必要があり、
  // allow-same-origin と併用すると仕様上 sandbox がほぼ無効化されるが、 ユーザーが
  // 明示的に承諾済みのため許容する。
  const sandboxAttr = devtools ? "allow-same-origin allow-scripts" : undefined;
  return (
    <iframe
      // keyを切替えると React がiframe要素を作り直し、新しい sandbox 属性でロードされる。
      key={devtools ? "preview-with-scripts" : "preview-safe"}
      ref={iframeRef}
      className="wdpr-preview-frame"
      title="preview"
      srcDoc={SHELL_DOCUMENT}
      sandbox={sandboxAttr}
      onLoad={handleLoad}
    />
  );
}

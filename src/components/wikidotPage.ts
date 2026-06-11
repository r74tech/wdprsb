// テーマCSS(base/sigma-9)は親から fetch して inline 注入する(preview-theme.ts)。
// shellでは @import せず、空の <style> プレースホルダだけ用意する。

// プレビューiframe用。
// srcdocは「テーマを読むだけの最小シェル」(空の body#html-body)。
// Wikidotの完全なDOM骨格(WIKIDOT_SKELETON)は読み込み後にJSで body へ注入する。
// 本文は #page-content に差し込み、runtimeも #page-content をrootに張る。
//
// iframeなので本物の <html>/<body>/:root が存在し、テーマ・@import・module CSSが
// そのまま機能する（Shadow DOMでは :root が効かないため不可）。
// 骨格は実サイト(scp-jp.wikidot.com)と wdpr の wdmock-cf の構造に準拠。

/** body#html-body に注入する完全なWikidotページ骨格（#page-contentは空）。 */
export const WIKIDOT_SKELETON = `
<div id="skrollr-body">
  <a name="page-top"></a>
  <div id="container-wrap-wrap">
    <div id="container-wrap">
      <div id="container">
        <div id="header">
          <h1><a href="#"><span>wdpr sandbox</span></a></h1>
          <h2><span>Wikidot live preview</span></h2>
          <div id="search-top-box" class="form-search">
            <form id="search-top-box-form" action="#" class="input-append">
              <input id="search-top-box-input" class="text empty search-query" type="text" name="query" value="" />
              <input class="button btn" type="button" name="search" value="Search" />
            </form>
          </div>
          <div id="top-bar"></div>
          <div id="login-status"><span></span></div>
          <div id="header-extra-div-1"><span></span></div>
          <div id="header-extra-div-2"><span></span></div>
          <div id="header-extra-div-3"><span></span></div>
        </div>
        <div id="content-wrap">
          <div id="side-bar">
            <div id="side-bar-actions"></div>
          </div>
          <div id="main-content">
            <div id="action-area-top"></div>
            <div id="page-title"></div>
            <div id="page-content"></div>
            <div id="page-info-break"></div>
            <div id="page-options-container">
              <div id="page-info"></div>
              <div id="page-options-bottom" class="page-options-bottom"></div>
              <div id="page-options-bottom-2" class="page-options-bottom-2"></div>
            </div>
            <div id="page-options-area-bottom"></div>
            <div id="action-area"></div>
          </div>
        </div>
        <div id="footer">
          <div class="options"></div>
        </div>
        <div id="license-area" class="license-area"></div>
        <div id="extrac-div-1"></div>
        <div id="extrac-div-2"></div>
        <div id="extrac-div-3"></div>
      </div>
    </div>
    <div id="extra-div-1"><span></span></div>
    <div id="extra-div-2"><span></span></div>
    <div id="extra-div-3"><span></span></div>
    <div id="extra-div-4"><span></span></div>
    <div id="extra-div-5"><span></span></div>
    <div id="extra-div-6"><span></span></div>
  </div>
</div>
`;

export function buildShellDocument(): string {
  // SKELETON を srcdoc 内に直接含める。 iOS Safari は srcdoc + sandbox iframe で
  // load event が再発火することがあり、 JS で body.innerHTML を上書きする方式だと
  // 既存の page-content が消えて真っ白になる。 srcdoc に最初から含めておけば
  // 再 load 時も skeleton が確実に存在する。
  return (
    "<!doctype html>" +
    '<html lang="ja"><head><meta charset="utf-8">' +
    `</head><body id="html-body">${WIKIDOT_SKELETON}</body></html>`
  );
}

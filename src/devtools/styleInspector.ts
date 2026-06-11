// iframe 内 (eruda 起動後) で動く本体スクリプト。
// eruda Elements タブの Styles セクションを丸ごと差し替え、Chrome DevTools 風に再描画する。
// 同タブの Attributes 表示にもインライン編集機能を仕込む。
//
// 配置: iife bundle として public/devtools/style-inspector.js に出す (bun build)。
// Preview.tsx から script src で読み込み、`window.__wdprStyleInspector.install(window)` を呼ぶ。

import {
  collectDeclarations,
  compareSpecificity,
  computeActiveDeclarations,
  getInlineStyle,
  getMatchedRules,
  type EditableStyleSource,
  type MarkedDeclaration,
  type MatchedRule,
} from "./cssMatcher";
import { collectInheritedSections, isInheritedProperty } from "./inheritedRules";
// 注意: pseudo強制機能は対象要素に強制クラスを足す副作用があるため、現在は無効化している。
// 将来再導入する場合は initPseudoForcer を import する。
import {
  addAttribute,
  addStyleProperty,
  editAttribute,
  editStyleProperty,
  makeEditable,
  removeAttributeOn,
  removeStyleProperty,
  renameStyleProperty,
} from "./editor";

interface ErudaElements {
  _curNode?: Element | Node;
  // licia Emitter mixin
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  off: (event: string, cb: (...args: unknown[]) => void) => void;
  // 本家 Elements が抱える Detail インスタンス。 Computed Style filter を切るのに使う。
  _detail?: {
    config?: { set: (key: string, value: unknown) => void };
    _rmDefComputedStyle?: boolean;
  };
}

interface ErudaGlobal {
  get: (name: string) => unknown;
}

interface InspectorWindow extends Window {
  eruda?: ErudaGlobal;
  __wdprStyleInspector?: { install: (win: Window) => void };
}

// Chrome DevTools 風の色とレイアウト。
// 背景はerudaの暗いテーマに馴染ませつつ、selector/property/value で色分け。
// 現アクティブな install の renderInspector を保持する。
// add/remove などCSS rule 系の変更は eruda の MutationObserver が拾わないため、
// このリファレンス越しに明示的に再描画を呼ぶ。
let activeRender: (() => void) | null = null;
function triggerRerender(): void {
  activeRender?.();
}

// declaration を checkbox で一時無効化したときの「元値」キャッシュ。
// key = CSSStyleDeclaration (cssRule.style or element.style)。
// 値: property name → { value, priority }。
//
// IIFE がiframe再 load で多重実行されるとmodule scope が新しくなり, disabledCache が
// リセットされて 退避済み declarations が消える事象 (= checkbox外し後にruleが消える)
// を防ぐため, iframe window グローバルに格納して install 多重起動でも保持する。
type DisabledInfo = { value: string; priority: "" | "important" };
type DisabledCacheStore = WeakMap<CSSStyleDeclaration, Map<string, DisabledInfo>>;
type StableOrderCacheStore = WeakMap<CSSStyleDeclaration, Map<string, number>>;
type CacheHolder = {
  __wdprDisabledCache?: DisabledCacheStore;
  __wdprStableOrderCache?: StableOrderCacheStore;
};

function getCacheHolder(): CacheHolder {
  // iframe window のグローバルに格納して install 多重起動でも cache を保持する。
  // 取得失敗 (window 不在/strict frozen) 時は module scope の fallback object に保存。
  if (typeof window !== "undefined") return window as unknown as CacheHolder;
  return moduleFallbackHolder;
}
const moduleFallbackHolder: CacheHolder = {};

function getDisabledMap(style: CSSStyleDeclaration): Map<string, DisabledInfo> {
  const h = getCacheHolder();
  if (!h.__wdprDisabledCache) h.__wdprDisabledCache = new WeakMap();
  let m = h.__wdprDisabledCache.get(style);
  if (!m) {
    m = new Map();
    h.__wdprDisabledCache.set(style, m);
  }
  return m;
}

// declaration の表示順を「初出時の出現順」 で固定するための stable order。
// declarationOrder は collect 毎に再振りされるので、 checkbox で remove → 再 collect すると
// 順番が詰まって位置が動いてしまう。 property名 → 初出 order を覚えておけば
// uncheck/check で位置が変わらない。
function getStableOrderCache(): StableOrderCacheStore {
  const h = getCacheHolder();
  if (!h.__wdprStableOrderCache) h.__wdprStableOrderCache = new WeakMap();
  return h.__wdprStableOrderCache;
}

function getStableOrder(style: CSSStyleDeclaration, property: string): number {
  const cache = getStableOrderCache();
  let m = cache.get(style);
  if (!m) {
    m = new Map();
    cache.set(style, m);
  }
  const existing = m.get(property);
  if (existing !== undefined) return existing;
  // 新規 property は既存の最大 + 1 (新規追加分は末尾に積む)
  let max = 0;
  for (const v of m.values()) if (v > max) max = v;
  const next = max + 1;
  m.set(property, next);
  return next;
}

/** 既知 property 群 を cssText の出現順で stable order に prime する。 */
function primeStableOrder(style: CSSStyleDeclaration, propertiesInOrder: string[]): void {
  const cache = getStableOrderCache();
  let m = cache.get(style);
  if (!m) {
    m = new Map();
    cache.set(style, m);
  }
  let max = 0;
  for (const v of m.values()) if (v > max) max = v;
  for (const p of propertiesInOrder) {
    if (!m.has(p)) {
      max++;
      m.set(p, max);
    }
  }
}

const INSPECTOR_STYLE = `
.wdpr-inspector-root { font: inherit; color: inherit; }
.wdpr-inspector-section + .wdpr-inspector-section {
  margin-top: 4px; border-top: 1px solid rgba(127,127,127,0.18);
}
.wdpr-inspector-section-title {
  font-size: 10px; padding: 4px 10px 2px; opacity: 0.5; letter-spacing: 0.04em;
}
.wdpr-inspector-rule-block {
  padding: 4px 10px 4px 10px;
  border-top: 1px dotted rgba(127,127,127,0.18);
  position: relative;
}
.wdpr-inspector-rule-block:first-of-type { border-top: none; }
.wdpr-inspector-selector {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
  color: #d290ff;
}
.wdpr-inspector-source {
  float: right; font-size: 10px; opacity: 0.45; color: inherit; font-family: inherit;
}
.wdpr-inspector-decl {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding-left: 4px;
  line-height: 1.55;
  white-space: nowrap;
  position: relative;
}
.wdpr-inspector-cb {
  margin: 0 4px 0 0;
  width: 11px; height: 11px;
  vertical-align: middle;
  cursor: pointer;
  accent-color: #6fa8dc;
  opacity: 0;
  transition: opacity 100ms;
}
.wdpr-inspector-decl:hover .wdpr-inspector-cb,
.wdpr-inspector-cb:not(:checked) { opacity: 1; }
.wdpr-inspector-decl-disabled { text-decoration: line-through; opacity: 0.55; }
.wdpr-inspector-decl-inactive { text-decoration: line-through; opacity: 0.35; }
.wdpr-inspector-prop { color: #c97777; cursor: text; }
.wdpr-inspector-val { color: #8db1d1; cursor: text; }
.wdpr-inspector-prop[contenteditable], .wdpr-inspector-val[contenteditable] {
  outline: 1px solid rgba(0,122,255,0.55); padding: 0 2px; border-radius: 2px;
  background: rgba(0,122,255,0.06);
}
.wdpr-inspector-skip-notice {
  padding: 4px 10px; font-size: 10px; opacity: 0.5; font-style: italic;
}
.wdpr-inspector-empty { padding: 4px 10px; font-size: 10px; opacity: 0.45; }
.wdpr-inspector-btn {
  appearance: none;
  border: none; background: transparent;
  width: 14px; height: 14px; line-height: 12px; text-align: center;
  cursor: pointer; padding: 0;
  font: inherit; font-size: 10px; color: inherit; opacity: 0;
  transition: opacity 100ms;
}
.wdpr-inspector-decl:hover .wdpr-inspector-btn,
.wdpr-inspector-rule-block:hover .wdpr-inspector-add-prop .wdpr-inspector-btn,
.wdpr-inspector-add-attr:hover .wdpr-inspector-btn {
  opacity: 0.6;
}
.wdpr-inspector-btn:hover { opacity: 1 !important; }
.wdpr-inspector-add-prop {
  padding-left: 14px; font-family: ui-monospace, monospace; font-size: 11px;
  min-height: 14px;
}
.wdpr-inspector-add-attr { padding: 2px 10px; font-size: 11px; min-height: 14px; }
`;

function install(win: Window): void {
  const iwin = win as InspectorWindow;
  const doc = win.document;
  const eruda = iwin.eruda;
  if (!eruda) return;

  // eruda が完全に init される前に呼ばれた場合のリトライ。
  const tryStart = (attempts: number): void => {
    const elementsTool = eruda.get("elements") as ErudaElements | undefined;
    if (!elementsTool) {
      if (attempts <= 0) return;
      win.setTimeout(() => tryStart(attempts - 1), 80);
      return;
    }
    start(win, doc, elementsTool);
  };
  tryStart(30);
}

function start(win: Window, doc: Document, elements: ErudaElements): void {
  // 自前スタイルは eruda の shadow root 内に注入する必要がある。
  // shadow rootは host page の CSS を受けないため、 doc.head に置いてもUIに当たらない。
  const host = doc.getElementById("eruda");
  const styleTarget = host?.shadowRoot ?? doc.head;
  const style = doc.createElement("style");
  style.dataset.wdprInspectorStyle = "1";
  style.textContent = INSPECTOR_STYLE;
  styleTarget.appendChild(style);

  // Computed Style は本家のフィルタ (rmDefComputedStyle) に頼らず、
  // 自前 Stylesセクションで描画した property + display/width/height だけを
  // 自前で table 再構築して表示する (rebuildComputedStyleTable)。
  // 本家 filter は触らない。

  // eruda の Elements DOM を探す helper。useShadowDom 設定の有無で 2 経路。
  function findElementsRoot(): HTMLElement | null {
    const root = host?.shadowRoot ? (host.shadowRoot as unknown as DocumentFragment) : (doc as unknown as DocumentFragment);
    const el = (root as unknown as HTMLElement).querySelector?.(".eruda-elements .eruda-detail");
    return (el ?? null) as HTMLElement | null;
  }

  let detailRoot: HTMLElement | null = findElementsRoot();
  let rootObserver: MutationObserver | null = null;
  let attemptCount = 0;
  // eruda Elements の DOM がまだない場合のリトライ。
  const findLoop = win.setInterval(() => {
    attemptCount++;
    if (!detailRoot) detailRoot = findElementsRoot();
    if (detailRoot) {
      win.clearInterval(findLoop);
      observeDetail();
    } else if (attemptCount > 80) {
      win.clearInterval(findLoop);
    }
  }, 80);

  function observeDetail(): void {
    if (!detailRoot) return;
    // erudaが再描画したら自前で書き直す。
    // ただし、自前UI内の mutation (editable切替、追加削除ボタンの新規生成、
    // contenteditable状態のtextNode変更等) で再帰呼び出しすると、編集中の span が
    // DOM ツリーから外れて focus を失う。 自前 root 配下のみの mutation は除外。
    rootObserver = new MutationObserver((records) => {
      const hasExternal = records.some((r) => {
        const t = r.target as Element | null;
        if (!t) return true;
        if (!(t instanceof Element)) return true;
        return t.closest(".wdpr-inspector-root") === null;
      });
      if (hasExternal) renderInspector();
    });
    rootObserver.observe(detailRoot, { childList: true, subtree: true });
    renderInspector();
  }

  // Elements.on('change', node) で選択変更を購読
  const onChange = (..._args: unknown[]) => {
    // _args[0] が変更後の node。MutationObserver 経由でも再描画されるが念のため。
    win.setTimeout(() => renderInspector(), 0);
  };
  elements.on("change", onChange);

  let rendering = false;

  function renderInspector(): void {
    if (rendering) return;
    if (!detailRoot) return;
    const cur = elements._curNode;
    if (!cur || (cur as Node).nodeType !== Node.ELEMENT_NODE) {
      // 要素以外の選択 (Text/Comment) では自前UI出さない。
      removeInspector(detailRoot);
      return;
    }
    rendering = true;
    rootObserver?.disconnect();
    try {
      const props = replaceStylesSection(detailRoot, cur as Element);
      injectAttributeEditing(detailRoot, cur as Element);
      rebuildComputedStyleTable(detailRoot, cur as Element, props);
    } finally {
      rendering = false;
      if (detailRoot) rootObserver?.observe(detailRoot, { childList: true, subtree: true });
    }
  }

  activeRender = renderInspector;
}

/**
 * Computed Style 表を「Styles セクションの propertyを longhand に展開した一覧」 として並べ直す。
 * 本家が既に生成した row (色swatch付きの装飾HTMLを含む) は流用し、
 * 不足分だけ自前で生成 (簡易な色swatch 付き) する。
 *
 * DevTools の Computed タブ風: background などの shorthand は longhand に分解されて全部出る。
 */
function rebuildComputedStyleTable(detailRoot: HTMLElement, el: Element, props: Set<string>): void {
  const cs = detailRoot.querySelector(".eruda-computed-style") as HTMLElement | null;
  if (!cs) return;
  const tbody = cs.querySelector("tbody") as HTMLTableSectionElement | null;
  if (!tbody) return;
  const doc = cs.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  const cstyle = win.getComputedStyle(el);

  // 本家が既に生成した row を name でindex (色 swatch 等の装飾 HTML を再利用)
  const existingRows = new Map<string, HTMLElement>();
  tbody.querySelectorAll("tr").forEach((tr) => {
    const name = tr.querySelector(".eruda-key")?.textContent?.trim();
    if (name) existingRows.set(name, tr as HTMLElement);
  });

  // getComputedStyle が公開する全 longhand 一覧
  const allLonghands: string[] = [];
  for (let i = 0; i < cstyle.length; i++) {
    const n = cstyle.item(i);
    if (n) allLonghands.push(n);
  }

  // Styles セクションの props (= shorthand含む) を longhand へ展開
  const wanted = new Set<string>();
  ["display", "width", "height"].forEach((k) => wanted.add(k));
  for (const p of props) {
    if (allLonghands.includes(p)) {
      wanted.add(p);
    } else {
      for (const lh of allLonghands) {
        if (lh === p || lh.startsWith(p + "-")) wanted.add(lh);
      }
    }
  }

  const sorted = [...wanted].sort((a, b) => {
    const norm = (s: string) => s.replace(/-/g, "{");
    return norm(a).localeCompare(norm(b));
  });

  // 一旦すべて hidden にして、 sorted順で append し直す (DOM 上の順序も整える)
  tbody.querySelectorAll("tr").forEach((tr) => {
    (tr as HTMLElement).style.display = "none";
  });

  for (const name of sorted) {
    const existing = existingRows.get(name);
    if (existing) {
      existing.style.display = "";
      tbody.appendChild(existing); // sorted順に並び替え
      continue;
    }
    // 本家にない row は自前生成 (色swatch付き)
    const value = cstyle.getPropertyValue(name);
    if (!value) continue;
    const tr = doc.createElement("tr");
    const td1 = doc.createElement("td");
    td1.className = "eruda-key";
    td1.textContent = name;
    const td2 = doc.createElement("td");
    appendValueWithSwatch(doc, td2, value);
    tr.appendChild(td1);
    tr.appendChild(td2);
    tbody.appendChild(tr);
  }
}

/**
 * 値文字列から色っぽいトークン (#hex, rgb(), rgba(), hsl(), hsla()) を抜き出し、
 * 直前に小さな swatch span を挿入する。
 */
function appendValueWithSwatch(doc: Document, td: HTMLElement, value: string): void {
  const colorRe = /(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = colorRe.exec(value)) !== null) {
    if (m.index > last) td.appendChild(doc.createTextNode(value.slice(last, m.index)));
    const sw = doc.createElement("span");
    sw.style.cssText = `display:inline-block;width:10px;height:10px;background:${m[0]};border:1px solid rgba(127,127,127,.45);margin-right:4px;vertical-align:middle;border-radius:2px;`;
    td.appendChild(sw);
    td.appendChild(doc.createTextNode(m[0]));
    last = colorRe.lastIndex;
  }
  if (last < value.length) td.appendChild(doc.createTextNode(value.slice(last)));
}

function removeInspector(root: HTMLElement): void {
  root.querySelectorAll(".wdpr-inspector-root").forEach((n) => n.remove());
}

function replaceStylesSection(root: HTMLElement, el: Element): Set<string> {
  const renderedProps = new Set<string>();
  const stylesSection = root.querySelector(".eruda-styles") as HTMLElement | null;
  if (!stylesSection) return renderedProps;
  // 既存の自前UIを除去
  stylesSection.querySelectorAll(".wdpr-inspector-root").forEach((n) => n.remove());
  // 本家の中身を非表示にする (削除すると eruda 内部で再描画衝突するので非表示)
  Array.from(stylesSection.children).forEach((child) => {
    if (!(child as HTMLElement).classList.contains("wdpr-inspector-root")) {
      (child as HTMLElement).style.display = "none";
    }
  });

  const ctx = stylesSection.ownerDocument;
  const root2 = ctx.createElement("div");
  root2.className = "wdpr-inspector-root";

  // matched rules
  const { rules, skippedStyleSheetCount } = getMatchedRules(el);
  const inline = getInlineStyle(el);
  // cascade 判定用 (declarationOrder=sheet順) — getMatchedRulesの戻り値の順番のまま。
  // ここで sort してから collect すると declarationOrder が乱れて
  // tie-break (= source order の DESC) が逆転し、winnerが取り消し線になる。
  const allRulesInSheetOrder: MatchedRule[] = inline ? [inline, ...rules] : rules;
  const decls = collectDeclarations(allRulesInSheetOrder);
  const marked = computeActiveDeclarations(decls, isInheritedProperty, false);
  for (const d of marked) renderedProps.add(d.property.toLowerCase());

  // 表示順は cascade winner (= 効いている方が上) → DevTools の Styles ペインと同じ並び。
  //   1. inline (element.style) は常に先頭
  //   2. その他は specificity DESC → sourceOrder DESC (新しい source order が勝ち上に)
  // active/inactive は marked 側に既に判定済みなので、並びを変えても判定はずれない。
  const sortedRules: MatchedRule[] = [
    ...(inline ? [inline] : []),
    ...[...rules].sort((a, b) => {
      const cmp = compareSpecificity(b.specificity, a.specificity);
      if (cmp !== 0) return cmp;
      return b.sourceOrder - a.sourceOrder;
    }),
  ];

  const ownSection = ctx.createElement("div");
  ownSection.className = "wdpr-inspector-section";
  const ownTitle = ctx.createElement("div");
  ownTitle.className = "wdpr-inspector-section-title";
  ownTitle.textContent = "Styles";
  ownSection.appendChild(ownTitle);
  renderRules(ctx, ownSection, sortedRules, marked, /* read-only? */ false);
  root2.appendChild(ownSection);

  // inherited sections。
  // hasDisabledRule callback で「 disabledMap に退避 entry がある rule」 を持つ
  // ancestor も section として残す → uncheck で section ごと消える事象を回避。
  const inherited = collectInheritedSections(el, {
    hasDisabledRule: (r) => r.source.kind !== "read-only" && getDisabledMap(r.style).size > 0,
  });
  for (const sect of inherited) {
    const ih = ctx.createElement("div");
    ih.className = "wdpr-inspector-section";
    const title = ctx.createElement("div");
    title.className = "wdpr-inspector-section-title";
    title.textContent = `Inherited from <${(sect.ancestor as Element).tagName.toLowerCase()}>`;
    ih.appendChild(title);
    // active 宣言のある rule + disabled 退避 entry がある rule を merge。
    // 順序は sect.rules (sheet 出現順) で固定し、 uncheck で block の位置が動かないようにする。
    const declRules = new Set(sect.declarations.map((d) => d.rule));
    const isInteresting = (r: MatchedRule) =>
      declRules.has(r) || (r.source.kind !== "read-only" && getDisabledMap(r.style).size > 0);
    const sectRules = sect.rules.filter(isInteresting);
    renderRules(ctx, ih, sectRules, sect.declarations, false);
    for (const d of sect.declarations) renderedProps.add(d.property.toLowerCase());
    root2.appendChild(ih);
  }

  if (skippedStyleSheetCount > 0) {
    const skip = ctx.createElement("div");
    skip.className = "wdpr-inspector-skip-notice";
    skip.textContent = `${skippedStyleSheetCount} inaccessible stylesheet(s) skipped (cross-origin)`;
    root2.appendChild(skip);
  }

  stylesSection.appendChild(root2);
  return renderedProps;
}


function renderRules(
  doc: Document,
  parent: HTMLElement,
  rules: MatchedRule[],
  marked: MarkedDeclaration[],
  forceReadOnly: boolean,
): void {
  if (rules.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "wdpr-inspector-empty";
    empty.textContent = "(no rules)";
    parent.appendChild(empty);
    return;
  }
  // rule 単位にgrouping。inline (element.style) は declaration が空でも block を出す。
  // declsOfRule が空でも disabledMap に退避済みの declaration があれば block 維持
  // (全部 uncheck して block が消えると 「全部消えた」 状態になり戻せなくなる)。
  for (const rule of rules) {
    const declsOfRule = marked.filter((d) => d.rule === rule);
    // matched rule は declaration が空でも block を表示する。
    // (checkbox 外して disabledCache が iframe reload で消えても block 自体が消えず、
    //  ユーザーが何が起きたか把握できる。 また rule {} 形でre-addもできる)
    const disabledForRule = rule.source.kind !== "read-only" ? getDisabledMap(rule.style) : new Map<string, DisabledInfo>();
    // 現在 cssText に存在する declarations の名前順で stable order を prime する。
    // (初出 propertyに新規 order を振る)
    primeStableOrder(
      rule.style,
      declsOfRule.sort((a, b) => a.declarationOrder - b.declarationOrder).map((d) => d.property),
    );
    const block = doc.createElement("div");
    block.className = "wdpr-inspector-rule-block";
    const sel = doc.createElement("div");
    sel.className = "wdpr-inspector-selector";
    sel.textContent = rule.fullSelectorText + " {";
    sel.title = `specificity (${rule.specificity.join(",")})`;
    if (rule.sourceUrl) {
      const src = doc.createElement("span");
      src.className = "wdpr-inspector-source";
      src.textContent = shortUrl(rule.sourceUrl);
      src.title = rule.sourceUrl;
      sel.appendChild(src);
    }
    block.appendChild(sel);

    // disabled (= ユーザーがcheckbox外して退避済み)も含めて、 stable order で描画する。
    // checkbox を on/off で位置が動かないよう、 property 名 → 初出順 を別キャッシュで保持。
    type RowSpec = { property: string; value: string; priority: "" | "important"; active: boolean; disabled: boolean; locked: boolean; order: number };
    const rows: RowSpec[] = [
      ...declsOfRule.map((d) => ({
        property: d.property,
        value: d.value,
        priority: d.priority,
        active: d.active,
        disabled: false,
        // 同 cssRule に同 property 重複 → CSSOMで個別操作不可なので checkbox / edit ロック
        locked: d.isDuplicate,
        order: getStableOrder(rule.style, d.property),
      })),
      ...[...disabledForRule.entries()].map(([p, info]) => ({
        property: p,
        value: info.value,
        priority: info.priority,
        active: false,
        disabled: true,
        locked: false,
        order: getStableOrder(rule.style, p),
      })),
    ];
    rows.sort((a, b) => a.order - b.order);
    for (const row of rows) {
      const line = doc.createElement("div");
      const cls = ["wdpr-inspector-decl"];
      if (!row.active && !row.disabled) cls.push("wdpr-inspector-decl-inactive");
      if (row.disabled) cls.push("wdpr-inspector-decl-disabled");
      line.className = cls.join(" ");

      // 左端の checkbox (disable/enableトグル)
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.className = "wdpr-inspector-cb";
      cb.checked = !row.disabled;
      cb.title = row.disabled ? "Enable" : "Disable";
      const source = rule.source;
      const editable = !forceReadOnly && source.kind !== "read-only" && !row.locked;
      if (!editable) {
        cb.disabled = true;
        if (row.locked) {
          line.title = "Locked: same property declared multiple times in this rule";
        }
      } else {
        cb.addEventListener(
          "click",
          (ev) => {
            ev.stopImmediatePropagation();
          },
          { capture: true },
        );
        cb.addEventListener("change", () => {
          const m = getDisabledMap(rule.style);
          if (cb.checked) {
            // 復元
            const saved = m.get(row.property);
            if (saved) {
              editStyleProperty(
                source as EditableStyleSource,
                row.property,
                saved.value + (saved.priority === "important" ? " !important" : ""),
              );
              m.delete(row.property);
            }
          } else {
            // 退避: 位置は stableOrderCache が name 基準で保持するので value/priority だけ。
            m.set(row.property, { value: row.value, priority: row.priority });
            removeStyleProperty(source as EditableStyleSource, row.property);
          }
          triggerRerender();
        });
      }
      line.appendChild(cb);

      const pname = doc.createElement("span");
      pname.className = "wdpr-inspector-prop";
      pname.textContent = row.property;
      const colon = doc.createTextNode(": ");
      const pval = doc.createElement("span");
      pval.className = "wdpr-inspector-val";
      pval.textContent = row.value + (row.priority === "important" ? " !important" : "");
      line.appendChild(pname);
      line.appendChild(colon);
      line.appendChild(pval);
      line.appendChild(doc.createTextNode(";"));
      // 編集ハンドラ (disabled な行は復元のみ。 enable な行は通常の clickで編集)
      if (editable && !row.disabled) {
        pname.addEventListener(
          "click",
          (ev) => {
            ev.stopImmediatePropagation();
            startEditPropertyName(pname, source as EditableStyleSource, row.property);
          },
          { capture: true },
        );
        pval.addEventListener(
          "click",
          (ev) => {
            ev.stopImmediatePropagation();
            startEditPropertyValue(pval, source as EditableStyleSource, row.property, row.value, row.priority);
          },
          { capture: true },
        );
        // 削除ボタン
        const del = doc.createElement("button");
        del.type = "button";
        del.className = "wdpr-inspector-btn";
        del.textContent = "×";
        del.title = "Remove declaration";
        del.addEventListener(
          "click",
          (ev) => {
            ev.stopImmediatePropagation();
            removeStyleProperty(source as EditableStyleSource, row.property);
            // disabled mapからも除外 (もし残っていれば)
            getDisabledMap(rule.style).delete(row.property);
            triggerRerender();
          },
          { capture: true },
        );
        line.appendChild(doc.createTextNode(" "));
        line.appendChild(del);
      }
      block.appendChild(line);
    }
    // 追加ボタン (rule が編集可能な場合のみ)
    const ruleSource = rule.source;
    if (!forceReadOnly && ruleSource.kind !== "read-only") {
      const adder = doc.createElement("div");
      adder.className = "wdpr-inspector-add-prop";
      const addBtn = doc.createElement("button");
      addBtn.type = "button";
      addBtn.className = "wdpr-inspector-btn";
      addBtn.textContent = "+";
      addBtn.title = "Add declaration";
      addBtn.addEventListener(
        "click",
        (ev) => {
          ev.stopImmediatePropagation();
          startAddProperty(doc, adder, ruleSource);
        },
        { capture: true },
      );
      adder.appendChild(addBtn);
      block.appendChild(adder);
    }
    const close = doc.createElement("div");
    close.className = "wdpr-inspector-selector";
    close.textContent = "}";
    block.appendChild(close);
    parent.appendChild(block);
  }
}

function startEditPropertyName(
  span: HTMLElement,
  source: EditableStyleSource,
  oldName: string,
): void {
  makeEditable(span, {
    onCommit: (text) => {
      const newName = text.trim();
      if (!newName || newName === oldName) {
        span.textContent = oldName;
        return;
      }
      const ok = renameStyleProperty(source, oldName, newName);
      if (!ok) span.textContent = oldName;
      triggerRerender();
    },
    onCancel: () => {
      span.textContent = oldName;
    },
  });
}

function startAddProperty(doc: Document, container: HTMLElement, source: EditableStyleSource): void {
  // ボタンを inline 入力に置換: `propname: value;`
  container.textContent = "";
  const pname = doc.createElement("span");
  pname.className = "wdpr-inspector-prop";
  pname.textContent = "property";
  const colon = doc.createTextNode(": ");
  const pval = doc.createElement("span");
  pval.className = "wdpr-inspector-val";
  pval.textContent = "value";
  container.appendChild(pname);
  container.appendChild(colon);
  container.appendChild(pval);
  container.appendChild(doc.createTextNode(";"));
  let nameDone = "";
  makeEditable(pname, {
    onCommit: (text) => {
      const n = text.trim();
      if (!n) {
        triggerRerender();
        return;
      }
      nameDone = n;
      // 次に value 編集 (Enter キー event の同期コンテキストを保つため immediate)
      pval.textContent = "";
      makeEditable(pval, {
        immediate: true,
        onCommit: (vtext) => {
          const v = vtext.trim();
          if (v) addStyleProperty(source, nameDone, v);
          triggerRerender();
        },
      });
    },
  });
}

function startEditPropertyValue(
  span: HTMLElement,
  source: EditableStyleSource,
  name: string,
  oldValue: string,
  oldPriority: "" | "important",
): void {
  const initial = oldValue + (oldPriority === "important" ? " !important" : "");
  span.textContent = initial;
  makeEditable(span, {
    onCommit: (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        removeStyleProperty(source, name);
        triggerRerender();
        return;
      }
      const ok = editStyleProperty(source, name, trimmed);
      if (!ok) span.textContent = initial;
      triggerRerender();
    },
    onCancel: () => {
      span.textContent = initial;
    },
  });
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    return parts[parts.length - 1] || u.host;
  } catch {
    return url;
  }
}

// --- 属性編集の差し込み ---
// 属性 li/tr に直接 dataset 属性を書き込むと自分の MutationObserver や
// eruda 側の DOM 監視に拾われて再描画ループの原因になる。
// 副作用ゼロの WeakSet で「attached済み」を追跡する。
const attachedAttrNodes = new WeakSet<Element>();
const attachedAddBtnFor = new WeakSet<Element>();

function injectAttributeEditing(root: HTMLElement, el: Element): void {
  const attrSec = root.querySelector(".eruda-attributes") as HTMLElement | null;
  if (!attrSec) return;
  // eruda v3.4.x の attribute 表示は luna-dom-viewer 由来で
  // `<div class="luna-dom-viewer-attribute"><span name>...</span>="<span value>...</span>"</div>`。
  // 互換のため、 luna-dom-viewer-attribute / li / tr のいずれの行も対象にする。
  const candidates = attrSec.querySelectorAll(
    ".luna-dom-viewer-attribute, li.eruda-attribute, tr",
  );
  candidates.forEach((node) => {
    if (attachedAttrNodes.has(node)) return;
    attachedAttrNodes.add(node);
    // 値部分を見つける: luna-dom-viewer-attribute-value がある場合はそれ、
    // ない場合は textContent から `name="value"` を切り出す。
    const valSpan = node.querySelector(".luna-dom-viewer-attribute-value") as HTMLElement | null;
    const nameSpan = node.querySelector(".luna-dom-viewer-attribute-name") as HTMLElement | null;
    if (valSpan && nameSpan) {
      const name = nameSpan.textContent ?? "";
      const original = valSpan.textContent ?? "";
      valSpan.addEventListener(
        "click",
        (ev) => {
          ev.stopImmediatePropagation();
          makeEditable(valSpan, {
            onCommit: (text) => {
              editAttribute(el, name, text);
              triggerRerender();
            },
            onCancel: () => {
              valSpan.textContent = original;
            },
          });
        },
        { capture: true },
      );
      // 削除ボタンを行末に差し込む。
      // (luna-dom-viewer の構造を壊さず、自前spanとして付け加える)
      const del = (node as HTMLElement).ownerDocument.createElement("button");
      del.type = "button";
      del.className = "wdpr-inspector-btn";
      del.textContent = "×";
      del.title = `Remove ${name}`;
      del.addEventListener(
        "click",
        (ev) => {
          ev.stopImmediatePropagation();
          removeAttributeOn(el, name);
          triggerRerender();
        },
        { capture: true },
      );
      node.appendChild(del);
      return;
    }
    // fallback: textContent ベース。
    const text = node.textContent ?? "";
    const m = text.match(/^\s*([\w:-]+)\s*=\s*"(.*)"\s*$/);
    if (!m) return;
    const name = m[1]!;
    const value = m[2]!;
    node.addEventListener(
      "click",
      (ev) => {
        ev.stopImmediatePropagation();
        const wrap = node as HTMLElement;
        wrap.textContent = "";
        const nSpan = wrap.ownerDocument.createElement("span");
        nSpan.textContent = name;
        const eq = wrap.ownerDocument.createTextNode('="');
        const vSpan = wrap.ownerDocument.createElement("span");
        vSpan.textContent = value;
        const close = wrap.ownerDocument.createTextNode('"');
        wrap.appendChild(nSpan);
        wrap.appendChild(eq);
        wrap.appendChild(vSpan);
        wrap.appendChild(close);
        makeEditable(vSpan, {
          onCommit: (text) => {
            editAttribute(el, name, text);
          },
          onCancel: () => {
            vSpan.textContent = value;
          },
        });
      },
      { capture: true },
    );
  });
  // 末尾に「+ 追加」ボタン (重複防止のため WeakSet で 1度だけ追加)
  if (!attachedAddBtnFor.has(attrSec)) {
    attachedAddBtnFor.add(attrSec);
    const wrap = (attrSec as HTMLElement).ownerDocument.createElement("div");
    wrap.className = "wdpr-inspector-add-attr";
    const addBtn = (attrSec as HTMLElement).ownerDocument.createElement("button");
    addBtn.type = "button";
    addBtn.className = "wdpr-inspector-btn";
    addBtn.textContent = "+";
    addBtn.title = "Add attribute";
    addBtn.addEventListener(
      "click",
      (ev) => {
        ev.stopImmediatePropagation();
        startAddAttribute(wrap, el);
      },
      { capture: true },
    );
    wrap.appendChild(addBtn);
    attrSec.appendChild(wrap);
  }
}

function startAddAttribute(container: HTMLElement, el: Element): void {
  const doc = container.ownerDocument;
  container.textContent = "";
  const nSpan = doc.createElement("span");
  nSpan.textContent = "name";
  const eq = doc.createTextNode('="');
  const vSpan = doc.createElement("span");
  vSpan.textContent = "value";
  const close = doc.createTextNode('"');
  container.appendChild(nSpan);
  container.appendChild(eq);
  container.appendChild(vSpan);
  container.appendChild(close);
  let nameDone = "";
  makeEditable(nSpan, {
    onCommit: (text) => {
      const n = text.trim();
      if (!n) {
        triggerRerender();
        return;
      }
      nameDone = n;
      makeEditable(vSpan, {
        immediate: true,
        onCommit: (vtext) => {
          addAttribute(el, nameDone, vtext);
          triggerRerender();
        },
      });
    },
  });
}

(window as unknown as InspectorWindow).__wdprStyleInspector = { install };

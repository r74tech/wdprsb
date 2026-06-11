// CSS継承プロパティの判定と、親要素を遡って継承される rule を集める。
// 継承表は MDN「Inherited: yes」プロパティ一覧をハードコード。
// custom property (`--*`) は @property で inherits:false 指定がなければデフォルト inherit。

import {
  collectDeclarations,
  computeActiveDeclarations,
  getMatchedRules,
  type MarkedDeclaration,
  type MatchedRule,
  type PseudoState,
} from "./cssMatcher";

/** CSS Property の中で「inherited: yes」のものの canonical 名 set。 */
const INHERITED_PROPS: ReadonlySet<string> = new Set<string>([
  // 色・フォント
  "color",
  "font",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-language-override",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  // テキスト
  "letter-spacing",
  "line-break",
  "line-height",
  "overflow-wrap",
  "tab-size",
  "text-align",
  "text-align-last",
  "text-indent",
  "text-justify",
  "text-rendering",
  "text-shadow",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "white-space",
  "word-break",
  "word-spacing",
  "word-wrap",
  "hyphens",
  "hanging-punctuation",
  // 方向・書字
  "direction",
  "writing-mode",
  "text-orientation",
  "unicode-bidi",
  // リスト
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  // テーブル
  "border-collapse",
  "border-spacing",
  "caption-side",
  "empty-cells",
  // 可視
  "visibility",
  "cursor",
  "pointer-events",
  // 雑
  "quotes",
  "orphans",
  "widows",
  "caret-color",
  "color-scheme",
  "image-rendering",
  "object-position",
  "tab-size",
  // SVG 系で継承するもの (代表)
  "fill",
  "stroke",
  "fill-opacity",
  "stroke-opacity",
  "fill-rule",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-width",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "shape-rendering",
  "clip-rule",
]);

/** プロパティが継承対象かどうか。custom property は常にtrue。 */
export function isInheritedProperty(name: string): boolean {
  if (name.startsWith("--")) return true;
  return INHERITED_PROPS.has(name.toLowerCase());
}

export interface InheritedSection {
  ancestor: Element;
  /** active な inherited declarations (取り消し線でないもの)。 */
  declarations: MarkedDeclaration[];
  /** ancestor で matched した全 rule (inherited判定前)。disabled退避済みrule を含めて表示するため。 */
  rules: MatchedRule[];
}

/**
 * 対象要素の親を root まで辿り、各祖先で active な inherited property だけを抽出する。
 * 表示用に祖先 → root の順 (要素の直近親が先頭)。
 */
export function collectInheritedSections(
  el: Element,
  opts?: {
    forced?: Set<PseudoState>;
    /** 該当 ancestor の rule に disabled退避 entry がある場合 section を追加するための callback。 */
    hasDisabledRule?: (rule: MatchedRule) => boolean;
  },
): InheritedSection[] {
  const sections: InheritedSection[] = [];
  let cur: Element | null = el.parentElement;
  while (cur) {
    const { rules } = getMatchedRules(cur, opts);
    const decls = collectDeclarations(rules);
    const marked = computeActiveDeclarations(decls, isInheritedProperty, true);
    // active かつ inherited の declaration だけ残す。
    const filtered = marked.filter((d) => d.active && isInheritedProperty(d.property));
    // active inherited が空でも、 disabled退避 entry が rules のどれかにあれば section を維持。
    // これで uncheck で全 declaration を disable しても section が消えなくなる。
    const hasDisabled = opts?.hasDisabledRule ? rules.some((r) => opts.hasDisabledRule!(r)) : false;
    if (filtered.length > 0 || hasDisabled) {
      sections.push({ ancestor: cur, declarations: filtered, rules });
    }
    cur = cur.parentElement;
  }
  return sections;
}

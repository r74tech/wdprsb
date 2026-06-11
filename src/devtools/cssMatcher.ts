// マッチしたCSS rulesの取得、selector list分解、specificity計算、cascade sort、active判定。
// MVPは Layer / user-agent / user origin を無視し、author / inline のみ扱う。
// cross-origin sheet (cssRulesアクセス不能) は件数だけ返し、UIに「N skipped」表示してもらう。
//
// specificity計算は npm `specificity` (keeganstreet, CSS Selectors L4 対応) に委譲。
// 同パッケージは selector list の分割を提供しないので splitSelectorList は自前のまま。

import { calculate as libCalculate } from "specificity";

export type Origin = "author" | "inline";

export interface MatchedRule {
  /** rule本来のselectorText (selectorList 全体、UI表示用)。 */
  fullSelectorText: string;
  /** selectorList 中で実際にmatchした single selector。 */
  matchedSelector: string;
  /** rule.style あるいは element.style。 */
  style: CSSStyleDeclaration;
  /** 直接の親rule (@media/@supports/@container/@layer など)。表示用。 */
  parentRule: CSSRule | null;
  /** sheet.href。inline <style>はnull。 */
  sourceUrl: string | null;
  /** collect 中に振った rule 単位の単調増加番号。 */
  sourceOrder: number;
  specificity: Specificity;
  origin: Origin;
  /** 編集統一API用。inline は { kind:'inline' }、cssRule は { kind:'rule' }。 */
  source: EditableStyleSource;
}

export type Specificity = readonly [number, number, number];

export interface MatchedDeclaration {
  rule: MatchedRule;
  property: string;
  value: string;
  priority: "" | "important";
  /** 全 declaration を collect 中に振った単調増加番号。最終 tie-break に使う。 */
  declarationOrder: number;
  /**
   * 同じ cssRule 内に同 property が複数 declaration として書かれていることを示す。
   * CSSOMは declaration 単位の個別操作ができず、 removeProperty すると同名全部消える。
   * → UI 上は edit/remove/checkbox を不可にする (ユーザーの操作で意図せず全消えしないため)。
   */
  isDuplicate: boolean;
}

export interface MarkedDeclaration extends MatchedDeclaration {
  /** false = 上書きされて取り消し線対象。 */
  active: boolean;
}

export type PseudoState =
  | "hover"
  | "active"
  | "focus"
  | "focus-within"
  | "focus-visible"
  | "target";

const FORCED_PSEUDO_RE = /:(hover|active|focus|focus-within|focus-visible|target)\b/g;

export type EditableStyleSource =
  | { kind: "inline"; element: Element; style: CSSStyleDeclaration }
  | { kind: "rule"; rule: CSSStyleRule; style: CSSStyleDeclaration }
  | { kind: "read-only"; reason: string };

interface MatcherContext {
  el: Element;
  forced: Set<PseudoState> | null;
  results: MatchedRule[];
  ruleOrder: { n: number };
  skipped: { count: number };
}

/**
 * selectorList を top-level の `,` で split する。
 * `()`/`[]` 深度を別々に追い、引用符内とバックスラッシュエスケープは無視する。
 * 例: `[data-x=","], :is(.a, .b), a\,b` → 3要素
 */
export function splitSelectorList(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let paren = 0;
  let bracket = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      buf += ch;
      if (i + 1 < text.length) buf += text[++i];
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") {
      paren++;
      buf += ch;
      continue;
    }
    if (ch === ")") {
      paren = Math.max(0, paren - 1);
      buf += ch;
      continue;
    }
    if (ch === "[") {
      bracket++;
      buf += ch;
      continue;
    }
    if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      buf += ch;
      continue;
    }
    if (ch === "," && paren === 0 && bracket === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

/**
 * single selector の specificity (a, b, c) を npm `specificity` (CSS Selectors L4 対応) で計算する。
 * 同パッケージの Specificity 型 { A, B, C } を [A, B, C] tupleに整える。
 * 壊れた selector が来た場合は (0,0,0) を返してUIを落とさない。
 */
export function computeSpecificity(sel: string): Specificity {
  try {
    const r = libCalculate(sel);
    return [r.A, r.B, r.C] as Specificity;
  } catch {
    return [0, 0, 0];
  }
}

/** specificity の大小比較。a/b/c の辞書順。 */
export function compareSpecificity(x: Specificity, y: Specificity): number {
  if (x[0] !== y[0]) return x[0] - y[0];
  if (x[1] !== y[1]) return x[1] - y[1];
  return x[2] - y[2];
}

/**
 * forced 集合に含まれる pseudo を selector text から除去した dummy selector を返す。
 * これで `el.matches(dummy)` を呼んで forced state が有効な matched 判定ができる。
 */
function buildDummySelector(sel: string, forced: Set<PseudoState>): string {
  if (forced.size === 0) return sel;
  return sel.replace(FORCED_PSEUDO_RE, (_, name: string) => {
    if (forced.has(name as PseudoState)) return "";
    return _;
  });
}

/**
 * 対象要素のmatched rulesを取得する。
 * cross-origin sheet (cssRules SecurityError) は静かに skip し、件数を skippedStyleSheetCount に。
 */
export function getMatchedRules(
  el: Element,
  opts?: { forced?: Set<PseudoState> },
): { rules: MatchedRule[]; skippedStyleSheetCount: number } {
  const ctx: MatcherContext = {
    el,
    forced: opts?.forced ?? null,
    results: [],
    ruleOrder: { n: 0 },
    skipped: { count: 0 },
  };
  const doc = el.ownerDocument;
  for (const sheet of Array.from(doc.styleSheets) as CSSStyleSheet[]) {
    walkSheet(sheet, ctx);
  }
  return { rules: ctx.results, skippedStyleSheetCount: ctx.skipped.count };
}

function walkSheet(sheet: CSSStyleSheet, ctx: MatcherContext): void {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    ctx.skipped.count++;
    return;
  }
  for (let i = 0; i < rules.length; i++) {
    walkRule(rules[i]!, sheet, ctx);
  }
}

function walkRule(rule: CSSRule, sheet: CSSStyleSheet, ctx: MatcherContext): void {
  if (rule instanceof CSSStyleRule) {
    tryMatch(rule, sheet, ctx);
    return;
  }
  if (typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule) {
    try {
      if (!window.matchMedia(rule.conditionText).matches) return;
    } catch {
      // matchMedia error はnoop
    }
    for (let i = 0; i < rule.cssRules.length; i++) walkRule(rule.cssRules[i]!, sheet, ctx);
    return;
  }
  if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule) {
    try {
      if (!CSS.supports(rule.conditionText)) return;
    } catch {
      return;
    }
    for (let i = 0; i < rule.cssRules.length; i++) walkRule(rule.cssRules[i]!, sheet, ctx);
    return;
  }
  // CSSContainerRule / CSSLayerBlockRule / CSSScopeRule などは条件評価が難しいので
  // MVPでは無条件に再帰する。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyRule = rule as any;
  if (anyRule.cssRules && typeof anyRule.cssRules.length === "number") {
    for (let i = 0; i < anyRule.cssRules.length; i++) walkRule(anyRule.cssRules[i], sheet, ctx);
    return;
  }
  if (typeof CSSImportRule !== "undefined" && rule instanceof CSSImportRule) {
    if (rule.styleSheet) walkSheet(rule.styleSheet, ctx);
    return;
  }
}

function tryMatch(rule: CSSStyleRule, sheet: CSSStyleSheet, ctx: MatcherContext): void {
  const selectors = splitSelectorList(rule.selectorText);
  ctx.ruleOrder.n++;
  const ruleOrder = ctx.ruleOrder.n;
  for (const sel of selectors) {
    let matched: boolean;
    if (ctx.forced && ctx.forced.size > 0) {
      const dummy = buildDummySelector(sel, ctx.forced);
      if (!dummy.trim() || /:not\(\s*\)|:is\(\s*\)|:where\(\s*\)/.test(dummy)) continue;
      try {
        matched = ctx.el.matches(dummy);
      } catch {
        continue;
      }
    } else {
      try {
        matched = ctx.el.matches(sel);
      } catch {
        continue;
      }
    }
    if (!matched) continue;
    const specificity = computeSpecificity(sel);
    ctx.results.push({
      fullSelectorText: rule.selectorText,
      matchedSelector: sel,
      style: rule.style,
      parentRule: rule.parentRule ?? null,
      sourceUrl: sheet.href ?? null,
      sourceOrder: ruleOrder,
      specificity,
      origin: "author",
      source: { kind: "rule", rule, style: rule.style },
    });
  }
}

/**
 * element.style を擬似 MatchedRule として常に返す (空でも declaration 追加先になるため)。
 */
export function getInlineStyle(el: Element): MatchedRule | null {
  // element.style は HTMLElement / SVGElement のみ持つ。
  const style = (el as HTMLElement).style;
  if (!style) return null;
  return {
    fullSelectorText: "element.style",
    matchedSelector: "element.style",
    style,
    parentRule: null,
    sourceUrl: null,
    sourceOrder: Number.MAX_SAFE_INTEGER, // 描画順は別途
    // inline styleの specificity 表示は (1,0,0) 相当だが、cascade判定はbucketで処理するためここは表示用。
    specificity: [1, 0, 0] as Specificity,
    origin: "inline",
    source: { kind: "inline", element: el, style },
  };
}

/** cascade bucket rank: 高いほど勝つ。 */
function cascadeBucket(decl: MatchedDeclaration): number {
  const isInline = decl.rule.origin === "inline";
  const isImportant = decl.priority === "important";
  if (isImportant && isInline) return 3;
  if (isImportant) return 2;
  if (isInline) return 1;
  return 0;
}

/**
 * `style.cssText` をパースして declaration を取り出す。
 * `style.item(i)` だと shorthand (`border: 2px solid red`) が longhand (`border-top-width: 2px; ...`)
 * に分解されて表示が読みづらくなるため、 ソース通りの cssText から split する。
 * url(), quote, backslashエスケープを考慮した最小 parser。
 */
function splitCssTextDeclarations(cssText: string): string[] {
  const out: string[] = [];
  let buf = "";
  let paren = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cssText.length; i++) {
    const ch = cssText[i]!;
    if (ch === "\\") {
      buf += ch;
      if (i + 1 < cssText.length) buf += cssText[++i];
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") {
      paren++;
      buf += ch;
      continue;
    }
    if (ch === ")") {
      paren = Math.max(0, paren - 1);
      buf += ch;
      continue;
    }
    if (ch === ";" && paren === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

function parseDeclaration(
  decl: string,
): { name: string; value: string; priority: "" | "important" } | null {
  const idx = decl.indexOf(":");
  if (idx < 0) return null;
  const name = decl.slice(0, idx).trim();
  if (!name) return null;
  let value = decl.slice(idx + 1).trim();
  let priority: "" | "important" = "";
  const m = value.match(/^(.*?)\s*!important\s*$/i);
  if (m) {
    value = m[1]!.trim();
    priority = "important";
  }
  return { name, value, priority };
}

/** rule 配列 → declaration 配列 (declarationOrder 採番)。cssTextからparseして shorthand 維持。 */
export function collectDeclarations(rules: MatchedRule[]): MatchedDeclaration[] {
  const out: MatchedDeclaration[] = [];
  let order = 0;
  for (const rule of rules) {
    const text = rule.style.cssText;
    const parts = splitCssTextDeclarations(text);
    // 同 cssRule 内の重複 property を検出 (CSSOMは declaration 単位の操作ができないため UI でロック)
    const counts = new Map<string, number>();
    const parsedParts: { name: string; value: string; priority: "" | "important" }[] = [];
    for (const part of parts) {
      const p = parseDeclaration(part);
      if (!p) continue;
      parsedParts.push(p);
      const k = p.name.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const p of parsedParts) {
      order++;
      out.push({
        rule,
        property: p.name,
        value: p.value,
        priority: p.priority,
        declarationOrder: order,
        isDuplicate: (counts.get(p.name.toLowerCase()) ?? 0) > 1,
      });
    }
  }
  return out;
}

function canonName(name: string): string {
  // 大文字小文字統一のみ。vendor prefix は別物として扱う。
  return name.toLowerCase();
}

/**
 * cascade sort + active 判定。
 * sort tuple: (cascadeBucket DESC, specificity DESC, declarationOrder DESC)。
 * isInheritedContext=true の場合、非継承プロパティは inactive にする。
 */
export function computeActiveDeclarations(
  decls: MatchedDeclaration[],
  isInheritedProperty: (name: string) => boolean,
  isInheritedContext = false,
): MarkedDeclaration[] {
  const sorted = [...decls].sort((x, y) => {
    const bx = cascadeBucket(x);
    const by = cascadeBucket(y);
    if (bx !== by) return by - bx;
    const cmp = compareSpecificity(y.rule.specificity, x.rule.specificity);
    if (cmp !== 0) return cmp;
    return y.declarationOrder - x.declarationOrder;
  });
  const out: MarkedDeclaration[] = [];
  const active = new Map<string, MarkedDeclaration>();
  for (const decl of sorted) {
    if (isInheritedContext && !isInheritedProperty(decl.property)) {
      out.push({ ...decl, active: false });
      continue;
    }
    const key = canonName(decl.property);
    if (active.has(key)) {
      out.push({ ...decl, active: false });
      continue;
    }
    const marked = { ...decl, active: true };
    active.set(key, marked);
    out.push(marked);
  }
  // 元の declarationOrder (描画順) に戻す。
  out.sort((x, y) => x.declarationOrder - y.declarationOrder);
  return out;
}

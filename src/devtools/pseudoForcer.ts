// :hover/:active/:focus 等の pseudo-class を強制するための CSS書き換えユーティリティ。
//
// アプローチ (storybook-addon-pseudo-states / focus-within-polyfill 流):
// 1. document.styleSheets を巡回し、:hover 等を含む rule のクローン (selector を
//    `.eruda-force-hover` 等のクラスに置換) を新規 constructable stylesheet に挿入。
// 2. 要素にクラスを toggle すると、そのクラスを使った rule がマッチして強制発動。
//
// cross-origin sheet は cssRules アクセス時に SecurityError なので catch して skip。
// 空 `:not()` / `:is()` / `:where()` ができた selector は SyntaxError 回避のため skip。

import type { PseudoState } from "./cssMatcher";

const TOKEN_RE = /:(hover|active|focus|focus-within|focus-visible|target)\b/g;
const EMPTY_PSEUDO_RE = /:not\(\s*\)|:is\(\s*\)|:where\(\s*\)/;
const CLASS_PREFIX = "eruda-force-";

export interface PseudoForcer {
  /** すべての sheet を再走査して FORCED sheet を作り直す。冪等。 */
  refresh: () => void;
  /** 要素に強制クラスを付与/除去する。 */
  setForcedState: (el: Element, state: PseudoState, enabled: boolean) => void;
  /** どの要素にどの state が強制されているか問い合わせる。 */
  getForcedStates: (el: Element) => Set<PseudoState>;
  /** disconnect & クラス除去。 */
  dispose: () => void;
}

/** PseudoForcer を初期化する。iframe document を渡す。 */
export function initPseudoForcer(doc: Document): PseudoForcer {
  // Constructable stylesheets は modern browsers のみ。fallback として <style> 要素を用いる。
  let forcedSheet: CSSStyleSheet | null = null;
  let fallbackStyle: HTMLStyleElement | null = null;

  function ensureSheet(): CSSStyleSheet | HTMLStyleElement {
    if (forcedSheet || fallbackStyle) return forcedSheet ?? fallbackStyle!;
    try {
      forcedSheet = new doc.defaultView!.CSSStyleSheet();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (doc as any).adoptedStyleSheets = [...((doc as any).adoptedStyleSheets || []), forcedSheet];
      return forcedSheet;
    } catch {
      fallbackStyle = doc.createElement("style");
      fallbackStyle.dataset.wdprPseudoForce = "1";
      doc.head.appendChild(fallbackStyle);
      return fallbackStyle;
    }
  }

  function clearSheet(): void {
    if (forcedSheet) {
      while (forcedSheet.cssRules.length > 0) {
        forcedSheet.deleteRule(0);
      }
    } else if (fallbackStyle) {
      fallbackStyle.textContent = "";
    }
  }

  function insertRule(text: string): void {
    if (forcedSheet) {
      try {
        forcedSheet.insertRule(text, forcedSheet.cssRules.length);
      } catch {
        // invalid rule は skip
      }
    } else if (fallbackStyle) {
      fallbackStyle.textContent = (fallbackStyle.textContent ?? "") + text + "\n";
    }
  }

  function rewriteSelector(sel: string): string | null {
    if (!TOKEN_RE.test(sel)) return null;
    // 否定形などで空の `:not()` が出ないよう、`:not(:hover)` 系はまるごと削る。
    let out = sel.replace(/:not\(\s*:(?:hover|active|focus|focus-within|focus-visible|target)[^)]*\)/g, "");
    out = out.replace(TOKEN_RE, (_, p: string) => `.${CLASS_PREFIX}${p}`);
    if (!out.trim()) return null;
    if (EMPTY_PSEUDO_RE.test(out)) return null;
    return out;
  }

  function walkRules(rules: CSSRuleList): void {
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r) continue;
      if (r instanceof CSSStyleRule) {
        const newSel = rewriteSelector(r.selectorText);
        if (!newSel) continue;
        insertRule(`${newSel}{${r.style.cssText}}`);
      } else if (typeof CSSMediaRule !== "undefined" && r instanceof CSSMediaRule) {
        walkRules(r.cssRules);
      } else if (typeof CSSSupportsRule !== "undefined" && r instanceof CSSSupportsRule) {
        walkRules(r.cssRules);
      }
      // CSSImportRule の子 sheet は次の refresh で document.styleSheets として取れるので扱わない。
    }
  }

  function refresh(): void {
    ensureSheet();
    clearSheet();
    const sheets = Array.from(doc.styleSheets) as CSSStyleSheet[];
    for (const sheet of sheets) {
      // 自分の FORCED sheet は除外。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((sheet as any) === forcedSheet) continue;
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      walkRules(rules);
    }
  }

  const forcedMap = new WeakMap<Element, Set<PseudoState>>();

  function setForcedState(el: Element, state: PseudoState, enabled: boolean): void {
    const cls = `${CLASS_PREFIX}${state}`;
    let set = forcedMap.get(el);
    if (enabled) {
      el.classList.add(cls);
      if (!set) {
        set = new Set();
        forcedMap.set(el, set);
      }
      set.add(state);
    } else {
      el.classList.remove(cls);
      if (set) {
        set.delete(state);
        if (set.size === 0) forcedMap.delete(el);
      }
    }
  }

  function getForcedStates(el: Element): Set<PseudoState> {
    return new Set(forcedMap.get(el) ?? []);
  }

  function dispose(): void {
    if (forcedSheet) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = ((doc as any).adoptedStyleSheets || []).filter((s: CSSStyleSheet) => s !== forcedSheet);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (doc as any).adoptedStyleSheets = arr;
      forcedSheet = null;
    }
    if (fallbackStyle && fallbackStyle.parentNode) {
      fallbackStyle.parentNode.removeChild(fallbackStyle);
      fallbackStyle = null;
    }
  }

  return { refresh, setForcedState, getForcedStates, dispose };
}

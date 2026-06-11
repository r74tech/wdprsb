// 属性 / CSS rule 編集の最小APIと、contenteditable のインライン編集 helper。
// IME確定中のEnterは isComposing/keyCode 229 でガード。

import type { EditableStyleSource } from "./cssMatcher";

export interface EditableOptions {
  onCommit: (text: string) => void;
  onCancel?: () => void;
  /** Tab で次/前へ。reverse=trueでShift+Tab。 */
  onTab?: (reverse: boolean) => void;
  /**
   * true なら rAF を経由せず同期で focus + selection を行う。
   * 「Enter→次フィールドへ自動遷移」 のような user activation 内 chain で使う。
   * (モバイル browser は user activation 外の programmatic focus を許可しないため、
   *  Enter key event handler の同期 context を保ったまま focus する必要がある)
   */
  immediate?: boolean;
}

/**
 * 要素を contenteditable にし、Enter で commit / Esc で revert / Tab で next を呼ぶ。
 * IME 確定の Enter を誤検知しないよう e.isComposing / keyCode 229 を最優先でガードする。
 */
export function makeEditable(el: HTMLElement, opts: EditableOptions): void {
  if (el.dataset.wdprEditable === "1") return;
  el.dataset.wdprEditable = "1";
  el.setAttribute("contenteditable", "plaintext-only");
  el.spellcheck = false;
  const original = el.textContent ?? "";

  const onKeyDown = (e: KeyboardEvent) => {
    // IME 確定中の Enter は素通り (古い Safari は isComposing が false でも keyCode 229 を返すので保険で見る)
    const legacyKey = (e as KeyboardEvent & { keyCode?: number }).keyCode;
    if (e.isComposing || legacyKey === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      el.blur();
      opts.onCommit(el.textContent ?? "");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      el.textContent = original;
      el.blur();
      opts.onCancel?.();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      el.blur();
      opts.onCommit(el.textContent ?? "");
      opts.onTab?.(e.shiftKey);
      return;
    }
  };

  const onBlur = () => {
    el.removeAttribute("contenteditable");
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("blur", onBlur);
    delete el.dataset.wdprEditable;
  };

  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("blur", onBlur);

  // フォーカスして全選択。 モバイルは focus 後に caret を tap 位置に置く挙動があり、
  // 1度だけの全選択では collapse することがあるので、 rAF + 0ms + 50ms の 3 タイミングで
  // 再適用する。 shadow root 経由の selection 取得にも対応 (Chromium 90+)。
  const win = el.ownerDocument.defaultView;
  const selectAll = () => {
    const rootNode = el.getRootNode();
    let sel: Selection | null = null;
    if (rootNode instanceof ShadowRoot && typeof (rootNode as ShadowRoot & { getSelection?: () => Selection | null }).getSelection === "function") {
      sel = (rootNode as ShadowRoot & { getSelection?: () => Selection | null }).getSelection!();
    } else {
      sel = el.ownerDocument.getSelection();
    }
    if (!sel) return;
    try {
      sel.removeAllRanges();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
    } catch {
      // selection 取得失敗も typing は可能なので noop
    }
  };
  const runFocus = () => {
    el.focus();
    selectAll();
    win?.setTimeout(selectAll, 0);
    win?.setTimeout(selectAll, 50);
  };
  if (opts.immediate) {
    runFocus();
  } else if (win && typeof win.requestAnimationFrame === "function") {
    win.requestAnimationFrame(runFocus);
  } else {
    runFocus();
  }
}

// --- 属性編集 ---

export function editAttribute(target: Element, name: string, value: string): boolean {
  try {
    target.setAttribute(name, value);
    return true;
  } catch {
    return false;
  }
}

export function addAttribute(target: Element, name: string, value: string): boolean {
  if (target.hasAttribute(name)) return false;
  return editAttribute(target, name, value);
}

export function removeAttributeOn(target: Element, name: string): boolean {
  if (!target.hasAttribute(name)) return false;
  try {
    target.removeAttribute(name);
    return true;
  } catch {
    return false;
  }
}

// --- style 編集 (inline / cssRule 統一) ---

function parseValueAndPriority(value: string): { value: string; priority: "" | "important" } {
  const m = value.match(/^(.*?)\s*!important\s*$/i);
  if (m) return { value: m[1]!.trim(), priority: "important" };
  return { value: value.trim(), priority: "" };
}

export function editStyleProperty(source: EditableStyleSource, name: string, raw: string): boolean {
  if (source.kind === "read-only") return false;
  const { value, priority } = parseValueAndPriority(raw);
  try {
    source.style.setProperty(name, value, priority);
    return true;
  } catch {
    return false;
  }
}

export function addStyleProperty(source: EditableStyleSource, name: string, raw: string): boolean {
  if (source.kind === "read-only") return false;
  if (source.style.getPropertyValue(name)) return false;
  return editStyleProperty(source, name, raw);
}

export function removeStyleProperty(source: EditableStyleSource, name: string): boolean {
  if (source.kind === "read-only") return false;
  try {
    source.style.removeProperty(name);
    return true;
  } catch {
    return false;
  }
}

/** プロパティ名 変更。oldName を removeProperty してから newName で setProperty。 */
export function renameStyleProperty(
  source: EditableStyleSource,
  oldName: string,
  newName: string,
): boolean {
  if (source.kind === "read-only") return false;
  if (oldName === newName) return true;
  const value = source.style.getPropertyValue(oldName);
  const priority = source.style.getPropertyPriority(oldName);
  if (!value) return false;
  try {
    source.style.removeProperty(oldName);
    source.style.setProperty(newName, value, priority);
    return true;
  } catch {
    return false;
  }
}

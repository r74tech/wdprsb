// frontmatter + 区切り + 本文 のドキュメント形式パーサ。
//
// 形式:
//   pathname: my-page
//   tags: alpha beta
//   title: タイトル
//   -----
//   **本文** Wikitext...
//
// frontmatterは「ドキュメント先頭の key: value 行の連なり」で、5本以上のハイフン行
// (`-----`) で終端する。先頭が key: value でない、または終端行が無い場合はfrontmatter
// 無しとみなし全体を本文として扱う。本文中の `----`(水平線)とは終端判定で衝突しない。

export interface ParsedDocument {
  /** frontmatterのpathname。未指定ならundefined（呼び出し側がURL等から補完）。 */
  pathname?: string;
  /** frontmatterのtags（空白・カンマ区切りを配列化）。tags指定が無ければundefined。 */
  tags?: string[];
  /** frontmatterのtitle。 */
  title?: string;
  /** 区切り以降の本文Wikitext。 */
  body: string;
  /** frontmatterのその他のkey: valueペア。 */
  meta: Record<string, string>;
}

const DELIMITER = /^-{5,}\s*$/;
const KEY_VALUE = /^([A-Za-z][\w-]*)\s*:\s?(.*)$/;

export function parseDocument(text: string): ParsedDocument {
  const lines = text.split(/\r?\n/);

  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") {
    start++;
  }

  // 先頭が key: value でなければfrontmatter無し
  if (start >= lines.length || !KEY_VALUE.test(lines[start]!)) {
    return { body: text, meta: {} };
  }

  const meta: Record<string, string> = {};
  let delimiterIndex = -1;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (DELIMITER.test(line)) {
      delimiterIndex = i;
      break;
    }
    if (line.trim() === "") {
      continue;
    }
    const m = KEY_VALUE.exec(line);
    if (!m) {
      // 終端前に key: value でも空行でもない行 → frontmatterではない
      return { body: text, meta: {} };
    }
    meta[m[1]!.toLowerCase()] = m[2]!.trim();
  }

  // 終端行が見つからなければ本文扱い
  if (delimiterIndex === -1) {
    return { body: text, meta: {} };
  }

  const body = lines.slice(delimiterIndex + 1).join("\n");
  const { pathname, tags, title, ...rest } = meta;

  return {
    pathname: pathname || undefined,
    tags: parseTags(tags),
    title: title || undefined,
    body,
    meta: rest,
  };
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const tags = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

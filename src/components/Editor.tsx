import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
}

// MVPではWikidot構文ハイライトは無し（素のCodeMirror編集UX）。
// 構文ハイライトは将来 wdpr の @wdprlib/lang-wikidot で対応予定。
export function Editor({ value, onChange }: EditorProps) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={oneDark}
      height="100%"
      style={{ height: "100%", fontSize: 13 }}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        bracketMatching: true,
        foldGutter: false,
      }}
    />
  );
}

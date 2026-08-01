// Fenced-code splitting for the chat transcript, kept import-free (like
// edit.ts and runlog.ts) so `npm test` can exercise it on plain node.
//
// Deliberately not a markdown parser. A coding model's output is prose, fenced
// code and inline code; tables and nested lists are rare enough that pulling in
// remark to render them would cost more than it returns for an offline-first
// app. Add a real parser when something actually reads worse for the lack.

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; code: string; closed: boolean };

const FENCE = /^```([^\n`]*)$/;

/**
 * Split on ``` fences.
 *
 * The transcript renders tokens as they arrive, so the last fence is routinely
 * still open — `closed: false`. An unterminated block has to render as code
 * anyway, or a response would flicker between prose and code as it streams,
 * and code would vanish entirely until its closing fence landed.
 */
export function splitFences(src: string): Segment[] {
  const segments: Segment[] = [];
  let text: string[] = [];
  let code: string[] | null = null;
  let lang = "";

  const flushText = () => {
    if (text.length > 0) segments.push({ kind: "text", text: text.join("\n") });
    text = [];
  };

  for (const line of src.split("\n")) {
    const fence = FENCE.exec(line);
    if (code === null && fence) {
      flushText();
      code = [];
      lang = fence[1].trim();
    } else if (code !== null && fence) {
      segments.push({ kind: "code", lang, code: code.join("\n"), closed: true });
      code = null;
    } else if (code !== null) {
      code.push(line);
    } else {
      text.push(line);
    }
  }

  if (code !== null) segments.push({ kind: "code", lang, code: code.join("\n"), closed: false });
  else flushText();

  return segments.filter((s) => s.kind !== "text" || s.text.trim() !== "");
}

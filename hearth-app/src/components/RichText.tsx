import { useState } from "react";
import { splitFences } from "../lib/markdown";

/** `code` spans inside prose. Only single backticks on one line — a stray
 *  backtick shouldn't reformat the rest of a paragraph. */
const INLINE_CODE = /`([^`\n]+)`/g;

function Prose({ text }: { text: string }) {
  const parts = text.split(INLINE_CODE);
  return (
    <p className="whitespace-pre-wrap px-2 text-[13px] leading-relaxed text-neutral-300">
      {parts.map((part, i) =>
        // split() with one capture group alternates: prose, capture, prose…
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[12px] text-neutral-200">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </p>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded bg-neutral-950 p-2 font-mono text-[12px] leading-relaxed text-neutral-300">
        {code}
      </pre>
      <div className="absolute right-1 top-1 flex items-center gap-1">
        {lang && <span className="text-[10px] text-neutral-600">{lang}</span>}
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 opacity-0 transition-opacity hover:text-neutral-200 group-hover:opacity-100"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Assistant output: prose with fenced code pulled out. Used for both settled
 * messages and the live streaming buffer, so it has to cope with a code block
 * whose closing fence hasn't arrived yet.
 */
export function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      {splitFences(text).map((seg, i) =>
        seg.kind === "code" ? (
          <CodeBlock key={i} lang={seg.lang} code={seg.code} />
        ) : (
          <Prose key={i} text={seg.text} />
        ),
      )}
    </div>
  );
}

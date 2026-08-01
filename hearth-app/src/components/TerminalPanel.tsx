import { useRef, useState } from "react";
import { TerminalPane } from "./TerminalPane";
import { userPty } from "../lib/terminal";

/**
 * The terminal tabs. Every tab stays mounted and is hidden rather than
 * unmounted — unmounting closes its PTY, so switching tabs would kill whatever
 * was running in the one you switched away from.
 */
export function TerminalPanel({ root, visible }: { root: string; visible: boolean }) {
  const nextId = useRef(1);
  const [ids, setIds] = useState<string[]>(() => [userPty(0)]);
  const [active, setActive] = useState(() => userPty(0));

  function addTab() {
    // Ids are never reused: a fresh tab must not inherit a PTY that a closing
    // tab is still tearing down.
    const id = userPty(nextId.current++);
    setIds((v) => [...v, id]);
    setActive(id);
  }

  function closeTab(id: string) {
    // Dropping it from the list is the whole job: unmounting the pane is what
    // closes the shell, in TerminalPane's cleanup.
    const next = ids.filter((x) => x !== id);
    setIds(next);
    if (id === active) setActive(next[next.length - 1] ?? "");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-900 px-1">
        {ids.map((id, i) => (
          <div
            key={id}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
              id === active ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:bg-neutral-800"
            }`}
          >
            <button onClick={() => setActive(id)}>{i + 1}</button>
            <button
              onClick={() => closeTab(id)}
              title="Close terminal"
              className="text-neutral-500 hover:text-neutral-200"
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={addTab}
          title="New terminal"
          className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          +
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {ids.length === 0 ? (
          <button
            onClick={addTab}
            className="flex h-full w-full items-center justify-center text-[12px] text-neutral-600 hover:text-neutral-400"
          >
            New terminal
          </button>
        ) : (
          ids.map((id) => (
            <div key={id} className={`absolute inset-0 ${id === active ? "" : "hidden"}`}>
              <TerminalPane id={id} root={root} visible={visible && id === active} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

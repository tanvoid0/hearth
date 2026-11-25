import { chat, currentModel, currentNumCtx } from "./ollama";
import { codeFromReply } from "./markdown";

/**
 * Build plan §12's inline edit: rewrite the selection, in place.
 *
 * A single tool-free call rather than an agent turn. The agent's loop exists to
 * find things and check its work; neither applies when the user has already
 * pointed at the code and is watching the result land in the editor — and the
 * loop's cost (a dozen calls, a project-wide type check) would be paid on a
 * two-line change.
 *
 * Nothing is written to disk: the replacement goes into the editor buffer, so
 * it's undoable with Ctrl+Z and only reaches the file when you save. That's
 * also why this needs no approval gate.
 */
const SYSTEM = [
  "You rewrite one selected region of a source file.",
  "Reply with the replacement code and nothing else: no explanation, no commentary, no markdown fences.",
  "Keep the indentation of the original selection — the replacement is pasted back exactly where it came from.",
  "Change only what the instruction asks for.",
].join("\n");

export async function inlineEdit(opts: {
  path: string;
  language: string;
  selection: string;
  instruction: string;
  onToken?: (text: string) => void;
  cancelId?: string;
}): Promise<string> {
  const model = currentModel();
  if (!model) throw new Error("no model selected — pick one in the agent panel");

  const { message: reply } = await chat(
    model,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `File: ${opts.path} (${opts.language})`,
          `Instruction: ${opts.instruction}`,
          "",
          "Selected code:",
          opts.selection,
        ].join("\n"),
      },
    ],
    [],
    opts.onToken ?? (() => {}),
    currentNumCtx(),
    opts.cancelId ?? ""
  );

  const code = codeFromReply(reply.content);
  // An empty reply would silently delete the selection, which is the one
  // outcome nobody asked for.
  if (!code.trim()) throw new Error("the model returned nothing");
  return code;
}

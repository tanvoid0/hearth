// The app's agent loop, run outside the app.
//
// Extracted from tool-probe.ts when a second harness needed the same thing.
// Everything that decides how a turn goes — the system prompt, the tool
// definitions, the PLAN step, history packing, loop detection, the finish
// verification and its repair rounds — is imported from the app's `src/lib`
// rather than copied, because a harness measuring a loop the app no longer
// runs is worse than no measurement. That drift has already cost this spike
// twice.
//
// What a caller supplies is the *world*: how a tool call is answered, and what
// counts as a blocking error. The probe's is canned and deterministic; the
// loop-spike's is a real fixture with a real type check.

import { chat, type ChatMessage } from "./ollama.js";
import { PLAN_ACK, PLAN_PROMPT, TOOL_DEFS, systemPrompt } from "../../src/lib/agent.ts";
import { contextLimits, packHistory, stalled, worthRepairing } from "../../src/lib/session.ts";

/** Build plan §6's caps, and the app's. */
const MAX_ITERATIONS = 15;
const MAX_REPAIR_ROUNDS = 3;
const MAX_IDENTICAL_CALLS = 3;
/** What ollama.ts already sends. Named here because `contextLimits` needs it. */
const NUM_CTX = 8192;

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** The half of a turn that isn't the loop: answering tools, and judging the
 *  end state. `dispatch` must not throw — the app hands a failing tool's error
 *  back to the model as a result it can recover from. */
export interface World {
  dispatch(name: string, args: any): Promise<ToolResult>;
  /** Mirrors `verify()` in agent.ts: how many blocking errors remain, and the
   *  report the model is handed when they do. */
  verify(): Promise<{ blocking: number; report: string }>;
}

export interface LoopResult {
  /** Tool names in order, with `get_errors[N]` numbered and `repair[N]`
   *  marking a bounced finish. */
  trace: string[];
  finishedVia: "finish_call" | "no_tool_call" | "max_iterations" | "loop_detected";
  /** How many times `finish` was bounced. 0 means it verified before claiming. */
  repairRounds: number;
  /** Blocking errors when the turn ended, or -1 if it ended without a verify —
   *  which is what a conversational reply that changed nothing does. */
  remaining: number;
  /** Whether anything was written to disk this turn. */
  wrote: boolean;
  iterations: number;
  planText: string;
  messages: ChatMessage[];
}

export async function appLoop(opts: {
  model: string;
  root: string;
  task: string;
  world: World;
  /** The tab the system prompt says is open, if any. */
  activeFile?: string | null;
  /** The PLAN step. The app defaults it on. */
  plan?: boolean;
}): Promise<LoopResult> {
  const { model, root, task, world } = opts;
  const { history: budget } = contextLimits(NUM_CTX);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(root, opts.activeFile) },
    { role: "user", content: task },
  ];
  const trace: string[] = [];
  /** One entry per tool call: the call and what it returned. See `stalled`. */
  const signatures: string[] = [];
  let repairRounds = 0;
  let wrote = false;
  /** Reset on every bounce — see `worthRepairing`. */
  let wroteSinceRepair = false;
  let remaining = -1;
  let planText = "";
  let iterations = 0;
  let finishedVia: LoopResult["finishedVia"] = "max_iterations";

  const numberedTrace = (name: string) =>
    name === "get_errors"
      ? `get_errors[${trace.filter((t) => t.startsWith("get_errors")).length + 1}]`
      : name;

  if (opts.plan) {
    messages.push({ role: "user", content: PLAN_PROMPT });
    // no tools: the point is the thinking, not an early edit
    const { message: planned } = await chat(model, packHistory(messages, budget), []);
    messages.push(planned);
    messages.push({ role: "user", content: PLAN_ACK });
    planText = planned.content.trim();
    trace.push("plan");
  }

  for (; iterations < MAX_ITERATIONS; iterations++) {
    // Send a windowful, keep the whole thing — one file read can grow the list
    // past the window mid-turn, so this is re-packed every iteration.
    const { message } = await chat(model, packHistory(messages, budget), TOOL_DEFS);
    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      // Stopping without finishing is a real exit, not a repair opportunity —
      // the model may be asking a question, and answering one with a build log
      // is worse than useless. But a turn that *wrote* and then trailed off is
      // how a weak model usually fails, so say so rather than pass it off.
      finishedVia = "no_tool_call";
      if (wrote) remaining = (await world.verify()).blocking;
      break;
    }

    let done = false;
    for (const call of calls) {
      const name = call.function.name;
      let args: any = call.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          trace.push(`${name}(bad JSON)`);
          messages.push({ role: "tool", tool_name: name, content: "error: arguments were not valid JSON" });
          continue;
        }
      }

      trace.push(numberedTrace(name));

      if (name === "finish") {
        // Don't take its word for it. Declaring victory on a broken build is
        // the failure this whole net exists to catch.
        const verdict = await world.verify();
        if (verdict.blocking > 0 && worthRepairing(repairRounds, MAX_REPAIR_ROUNDS, wroteSinceRepair)) {
          repairRounds++;
          wroteSinceRepair = false;
          trace.push(`repair[${repairRounds}]`);
          messages.push({
            role: "tool",
            tool_name: name,
            content: `not finished — ${verdict.blocking} error(s) still reported. Fix them, then call finish again.\n\n${verdict.report}`,
          });
          continue; // `done` stays false, so the loop carries on
        }
        done = true;
        remaining = verdict.blocking;
        messages.push({ role: "tool", tool_name: name, content: "turn finished" });
        continue;
      }

      const result = await world.dispatch(name, args);
      if (result.ok && (name === "edit_file" || name === "write_file")) wrote = wroteSinceRepair = true;
      messages.push({ role: "tool", tool_name: name, content: result.output });

      signatures.push(`${name}:${JSON.stringify(args ?? null)}:${result.output}`);
      if (stalled(signatures, MAX_IDENTICAL_CALLS)) {
        trace.push("stalled");
        done = true;
        finishedVia = "loop_detected";
      }
    }

    if (done) {
      if (finishedVia !== "loop_detected") finishedVia = "finish_call";
      break;
    }
  }

  return { trace, finishedVia, repairRounds, remaining, wrote, iterations: iterations + 1, planText, messages };
}

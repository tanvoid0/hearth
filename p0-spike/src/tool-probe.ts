// Does a model actually use `get_errors` after it edits a file?
//
// Narrower than the spike next door: that one asks whether a model can hold a
// tool loop at all, this one asks whether it follows the one instruction the
// error feedback loop depends on. Run it when picking a default model, or
// after changing the system prompt.
//
//   npm run probe -- gemma4:latest llama3.1:8b
//
// The loop itself is the app's, via `appLoop` — see app-loop.ts. What lives
// here is the *world* it runs in: a small canned one, so a run is
// deterministic. The file tools are reimplemented on node fs because the app's
// own dispatchTool goes through Tauri invoke, which has no meaning outside the
// app — and the file layer isn't what's under test here.

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appLoop, type ToolResult, type World } from "./app-loop.js";
import { applyEdits } from "../../src/lib/edit.ts";
import { consoleTail, devLogTail } from "../../src/lib/runlog.ts";
import { problemTail } from "../../src/lib/problems.ts";
import { exportedSymbols, formatRepoMap, isSourceFile } from "../../src/lib/repomap.ts";

// A real vite transform error, as it appears on the dev server's stdout. Canned
// rather than provoked: the point is a deterministic broken build to react to,
// not to talk a small model into writing one.
const BROKEN_LOG = [
  "  VITE v7.3.6  ready in 224 ms",
  "  ➜  Local:   http://localhost:5173/",
  '7:31:02 PM [vite] Internal server error: Unexpected token, expected "," (7:12)',
  "  Plugin: vite:react-babel",
  "  File: src/App.jsx:7:12",
];
const CLEAN_LOG = [
  "  VITE v7.3.6  ready in 224 ms",
  "  ➜  Local:   http://localhost:5173/",
  "7:31:44 PM [vite] hmr update /src/App.jsx",
];

export interface Scenario {
  id: string;
  files: Record<string, string>;
  task: string;
  /** The tab the system prompt is told is open. */
  open: string;
  /** Ground truth, read back off disk — plenty of models narrate an edit they
   *  never landed, and some land it in the wrong file. */
  applied: (read: (rel: string) => Promise<string>) => Promise<boolean>;
}

/** Three files, and the task names the one to change. Measures the thing the
 *  error feedback loop depends on: does the model check its own work. */
const HEADING: Scenario = {
  id: "heading",
  open: "src/App.jsx",
  task: "Change the heading in src/App.jsx from 'Hello' to 'Hearth'.",
  files: {
    "package.json": JSON.stringify({ name: "probe", type: "module" }, null, 2),
    "src/main.jsx": `import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
    "src/App.jsx": `export default function App() {\n  return (\n    <div className="app">\n      <h1>Hello</h1>\n      <p>Edit src/App.jsx and save to reload.</p>\n    </div>\n  );\n}\n`,
  },
  applied: async (read) => (await read("src/App.jsx")).includes("<h1>Hearth</h1>"),
};

/**
 * Nine files, and the task names no file at all — the string to change lives
 * one directory down, next to a decoy file full of other UI strings.
 *
 * This is the second half of what the probe measures, and it exists because
 * `search`, `repo_map` and PLAN all landed at once and the heading scenario
 * can't see any of them: with three files and the target named, finding costs
 * nothing. Here a model either searches, reads the map, or opens files one at a
 * time until it gets lucky — and those spend very different amounts of a small
 * context window.
 */
const UNFAMILIAR: Scenario = {
  id: "unfamiliar",
  open: "src/App.jsx",
  task:
    "Posts that have no title show the placeholder 'Untitled'. Change that placeholder to read 'Draft' instead. Don't change anything else.",
  files: {
    "package.json": JSON.stringify({ name: "feed", type: "module" }, null, 2),
    "src/main.jsx": `import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
    "src/App.jsx": `import { Feed } from "./components/Feed.jsx";\nimport { Sidebar } from "./components/Sidebar.jsx";\n\nexport default function App() {\n  return (\n    <div className="app">\n      <Sidebar />\n      <Feed />\n    </div>\n  );\n}\n`,
    "src/components/Feed.jsx": `import { posts } from "../lib/posts.js";\nimport { PostCard } from "./PostCard.jsx";\n\nexport function Feed() {\n  return (\n    <main className="feed">\n      {posts.map((post) => (\n        <PostCard key={post.id} post={post} />\n      ))}\n    </main>\n  );\n}\n`,
    "src/components/PostCard.jsx": `import { formatDate } from "../lib/format.js";\n\nexport function PostCard({ post }) {\n  return (\n    <article className="post">\n      <h2>{post.title || "Untitled"}</h2>\n      <time>{formatDate(post.publishedAt)}</time>\n      <p>{post.excerpt}</p>\n    </article>\n  );\n}\n`,
    "src/components/Sidebar.jsx": `import { NAV } from "../lib/copy.js";\n\nexport function Sidebar() {\n  return (\n    <nav className="sidebar">\n      {NAV.map((item) => (\n        <a key={item.href} href={item.href}>\n          {item.label}\n        </a>\n      ))}\n    </nav>\n  );\n}\n`,
    "src/lib/copy.js": `export const NAV = [\n  { href: "/", label: "Home" },\n  { href: "/archive", label: "Archive" },\n  { href: "/about", label: "About" },\n];\n\nexport const SIGN_OUT = "Sign out";\nexport const EMPTY_FEED = "Nothing here yet";\n`,
    "src/lib/format.js": `export function formatDate(iso) {\n  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });\n}\n`,
    "src/lib/posts.js": `export const posts = [\n  { id: "1", title: "Hello", excerpt: "First post.", publishedAt: "2026-03-03" },\n  { id: "2", title: "", excerpt: "This one never got a title.", publishedAt: "2026-03-04" },\n];\n`,
  },
  applied: async (read) => {
    const card = await read("src/components/PostCard.jsx");
    const copy = await read("src/lib/copy.js");
    // In the right place, with the old string gone, and without taking the
    // decoy's strings with it. Either quote style — JSX takes both, and which
    // one a model reaches for says nothing about whether it found the file.
    return /["']Draft["']/.test(card) && !card.includes("Untitled") && copy.includes("Sign out");
  },
};

export const SCENARIOS = [HEADING, UNFAMILIAR];

export interface ProbeResult {
  model: string;
  scenario: string;
  wallSec: number;
  trace: string;
  finishedVia: "finish_call" | "no_tool_call" | "max_iterations" | "loop_detected";
  /** The thing being measured: did it check its own work at all? */
  checkedAfterEdit: boolean;
  /** And did it check again after repairing, or declare victory blind? */
  rechecked: boolean;
  /** How many times `finish` was bounced back because the build was still
   *  broken — the P10 auto-repair rounds. 0 means it verified before saying so. */
  repairRounds: number;
  /** Ground truth — plenty of models narrate an edit they never landed. */
  applied: boolean;
  /** How it went about finding the file, which is the second scenario's whole
   *  question: the two P11 tools, against reading files one at a time. */
  usedSearch: boolean;
  usedRepoMap: boolean;
  filesRead: number;
  /** Whatever it chose to shell out for, verbatim. */
  commands: string[];
}

async function scaffold(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hearth-probe-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return dir;
}

export async function probe(model: string, scenario: Scenario = HEADING): Promise<ProbeResult> {
  const FILES = scenario.files;
  const root = await scaffold(FILES);
  // A small canned world, so the run is deterministic: the build is broken, and
  // an edit fixes it only once the model has actually been shown the error.
  // `told` is set by get_errors *and* by a bounced finish, which carry the same
  // information.
  let told = false;
  let repaired = false;
  const commandCalls: string[] = [];
  const readRel = (rel: string) => fs.readFile(path.join(root, rel), "utf8").catch(() => "");

  /** What the app's get_errors returns, through the app's own formatters. */
  const errorReport = () =>
    [
      problemTail("ok", [], root),
      devLogTail("ready", "http://localhost:5173/", repaired ? CLEAN_LOG : BROKEN_LOG),
      consoleTail(false, []),
    ].join("\n\n");

  async function run(name: string, args: any): Promise<string> {
    const rel = String(args?.path ?? "");
    const target = path.join(root, rel);
    switch (name) {
      case "list_files":
        return Object.keys(FILES).join("\n");
      case "read_file":
        return fs.readFile(target, "utf8");
      case "edit_file": {
        const before = await fs.readFile(target, "utf8").catch(() => null);
        if (before === null) return `error: ${rel} does not exist`;
        const { content, failures } = applyEdits(before, args?.edits ?? []);
        if (failures.length) return `edit_file failed, no changes applied:\n${failures.join("\n\n")}`;
        await fs.writeFile(target, content, "utf8");
        if (told) repaired = true;
        return `applied edit(s) to ${rel}`;
      }
      case "write_file":
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, args?.content ?? "", "utf8");
        return `created ${rel}`;
      // The two P11 tools. Answerable rather than faithful: a model that calls
      // one and gets "unknown tool" back would skew the measurement this probe
      // exists for, and the canned world is three files deep.
      case "search": {
        const needle = String(args?.query ?? "").toLowerCase();
        const hits = Object.entries(FILES).flatMap(([file, body]) =>
          body
            .split("\n")
            .map((line, i) => ({ file, i, line }))
            .filter(({ line }) => line.toLowerCase().includes(needle))
            .map(({ file, i, line }) => `${file}:${i + 1}: ${line.trim()}`),
        );
        return hits.length > 0 ? hits.join("\n") : `no matches for "${args?.query ?? ""}"`;
      }
      case "repo_map":
        return formatRepoMap(
          Object.entries(FILES)
            .filter(([file]) => isSourceFile(file))
            .map(([file, body]) => ({ path: file, symbols: exportedSymbols(body) })),
        );
      case "get_errors":
        // All three of the app's sources, through the app's own formatters —
        // the model has to see the shape it will really be handed, or the
        // instruction-following this measures is being measured against a
        // different tool. Type checking reports clean because the task's edit
        // introduces no type error; the dev log is the canned thing to react to,
        // and no preview is attached in a probe, which `consoleTail` says
        // rather than passing off as silence.
        told = true;
        return errorReport();
      case "run_command": {
        // The app runs this through Rust, behind an allowlist. Here it only has
        // to be answerable — a model that calls it and gets "unknown tool" back
        // would skew the measurement this probe exists for.
        const command = String(args?.command ?? "");
        commandCalls.push(command);
        const done = spawnSync(command, { cwd: root, encoding: "utf8", shell: true, timeout: 60_000 });
        return `exited ${done.status ?? -1}\n\n${(done.stdout ?? "") + (done.stderr ?? "") || "(no output)"}`;
      }
      default:
        return `error: unknown tool '${name}'`;
    }
  }

  const world: World = {
    // Mirrors dispatchTool's outer try/catch: a throwing tool is an error
    // message the model gets a chance to recover from, not a dead run.
    dispatch: (name, args): Promise<ToolResult> =>
      run(name, args).then(
        (output) => ({ ok: !output.startsWith("error:") && !output.startsWith("edit_file failed"), output }),
        (err: Error) => ({ ok: false, output: `error: ${err.message}` }),
      ),
    // Ground truth is part of the verdict, not just `repaired`. The canned
    // world only clears on a successful edit made *after* being shown the
    // error — so a model that got it right on its first edit has nothing left
    // to change, every later edit fails to match, and it would burn all three
    // rounds being told to fix an already-fixed file. The app checks real
    // errors here; the probe checks whether the task is done.
    verify: async () => {
      const trulyDone = repaired || (await scenario.applied(readRel));
      told = true;
      return { blocking: trulyDone ? 0 : 1, report: errorReport() };
    },
  };

  const start = Date.now();
  const run_ = await appLoop({ model, root, task: scenario.task, world, activeFile: scenario.open });
  const wallSec = +((Date.now() - start) / 1000).toFixed(1);

  const applied = await scenario.applied(readRel).catch(() => false);
  await fs.rm(root, { recursive: true, force: true });

  const { trace } = run_;
  const firstEdit = trace.findIndex((t) => t === "edit_file" || t === "write_file");

  return {
    model,
    scenario: scenario.id,
    wallSec,
    trace: trace.join(" → "),
    finishedVia: run_.finishedVia,
    checkedAfterEdit: firstEdit >= 0 && trace.slice(firstEdit + 1).some((t) => t.startsWith("get_errors")),
    rechecked: trace.filter((t) => t.startsWith("get_errors")).length >= 2,
    repairRounds: run_.repairRounds,
    applied,
    usedSearch: trace.includes("search"),
    usedRepoMap: trace.includes("repo_map"),
    filesRead: trace.filter((t) => t === "read_file").length,
    commands: commandCalls,
  };
}

// `--scenario <id>` narrows to one; by default a model runs both, since they
// measure different things and neither is worth having on its own.
const argv = process.argv.slice(2);
const pick = argv.indexOf("--scenario");
const chosen = pick >= 0 ? SCENARIOS.filter((s) => s.id === argv[pick + 1]) : SCENARIOS;
const models = argv.filter((a, i) => !a.startsWith("--") && (pick < 0 || i !== pick + 1));

if (models.length === 0 || chosen.length === 0) {
  console.error(`usage: npm run probe -- [--scenario ${SCENARIOS.map((s) => s.id).join("|")}] <model> [model...]`);
  process.exit(1);
}
for (const model of models) {
  for (const scenario of chosen) {
    console.log(`\n=== ${model} / ${scenario.id} ===`);
    try {
      console.log(JSON.stringify(await probe(model, scenario), null, 2));
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }
}

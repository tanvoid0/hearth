// What a new project *is* — naming rules and the starter scaffold. Kept
// import-free (like edit.ts and session.ts) so `npm test` runs it on plain node.

/**
 * Presence of this file is what makes a directory a project rather than a
 * folder you happen to keep projects in. That distinction is the whole
 * grouping mechanism: workspace/foo/ with a marker is a project, without one
 * it's a group and its children are scanned instead.
 *
 * `.hearth` is already in the file tree's skip list, so the marker never shows
 * up in the explorer.
 */
export const MARKER = ".hearth/project.json";

// Dropped from generated names — leading imperatives plus connectors that
// carry no meaning in a folder name. Deliberately small: over-stripping
// produces worse names than leaving a filler word in.
const NOISE = new Set([
  "a", "an", "the", "me", "my", "please", "i", "want", "need",
  "build", "create", "make", "write", "generate", "app-for",
  "with", "that", "which", "for", "and", "using", "in", "of", "to", "some", "it",
]);

const MAX_WORDS = 4;

/**
 * Derive a folder name from the user's prompt. Deliberately not a model call:
 * that would put a load-and-generate wait in front of a directory that doesn't
 * exist yet, for a name a regex gets right.
 */
export function slugify(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !NOISE.has(w));

  const name = words.slice(0, MAX_WORDS).join("-").slice(0, 40).replace(/-+$/, "");
  return name || "project";
}

/** Append -2, -3 … until the name is free. Compared case-insensitively: two
 *  projects differing only in case would collide on Windows. */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Forwards the running app's runtime errors to the preview pane, which feeds
 * them to the agent through `get_errors`. Without this the agent only sees
 * vite's build output — and the common failure of generated React is code that
 * compiles fine and then throws in the browser, leaving a white screen that
 * neither the user nor the model can explain.
 *
 * It has to be served by the dev server rather than injected by Hearth: the
 * preview iframe is a different origin (`localhost:PORT` vs `tauri.localhost`),
 * so the parent can't reach into it.
 *
 * ponytail: scaffolded projects only — a folder opened from outside Hearth has
 * no bridge and `consoleTail` says so. Injecting into arbitrary projects means
 * a vite plugin and a wrapped config; do that when opened repos become the
 * common case.
 */
const CONSOLE_BRIDGE = `    <!-- Hearth: forwards runtime errors to the preview pane. Safe to delete. -->
    <script>
      (function () {
        var send = function (kind, text) {
          try {
            parent.postMessage({ source: "hearth", kind: kind, text: String(text).slice(0, 2000) }, "*");
          } catch (e) {}
        };
        var fmt = function (args) {
          return Array.prototype.map
            .call(args, function (a) {
              if (a instanceof Error) return a.stack || a.message;
              if (typeof a === "string") return a;
              try {
                return JSON.stringify(a);
              } catch (e) {
                return String(a);
              }
            })
            .join(" ");
        };
        ["error", "warn"].forEach(function (kind) {
          var orig = console[kind];
          console[kind] = function () {
            send(kind, fmt(arguments));
            orig.apply(console, arguments);
          };
        });
        addEventListener("error", function (e) {
          send("error", e.message + " (" + e.filename + ":" + e.lineno + ")");
        });
        addEventListener("unhandledrejection", function (e) {
          send("error", "Unhandled rejection: " + ((e.reason && e.reason.stack) || e.reason));
        });
        send("ready", "");
      })();
    </script>
`;

/**
 * Starter scaffold, written before the agent ever runs.
 *
 * This is what makes prompt-first viable: a local model authoring
 * package.json + vite config + entry + component from an empty directory is a
 * dozen-plus tool calls, and any one of them getting the wiring subtly wrong
 * breaks the project before the user sees anything. Editing an existing,
 * known-good scaffold is the job it actually did well in P0.
 *
 * JSX rather than TSX on purpose: no type errors to chase until P9 puts an
 * LSP behind the agent.
 */
export function template(name: string): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      {
        name,
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { react: "^19.1.0", "react-dom": "^19.1.0" },
        devDependencies: { "@vitejs/plugin-react": "^4.6.0", vite: "^7.0.4" },
      },
      null,
      2,
    ) + "\n",

    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
${CONSOLE_BRIDGE}  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,

    "vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,

    "src/main.jsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,

    "src/App.jsx": `export default function App() {
  return (
    <main>
      <h1>${name}</h1>
      <p>Empty scaffold — ask the agent to build something here.</p>
    </main>
  );
}
`,

    "src/index.css": `:root {
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}

body {
  margin: 0;
  padding: 2rem;
}
`,

    ".gitignore": `node_modules
dist
.env
`,
  };
}

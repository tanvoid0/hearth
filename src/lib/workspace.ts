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
 * Scaffolded projects get it inlined in their `index.html`; anything else gets
 * it through `bridgeConfig` below. The guard at the top is what makes running
 * both harmless — a scaffolded project opened through the wrapped config would
 * otherwise patch `console` twice and report everything twice.
 */
export const BRIDGE_JS = `(function () {
  if (window.__hearthBridge) return;
  window.__hearthBridge = 1;
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
  // The network half of plan §4's browser panel. Reported as "net" rather than
  // "error" on purpose: a 404 from an API the user doesn't control is not the
  // agent's bug to fix, and counting it as one would spend every repair round
  // on somebody else's server. No timing in the text, so a poll collapses into
  // one line with a count instead of filling the buffer.
  // The element picker of plan §12. It lives here rather than in the preview
  // pane for the same reason the console patch does: the iframe is a different
  // origin, so the parent can't attach a listener to the page. Capture-phase
  // listeners, so a button's own onClick doesn't get there first and navigate
  // away from the thing being pointed at.
  var picking = false;
  var hovered = null;
  var mark = function (el, on) {
    if (el && el.style) el.style.outline = on ? "2px solid #38bdf8" : "";
  };
  var describe = function (el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      var part = n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift(part + "#" + n.id);
        break;
      }
      if (n.className && typeof n.className === "string") {
        part += "." + n.className.trim().split(/\\s+/).slice(0, 2).join(".");
      }
      parts.unshift(part);
    }
    var text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    return parts.join(" > ") + (text ? ' — "' + text + '"' : "");
  };
  addEventListener("message", function (e) {
    if (!e.data || e.data.source !== "hearth-parent") return;
    picking = !!e.data.picking;
    if (!picking) {
      mark(hovered, false);
      hovered = null;
    }
  });
  addEventListener(
    "mouseover",
    function (e) {
      if (!picking) return;
      mark(hovered, false);
      hovered = e.target;
      mark(hovered, true);
    },
    true
  );
  addEventListener(
    "click",
    function (e) {
      if (!picking) return;
      e.preventDefault();
      e.stopPropagation();
      picking = false;
      mark(e.target, false);
      hovered = null;
      send("picked", describe(e.target));
    },
    true
  );

  var fetched = window.fetch;
  if (fetched) {
    window.fetch = function () {
      var url = String((arguments[0] && arguments[0].url) || arguments[0] || "");
      return fetched.apply(this, arguments).then(
        function (res) {
          send("net", res.status + " " + url);
          return res;
        },
        function (err) {
          send("net", "failed " + url + " — " + err);
          throw err;
        }
      );
    };
  }
  send("ready", "");
})();
`;

const CONSOLE_BRIDGE = `    <!-- Hearth: forwards runtime errors to the preview pane. Safe to delete. -->
    <script>
${BRIDGE_JS.replace(/^/gm, "      ").trimEnd()}
    </script>
`;

/** Where the generated config is written, relative to the project root. Under
 *  `.hearth/` so it's already excluded from checkpoints and the file tree, and
 *  so it isn't a name vite searches for on its own — which is what stops the
 *  wrapper below finding itself. */
export const BRIDGE_CONFIG_REL = ".hearth/vite.hearth.mjs";

/**
 * A vite config that wraps the project's own and injects the console bridge.
 *
 * This is what extends `get_errors` past projects Hearth scaffolded. The
 * alternative — writing the snippet into the user's `index.html` — is a change
 * to their repo that they didn't ask for and would have to keep deleting.
 *
 * ponytail: vite only. A Next/webpack project opened here still runs, and
 * `consoleTail` still says the bridge isn't connected; wire those up when a
 * non-vite project is actually the thing someone is working on.
 */
export function bridgeConfig(): string {
  return `// Generated by Hearth on every run — edit \`bridgeConfig\` in the app instead.
// Wraps this project's own vite config and injects the console bridge, so
// runtime errors in the preview reach the agent.
import { defineConfig, loadConfigFromFile, mergeConfig } from "vite";

const bridge = {
  name: "hearth-console-bridge",
  transformIndexHtml(html) {
    return {
      html,
      tags: [{ tag: "script", children: ${JSON.stringify(BRIDGE_JS)}, injectTo: "head-prepend" }],
    };
  },
};

export default defineConfig(async (env) => {
  // The project's real config, found the way vite would have found it. This
  // file isn't a name vite searches for, so it can't load itself.
  const own = (await loadConfigFromFile(env, undefined, process.cwd()))?.config ?? {};
  // Pinning the root matters because a config loaded from elsewhere resolves
  // relative paths against its own directory — but only pin it when the project
  // hasn't deliberately pointed vite at a subdirectory of its own.
  return mergeConfig(own, { plugins: [bridge], ...(own.root ? {} : { root: process.cwd() }) });
});
`;
}

/**
 * Starter scaffold, written before the agent ever runs.
 *
 * This is what makes prompt-first viable: a local model authoring
 * package.json + vite config + entry + component from an empty directory is a
 * dozen-plus tool calls, and any one of them getting the wiring subtly wrong
 * breaks the project before the user sees anything. Editing an existing,
 * known-good scaffold is the job it actually did well in P0.
 *
 * JSX rather than TSX on purpose: annotations a local model has to get right
 * are a tax on every edit. The jsconfig below buys most of what TSX would —
 * undefined names, wrong argument counts, misspelled DOM props — without asking
 * it to write a single type.
 */
export type TemplateKind = "react" | "vanilla";

/** What the home screen offers. Two, not ten: a starter nobody picks is a
 *  starter nobody maintains, and the agent's first job on any of them is to
 *  replace most of it anyway. */
export const TEMPLATES: Array<{ kind: TemplateKind; label: string; hint: string }> = [
  { kind: "react", label: "React", hint: "Vite + React, JSX" },
  { kind: "vanilla", label: "Vanilla", hint: "Vite, plain JS and CSS" },
];

/**
 * What turns the language server on for a plain-JS project. Without a tsconfig
 * or jsconfig, tsserver files everything under an "inferred project" and
 * reports no diagnostics at all — which is indistinguishable from a clean
 * project, for the user and for the agent.
 */
function jsconfig(jsx: boolean): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          // The whole point: type-check .js/.jsx without writing any types.
          checkJs: true,
          ...(jsx ? { jsx: "react-jsx" } : {}),
          module: "esnext",
          moduleResolution: "bundler",
          target: "esnext",
          lib: ["esnext", "dom", "dom.iterable"],
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n"
  );
}

function indexHtml(name: string, entry: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
${CONSOLE_BRIDGE}  </head>
  <body>
${body}
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;
}

const GITIGNORE = `node_modules
dist
.env
`;

export function template(name: string, kind: TemplateKind = "react"): Record<string, string> {
  return kind === "vanilla" ? vanilla(name) : react(name);
}

/** No framework, no build-time JSX — the same runner, preview and type checking
 *  with nothing between the file and the page. */
function vanilla(name: string): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      {
        name,
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        devDependencies: { vite: "^7.0.4" },
      },
      null,
      2,
    ) + "\n",

    "jsconfig.json": jsconfig(false),

    "index.html": indexHtml(name, "/src/main.js", '    <div id="app"></div>'),

    "src/main.js": `import "./style.css";

document.querySelector("#app").innerHTML = \`
  <main>
    <h1>${name}</h1>
    <p>Empty scaffold — ask the agent to build something here.</p>
  </main>
\`;
`,

    "src/style.css": `:root {
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}

body {
  margin: 0;
  padding: 2rem;
}
`,

    ".gitignore": GITIGNORE,
  };
}

function react(name: string): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      {
        name,
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { react: "^19.1.0", "react-dom": "^19.1.0" },
        devDependencies: {
          "@vitejs/plugin-react": "^4.6.0",
          vite: "^7.0.4",
          // Not optional decoration: without React's types every JSX file
          // reports "Cannot find module 'react'" and nothing else can be
          // checked past it — measured, not assumed.
          "@types/react": "^19.1.0",
          "@types/react-dom": "^19.1.0",
        },
      },
      null,
      2,
    ) + "\n",

    "jsconfig.json": jsconfig(true),

    "index.html": indexHtml(name, "/src/main.jsx", '    <div id="root"></div>'),

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

    ".gitignore": GITIGNORE,
  };
}

import React from "react";
import ReactDOM from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import App from "./App";
import { registerLanguageFeatures } from "./lib/monaco-ts";
import "./index.css";

// Self-host Monaco instead of the @monaco-editor/react default of fetching
// it from a CDN — this app has to work fully offline.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};
loader.config({ monaco });

// Hover, go-to-definition, symbols and diagnostics come from tsserver, which
// can see the filesystem — Monaco's own worker can't, so it reports every
// import as unresolvable. Registered here rather than lazily so the handover
// happens before the first editor mounts.
registerLanguageFeatures();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

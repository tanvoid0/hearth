import * as monaco from "monaco-editor";
import { request, useLsp } from "./lsp";
import { normalizePath, problemsIn } from "./problems";

/**
 * Monaco's side of the language server: markers in the editor, and hover,
 * go-to-definition and document symbols served from tsserver.
 *
 * Split from `lsp.ts` because importing Monaco anywhere in the agent's import
 * graph breaks the P10 probe, which loads `agent.ts` on plain node — Monaco
 * dies on `window is not defined` there. This module subscribes to the store
 * rather than being called by it, so the dependency only points one way.
 */

/** Editor models by path, so diagnostics reach the right one and a cursor
 *  position can be turned back into a filename. Monaco builds its own URIs from
 *  the Windows paths we hand it, and reverse-engineering that mapping is a
 *  worse job than having the editor register itself. */
const models = new Map<string, monaco.editor.ITextModel>();
const modelPaths = new WeakMap<monaco.editor.ITextModel, string>();
const MARKER_OWNER = "hearth-ts";

export function attachModel(path: string, model: monaco.editor.ITextModel) {
  models.set(normalizePath(path), model);
  modelPaths.set(model, path.replace(/\\/g, "/"));
  syncMarkers();
}

function syncMarkers() {
  const { diags } = useLsp.getState();
  for (const [key, model] of models) {
    if (model.isDisposed()) {
      models.delete(key);
      continue;
    }
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      problemsIn(diags, key).map((p) => ({
        startLineNumber: p.line,
        startColumn: p.column,
        endLineNumber: p.endLine,
        endColumn: p.endColumn,
        message: p.text,
        code: `TS${p.code}`,
        severity: p.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      })),
    );
  }
}

// Diagnostics arrive as events, so nothing calls into the editor at the point
// they land — the markers follow the store instead.
useLsp.subscribe((state, previous) => {
  if (state.diags !== previous.diags) syncMarkers();
});

function fileOf(model: monaco.editor.ITextModel): string | null {
  return modelPaths.get(model) ?? null;
}

/** tsserver's `kind` strings, mapped to the icons Monaco already has. Anything
 *  unlisted shows as a variable rather than as nothing. */
const SYMBOL_KINDS: Record<string, monaco.languages.SymbolKind> = {
  module: monaco.languages.SymbolKind.Module,
  class: monaco.languages.SymbolKind.Class,
  interface: monaco.languages.SymbolKind.Interface,
  enum: monaco.languages.SymbolKind.Enum,
  function: monaco.languages.SymbolKind.Function,
  method: monaco.languages.SymbolKind.Method,
  property: monaco.languages.SymbolKind.Property,
  getter: monaco.languages.SymbolKind.Property,
  setter: monaco.languages.SymbolKind.Property,
  const: monaco.languages.SymbolKind.Constant,
  let: monaco.languages.SymbolKind.Variable,
  var: monaco.languages.SymbolKind.Variable,
  alias: monaco.languages.SymbolKind.Namespace,
  type: monaco.languages.SymbolKind.TypeParameter,
};

function toRange(span: any): monaco.IRange {
  return {
    startLineNumber: span.start.line,
    startColumn: span.start.offset,
    endLineNumber: span.end.line,
    endColumn: span.end.offset,
  };
}

function toSymbols(node: any): monaco.languages.DocumentSymbol[] {
  const span = node.spans?.[0];
  if (!span) return [];
  return [
    {
      name: node.text,
      detail: "",
      kind: SYMBOL_KINDS[node.kind] ?? monaco.languages.SymbolKind.Variable,
      tags: [],
      range: toRange(span),
      selectionRange: toRange(node.nameSpan ?? span),
      children: (node.childItems ?? []).flatMap(toSymbols),
    },
  ];
}

let registered = false;

/**
 * Hand Monaco's language features for JS/TS over to tsserver, and take its own
 * away.
 *
 * Monaco ships a TypeScript worker that runs in the browser with no filesystem,
 * so it reports "Cannot find module 'react'" on every import in every file. Two
 * sets of squiggles where one is always wrong is worse than either alone —
 * `setModeConfiguration` is the switch that stops it registering the providers
 * being replaced here. Completions and formatting stay with Monaco: those it
 * does fine, and replacing them isn't this phase.
 */
export function registerLanguageFeatures() {
  if (registered) return;
  registered = true;

  const off = {
    completionItems: true,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: true,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: true,
    signatureHelp: true,
    onTypeFormattingEdits: true,
    codeActions: false,
    inlayHints: false,
  };
  // `monaco.typescript`, not `monaco.languages.typescript` — 0.56 moved the
  // language features to a top-level namespace and left the old path as a
  // deprecated stub that type-checks as `{ deprecated: true }`.
  monaco.typescript.javascriptDefaults.setModeConfiguration(off);
  monaco.typescript.typescriptDefaults.setModeConfiguration(off);

  const languages = ["javascript", "typescript"];

  monaco.languages.registerHoverProvider(languages, {
    async provideHover(model, position) {
      const file = fileOf(model);
      if (!file) return null;
      const info = await request<any>("quickinfo", { file, line: position.lineNumber, offset: position.column });
      if (!info?.displayString) return null;
      return {
        range: toRange(info),
        contents: [
          { value: "```typescript\n" + info.displayString + "\n```" },
          ...(info.documentation ? [{ value: info.documentation }] : []),
        ],
      };
    },
  });

  monaco.languages.registerDefinitionProvider(languages, {
    async provideDefinition(model, position) {
      const file = fileOf(model);
      if (!file) return null;
      const spans = await request<any[]>("definition", { file, line: position.lineNumber, offset: position.column });
      if (!spans?.length) return null;

      // Monaco can only navigate to a model it already has, and this app builds
      // one model per open tab. A definition in another file therefore has to
      // open that file first — stashed on the store and applied by EditorPane
      // when that tab's editor mounts, since the jump outlives this editor.
      const target = spans[0];
      const known = models.get(normalizePath(target.file));
      if (!known || known.isDisposed()) {
        useLsp.setState({ reveal: { path: target.file, line: target.start.line, column: target.start.offset } });
        return null;
      }
      return spans.map((span) => ({ uri: known.uri, range: toRange(span) }));
    },
  });

  // Feeds Monaco's own "Go to symbol" (Ctrl+Shift+O) — build plan §4.1's symbol
  // outline in the half that needs no new UI. The panel and breadcrumbs it also
  // asks for can hang off the same provider whenever there's somewhere to put
  // them.
  monaco.languages.registerDocumentSymbolProvider(languages, {
    async provideDocumentSymbols(model) {
      const file = fileOf(model);
      if (!file) return [];
      const tree = await request<any>("navtree", { file });
      // The root node is the file itself; its children are the symbols.
      return (tree?.childItems ?? []).flatMap(toSymbols);
    },
  });
}

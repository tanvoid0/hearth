import { test } from "node:test";
import assert from "node:assert/strict";
import { exportedSymbols, formatRepoMap, isSourceFile } from "./repomap.ts";

test("exportedSymbols finds every shape a declaration export takes", () => {
  const source = `
import { thing } from "./thing";

export function total(items) {}
export async function load() {}
export function* walk() {}
export const RATE = 0.2;
export let mutable = 1;
export class Store {}
export interface Options {}
export type Handler = () => void;
export enum Mode {}
export default function App() {}
`;
  assert.deepEqual(exportedSymbols(source), [
    "total",
    "load",
    "walk",
    "RATE",
    "mutable",
    "Store",
    "Options",
    "Handler",
    "Mode",
    "App",
  ]);
});

test("exportedSymbols takes the alias from a list export, since that's the importable name", () => {
  const source = `
const internalName = 1;
export { internalName as publicName, other };
export { helper };
`;
  assert.deepEqual(exportedSymbols(source), ["publicName", "other", "helper"]);
});

test("exportedSymbols catches a default re-export of a local name", () => {
  // `export default App;` declares nothing, so neither of the other patterns
  // sees it — and it's how most React components are exported.
  assert.deepEqual(exportedSymbols("function App() {}\nexport default App;\n"), ["App"]);
});

test("exportedSymbols ignores imports and non-exported declarations", () => {
  // The map exists to answer "where does this name live". A local helper isn't
  // findable by name from anywhere else, so listing it is noise.
  const source = `
import { readFile } from "node:fs";
function privateHelper() {}
const notExported = 2;
// export function commentedOut() {}
`;
  assert.deepEqual(exportedSymbols(source), []);
});

test("exportedSymbols reports a name declared and listed only once", () => {
  const source = "export const clamp = 1;\nexport { clamp };\n";
  assert.deepEqual(exportedSymbols(source), ["clamp"]);
});

test("isSourceFile picks up the extensions a project actually uses", () => {
  for (const ok of ["src/a.ts", "src/a.tsx", "src/a.js", "src/a.jsx", "vite.config.mjs", "x.cjs"]) {
    assert.ok(isSourceFile(ok), ok);
  }
  // Declaration files export types with no implementation to go and read.
  for (const no of ["src/types.d.ts", "package.json", "README.md", "src/index.css"]) {
    assert.ok(!isSourceFile(no), no);
  }
});

test("formatRepoMap drops empty files and says when it stopped early", () => {
  const out = formatRepoMap(
    [
      { path: "src/b.js", symbols: ["two"] },
      { path: "src/a.js", symbols: ["one"] },
      { path: "src/empty.js", symbols: [] },
    ],
    true,
  );
  assert.match(out, /src\/a\.js: one\nsrc\/b\.js: two/, "sorted, and the empty file is gone");
  assert.doesNotMatch(out, /empty/);
  // Silently stopping at a cap would read as "that's the whole project".
  assert.match(out, /more files not scanned/);
});

test("formatRepoMap says nothing found rather than returning an empty answer", () => {
  // An empty string reads as "checked, and the project is empty" — which for a
  // Python project or a misplaced root is exactly wrong.
  assert.match(formatRepoMap([]), /no exported symbols found/);
});

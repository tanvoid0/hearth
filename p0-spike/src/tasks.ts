import { pathToFileURL } from "node:url";

export interface VerifyResult {
  pass: boolean;
  detail: string;
}

export interface Task {
  id: string;
  prompt: string;
  verify: (workdir: string) => Promise<VerifyResult>;
}

// Cache-bust dynamic imports: each task run copies the fixture into a fresh
// tmp dir, but Node's ESM loader also caches by resolved URL within a single
// process, and the harness runs many tasks in one process.
function importPath(workdir: string, relPath: string): string {
  return `${pathToFileURL(`${workdir}/${relPath}`).href}?t=${Date.now()}-${Math.random()}`;
}

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

export const TASKS: Task[] = [
  {
    id: "fix-sum-bug",
    prompt:
      "There's a bug in `src/math.ts`: `sum` returns `NaN` for any non-empty array of numbers instead of the correct total. Find and fix it. Do not change the function signature or any other function.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/math.ts"));
      const a = mod.sum([1, 2, 3]);
      const b = mod.sum([]);
      if (a !== 6) return { pass: false, detail: `sum([1,2,3]) === ${a}, expected 6` };
      if (b !== 0) return { pass: false, detail: `sum([]) === ${b}, expected 0` };
      return { pass: true, detail: "sum is correct" };
    },
  },
  {
    id: "add-median",
    prompt:
      "Add a new exported function `median(values: number[]): number` to `src/math.ts`. It returns the median: for an odd-length array, the middle value; for an even-length array, the average of the two middle values. Do not modify existing functions.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/math.ts"));
      if (typeof mod.median !== "function") return { pass: false, detail: "median is not exported" };
      const a = mod.median([1, 3, 2]);
      const b = mod.median([1, 2, 3, 4]);
      if (!approxEqual(a, 2)) return { pass: false, detail: `median([1,3,2]) === ${a}, expected 2` };
      if (!approxEqual(b, 2.5)) return { pass: false, detail: `median([1,2,3,4]) === ${b}, expected 2.5` };
      return { pass: true, detail: "median is correct" };
    },
  },
  {
    id: "average-empty-guard",
    prompt:
      "`average` in `src/math.ts` returns `NaN` when given an empty array (division by zero length). Change it to return `0` for an empty array instead, and leave the non-empty behaviour unchanged.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/math.ts"));
      const empty = mod.average([]);
      const normal = mod.average([2, 4]);
      if (empty !== 0) return { pass: false, detail: `average([]) === ${empty}, expected 0` };
      if (!approxEqual(normal, 3)) return { pass: false, detail: `average([2,4]) === ${normal}, expected 3` };
      return { pass: true, detail: "average is correct" };
    },
  },
  {
    id: "titlecase-multispace",
    prompt:
      "`titleCase` in `src/format.ts` mishandles strings with multiple consecutive spaces (they should collapse to single spaces in the output). Fix it so `titleCase('hello   world')` returns `'Hello World'`, while `titleCase('a b c')` still returns `'A B C'`.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/format.ts"));
      const a = mod.titleCase("hello   world");
      const b = mod.titleCase("a b c");
      if (a !== "Hello World") return { pass: false, detail: `titleCase('hello   world') === '${a}', expected 'Hello World'` };
      if (b !== "A B C") return { pass: false, detail: `titleCase('a b c') === '${b}', expected 'A B C'` };
      return { pass: true, detail: "titleCase is correct" };
    },
  },
  {
    id: "add-initials",
    prompt:
      "Add a new exported function `initials(user: User): string` to `src/user.ts` that returns the user's initials as two uppercase letters, e.g. `{firstName: 'Ada', lastName: 'Lovelace'}` -> `'AL'`.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/user.ts"));
      if (typeof mod.initials !== "function") return { pass: false, detail: "initials is not exported" };
      const r = mod.initials({ id: "1", firstName: "Ada", lastName: "Lovelace" });
      if (r !== "AL") return { pass: false, detail: `initials(...) === '${r}', expected 'AL'` };
      return { pass: true, detail: "initials is correct" };
    },
  },
  {
    id: "rename-local-var",
    prompt:
      "In `src/math.ts`, rename the local accumulator variable inside `sum` from `total` to `accumulator`. This is a purely local rename — do not change the function name, parameters, exports, or any other logic (including the existing off-by-one bug in the loop condition — leave that exactly as-is).",
    verify: async (workdir) => {
      const fs = await import("node:fs/promises");
      const src = await fs.readFile(`${workdir}/src/math.ts`, "utf8");
      if (/\btotal\b/.test(src)) return { pass: false, detail: "identifier 'total' still present" };
      if (!/\baccumulator\b/.test(src)) return { pass: false, detail: "identifier 'accumulator' not found" };
      if (!/i\s*<=\s*values\.length/.test(src)) {
        return { pass: false, detail: "unrelated logic changed — the original off-by-one loop condition should be untouched" };
      }
      return { pass: true, detail: "renamed correctly, rest of the function left untouched" };
    },
  },
  {
    id: "add-clamp-file",
    prompt:
      "Create a new file `src/clamp.ts` exporting a function `clamp(value: number, min: number, max: number): number` that constrains `value` to the `[min, max]` range. Then add `export { clamp } from './clamp.js';` to `src/index.ts` so it's part of the public API.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/index.ts"));
      if (typeof mod.clamp !== "function") return { pass: false, detail: "clamp is not exported from src/index.ts" };
      const a = mod.clamp(5, 0, 10);
      const b = mod.clamp(-1, 0, 10);
      const c = mod.clamp(20, 0, 10);
      if (a !== 5 || b !== 0 || c !== 10) {
        return { pass: false, detail: `clamp(5,0,10)=${a} clamp(-1,0,10)=${b} clamp(20,0,10)=${c}` };
      }
      return { pass: true, detail: "clamp is correct and re-exported" };
    },
  },
  {
    id: "rename-export-multifile",
    prompt:
      "Rename the exported function `fullName` in `src/user.ts` to `formatFullName`, keeping its behaviour identical, and update the re-export in `src/index.ts` to match the new name.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/index.ts"));
      if (typeof mod.formatFullName !== "function") {
        return { pass: false, detail: "formatFullName is not exported from src/index.ts" };
      }
      const r = mod.formatFullName({ id: "1", firstName: "Ada", lastName: "Lovelace" });
      if (r !== "Ada Lovelace") return { pass: false, detail: `formatFullName(...) === '${r}', expected 'Ada Lovelace'` };
      return { pass: true, detail: "renamed correctly across files" };
    },
  },
];

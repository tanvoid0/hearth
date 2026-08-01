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
  {
    id: "fix-subtotal-quantity",
    prompt:
      "`subtotal` in `src/cart.ts` ignores each item's `quantity` — it adds the price once per line regardless of how many were ordered. Fix it so the subtotal is the sum of `price * quantity`. Leave the other exports alone.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/cart.ts"));
      const a = mod.subtotal([{ name: "a", price: 2, quantity: 3 }]);
      const b = mod.subtotal([{ name: "a", price: 2, quantity: 1 }, { name: "b", price: 5, quantity: 2 }]);
      const empty = mod.subtotal([]);
      if (!approxEqual(a, 6)) return { pass: false, detail: `subtotal(one line, qty 3) === ${a}, expected 6` };
      if (!approxEqual(b, 12)) return { pass: false, detail: `subtotal(two lines) === ${b}, expected 12` };
      if (!approxEqual(empty, 0)) return { pass: false, detail: `subtotal([]) === ${empty}, expected 0` };
      return { pass: true, detail: "subtotal respects quantity" };
    },
  },
  {
    id: "fix-discount-percent",
    prompt:
      "`applyDiscount(amount, percent)` in `src/cart.ts` subtracts `percent` as if it were an amount of money. It should take `percent` off: `applyDiscount(200, 10)` is `180`. Fix it.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/cart.ts"));
      const a = mod.applyDiscount(200, 10);
      const b = mod.applyDiscount(50, 0);
      const c = mod.applyDiscount(80, 100);
      if (!approxEqual(a, 180)) return { pass: false, detail: `applyDiscount(200, 10) === ${a}, expected 180` };
      if (!approxEqual(b, 50)) return { pass: false, detail: `applyDiscount(50, 0) === ${b}, expected 50` };
      if (!approxEqual(c, 0)) return { pass: false, detail: `applyDiscount(80, 100) === ${c}, expected 0` };
      return { pass: true, detail: "applyDiscount treats percent as a percentage" };
    },
  },
  {
    id: "add-item-count",
    prompt:
      "Add a new exported function `itemCount(items: CartItem[]): number` to `src/cart.ts` that returns the total number of units in the cart — the sum of every item's `quantity`. Do not modify the existing functions.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/cart.ts"));
      if (typeof mod.itemCount !== "function") return { pass: false, detail: "itemCount is not exported" };
      const a = mod.itemCount([{ name: "a", price: 1, quantity: 2 }, { name: "b", price: 1, quantity: 5 }]);
      const b = mod.itemCount([]);
      if (a !== 7) return { pass: false, detail: `itemCount(2 + 5) === ${a}, expected 7` };
      if (b !== 0) return { pass: false, detail: `itemCount([]) === ${b}, expected 0` };
      return { pass: true, detail: "itemCount is correct" };
    },
  },
  {
    id: "discount-range-error",
    prompt:
      "Make `applyDiscount` in `src/cart.ts` throw a `RangeError` when `percent` is less than 0 or greater than 100, before doing anything else. Leave its existing arithmetic exactly as it is — do not change how the discount is calculated.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/cart.ts"));
      for (const bad of [-1, 101]) {
        try {
          mod.applyDiscount(100, bad);
          return { pass: false, detail: `applyDiscount(100, ${bad}) did not throw` };
        } catch (err) {
          if (!(err instanceof RangeError)) return { pass: false, detail: `threw ${(err as Error).name}, expected RangeError` };
        }
      }
      // The arithmetic was explicitly out of scope, so it should still be the
      // original (wrong) subtraction — a model that "helpfully" fixed it
      // changed something it was told not to.
      const kept = mod.applyDiscount(100, 10);
      if (!approxEqual(kept, 90)) return { pass: false, detail: `applyDiscount(100, 10) === ${kept}, expected the original 90` };
      return { pass: true, detail: "guards the range and left the arithmetic alone" };
    },
  },
  {
    id: "rename-quantity-field",
    prompt:
      "In `src/cart.ts`, rename the `quantity` field of the `CartItem` interface to `qty`, and update every use of it in that file. Do not change any behaviour — in particular, leave the existing `subtotal` bug (it ignores the per-item count) exactly as it is.",
    verify: async (workdir) => {
      const fs = await import("node:fs/promises");
      const src = await fs.readFile(`${workdir}/src/cart.ts`, "utf8");
      if (/\bquantity\b/.test(src)) return { pass: false, detail: "field 'quantity' still present" };
      if (!/\bqty\b/.test(src)) return { pass: false, detail: "field 'qty' not found" };
      const mod = await import(importPath(workdir, "src/cart.ts"));
      const kept = mod.subtotal([{ name: "a", price: 2, qty: 3 }]);
      if (!approxEqual(kept, 2)) {
        return { pass: false, detail: `subtotal === ${kept}, expected the original 2 — the unrelated bug was changed` };
      }
      return { pass: true, detail: "renamed the field and left the bug alone" };
    },
  },
  {
    id: "fix-truncate-offbyone",
    prompt:
      "`truncate(input, max)` in `src/format.ts` is off by one: it keeps `max + 1` characters before adding the ellipsis. It should keep at most `max` characters. `truncate('abcdef', 3)` must return `'abc…'`, and a string shorter than `max` must come back untouched.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/format.ts"));
      const a = mod.truncate("abcdef", 3);
      const b = mod.truncate("ab", 5);
      const c = mod.truncate("abc", 3);
      if (a !== "abc…") return { pass: false, detail: `truncate('abcdef', 3) === '${a}', expected 'abc…'` };
      if (b !== "ab") return { pass: false, detail: `truncate('ab', 5) === '${b}', expected 'ab'` };
      if (c !== "abc") return { pass: false, detail: `truncate('abc', 3) === '${c}', expected 'abc'` };
      return { pass: true, detail: "truncate keeps at most max characters" };
    },
  },
  {
    id: "sum-via-reduce",
    prompt:
      "Rewrite `sum` in `src/math.ts` to use `Array.prototype.reduce` instead of a `for` loop, fixing the off-by-one bug in the process. Keep the signature and leave every other function alone.",
    verify: async (workdir) => {
      const fs = await import("node:fs/promises");
      const src = await fs.readFile(`${workdir}/src/math.ts`, "utf8");
      if (!/\.reduce\s*\(/.test(src)) return { pass: false, detail: "sum does not use reduce" };
      const mod = await import(importPath(workdir, "src/math.ts"));
      const a = mod.sum([1, 2, 3]);
      const b = mod.sum([]);
      if (a !== 6) return { pass: false, detail: `sum([1,2,3]) === ${a}, expected 6` };
      if (b !== 0) return { pass: false, detail: `sum([]) === ${b}, expected 0` };
      return { pass: true, detail: "sum uses reduce and is correct" };
    },
  },
  {
    id: "jsdoc-without-touching-code",
    prompt:
      "Add a JSDoc comment (`/** … */`) directly above the `fullName` function in `src/user.ts` explaining what it returns. Change nothing else — not the function body, not the interface, not any other file.",
    verify: async (workdir) => {
      const fs = await import("node:fs/promises");
      const src = await fs.readFile(`${workdir}/src/user.ts`, "utf8");
      if (!/\/\*\*[\s\S]*?\*\/\s*export function fullName/.test(src)) {
        return { pass: false, detail: "no JSDoc block immediately above fullName" };
      }
      // The body is the part that must not have moved. Whitespace-tolerant, but
      // the template literal has to be exactly what it was.
      if (!/return `\$\{user\.firstName\} \$\{user\.lastName\}`;/.test(src)) {
        return { pass: false, detail: "the body of fullName changed" };
      }
      if (!/interface User \{[\s\S]*?id: string;[\s\S]*?firstName: string;[\s\S]*?lastName: string;[\s\S]*?\}/.test(src)) {
        return { pass: false, detail: "the User interface changed" };
      }
      return { pass: true, detail: "documented without touching the code" };
    },
  },
  {
    id: "add-cart-total-file",
    prompt:
      "Create a new file `src/total.ts` exporting `cartTotal(items: CartItem[], discountPercent: number): number`. It returns the sum of `price * quantity` across the items, with `discountPercent` percent taken off the result — so one item at price 10, quantity 2, with 10 percent off, is 18. Import the `CartItem` type from `./cart.js`. Then re-export `cartTotal` from `src/index.ts`.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/index.ts"));
      if (typeof mod.cartTotal !== "function") return { pass: false, detail: "cartTotal is not exported from src/index.ts" };
      const a = mod.cartTotal([{ name: "a", price: 10, quantity: 2 }], 10);
      const b = mod.cartTotal([{ name: "a", price: 3, quantity: 1 }], 0);
      const c = mod.cartTotal([], 50);
      if (!approxEqual(a, 18)) return { pass: false, detail: `cartTotal(10 x 2, 10%) === ${a}, expected 18` };
      if (!approxEqual(b, 3)) return { pass: false, detail: `cartTotal(3 x 1, 0%) === ${b}, expected 3` };
      if (!approxEqual(c, 0)) return { pass: false, detail: `cartTotal([], 50%) === ${c}, expected 0` };
      return { pass: true, detail: "cartTotal is correct and re-exported" };
    },
  },
  {
    id: "add-money-file",
    prompt:
      "Create a new file `src/money.ts` exporting `formatMoney(cents: number): string`, which formats a whole number of cents as US dollars with exactly two decimal places and a leading `$`: 1234 becomes `'$12.34'`, 5 becomes `'$0.05'`, and 0 becomes `'$0.00'`. Do not modify any existing file.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/money.ts"));
      if (typeof mod.formatMoney !== "function") return { pass: false, detail: "formatMoney is not exported" };
      const cases: Array<[number, string]> = [
        [1234, "$12.34"],
        [5, "$0.05"],
        [0, "$0.00"],
        [100, "$1.00"],
      ];
      for (const [cents, want] of cases) {
        const got = mod.formatMoney(cents);
        if (got !== want) return { pass: false, detail: `formatMoney(${cents}) === '${got}', expected '${want}'` };
      }
      return { pass: true, detail: "formatMoney is correct" };
    },
  },
  {
    id: "slugify-case-and-punctuation",
    prompt:
      "`slugify` in `src/slug.ts` only replaces spaces. Make it produce a URL slug: lowercase, with punctuation removed, and words joined by single hyphens. `slugify('Hello, World!')` must return `'hello-world'` and `slugify('a  b')` must still return `'a-b'`.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/slug.ts"));
      const cases: Array<[string, string]> = [
        ["Hello, World!", "hello-world"],
        ["a  b", "a-b"],
        ["Already-slugged", "already-slugged"],
      ];
      for (const [input, want] of cases) {
        const got = mod.slugify(input);
        if (got !== want) return { pass: false, detail: `slugify('${input}') === '${got}', expected '${want}'` };
      }
      return { pass: true, detail: "slugify lowercases and strips punctuation" };
    },
  },
  {
    id: "export-missing-slugify",
    prompt:
      "`src/index.ts` is the public API and re-exports every module in `src/` — except `src/slug.ts`, which was missed. Add the missing re-export. Do not change `slugify` itself or anything else.",
    verify: async (workdir) => {
      const mod = await import(importPath(workdir, "src/index.ts"));
      if (typeof mod.slugify !== "function") return { pass: false, detail: "slugify is not exported from src/index.ts" };
      // Unchanged means still the naive version: a model that also "fixed" it
      // did something it was told not to.
      const got = mod.slugify("Hi There");
      if (got !== "Hi-There") return { pass: false, detail: `slugify('Hi There') === '${got}', expected the original 'Hi-There'` };
      if (typeof mod.sum !== "function" || typeof mod.fullName !== "function") {
        return { pass: false, detail: "an existing re-export was lost" };
      }
      return { pass: true, detail: "re-exported without changing the function" };
    },
  },
];

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allProblems, applyDiagEvent, fullReplaceRange, problemTail, type Diags } from "./problems.ts";

/**
 * The one check the unit tests above can't make: real tsserver output, through
 * the real parser, producing the string the agent actually reads.
 *
 * Everything else in this file asserts against diagnostic objects written by
 * hand — which is where fixtures lie. This drives the protocol the way lsp.ts
 * does (open → geterr → change → geterr) and asserts on both ends of it, so a
 * change to tsserver's event shapes, or an off-by-one in `fullReplaceRange`,
 * fails here instead of silently reporting a broken file as clean.
 */

const TSSERVER = path.join(import.meta.dirname, "../../node_modules/typescript/lib/tsserver.js");

const BROKEN = `export function total(items) {
  return items.length + missingThing;
}
`;
const FIXED = `export function total(items) {
  return items.length;
}
`;

test("real tsserver diagnostics survive the round trip to what the agent reads", { timeout: 90_000 }, async (t) => {
  if (!fs.existsSync(TSSERVER)) {
    // A packaged build with no bundled TypeScript. The app reports that as
    // "unavailable" rather than as a clean project; so does this.
    return t.skip("no tsserver.js — run npm install first");
  }

  const root = path.join(os.tmpdir(), `hearth-live-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  // Without this tsserver files everything under an inferred project and
  // reports nothing at all — the case `problemTail("unconfigured")` exists for.
  fs.writeFileSync(
    path.join(root, "jsconfig.json"),
    JSON.stringify({ compilerOptions: { checkJs: true }, include: ["src"] }),
  );
  const file = path.join(root, "src/total.js").replace(/\\/g, "/");
  fs.writeFileSync(file, BROKEN);

  const child = spawn(process.execPath, [TSSERVER, "--disableAutomaticTypingAcquisition"], {
    cwd: root,
    stdio: ["pipe", "pipe", "ignore"],
  });

  let diags: Diags = {};
  let seq = 0;
  const done = new Map<number, () => void>();
  const send = (command: string, args: unknown) => {
    seq += 1;
    child.stdin.write(JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n");
    return seq;
  };
  const check = (files: string[]) =>
    new Promise<void>((resolve) => {
      // `geterr` answers with events; the only completion signal is a
      // `requestCompleted` naming the sequence number — the same wait lsp.ts does.
      const id = send("geterr", { files, delay: 0 });
      const timer = setTimeout(resolve, 30_000);
      done.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
    });

  // Content-Length framing, byte-exact — the header counts bytes, not characters.
  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) break;
      const header = /Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString("utf8"));
      if (!header) {
        buf = buf.subarray(sep + 4);
        continue;
      }
      const length = Number(header[1]);
      if (buf.length < sep + 4 + length) break;
      const message = JSON.parse(buf.subarray(sep + 4, sep + 4 + length).toString("utf8"));
      buf = buf.subarray(sep + 4 + length);
      if (message.type !== "event") continue;
      if (message.event === "requestCompleted") {
        done.get(message.body?.request_seq)?.();
        done.delete(message.body?.request_seq);
      } else {
        diags = applyDiagEvent(diags, message.event, message.body);
      }
    }
  });

  try {
    send("open", { file, fileContent: BROKEN, projectRootPath: root.replace(/\\/g, "/") });
    await check([file]);

    const broken = problemTail("ok", allProblems(diags), root.replace(/\\/g, "/"));
    assert.match(broken, /type errors: 1/, broken);
    assert.match(broken, /src\/total\.js:2:25 error TS2304: Cannot find name 'missingThing'\./, broken);

    // The whole document replaced from the content we last sent — the range has
    // to describe tsserver's buffer, not the editor's. One line off here and
    // every later position lands on the wrong token.
    send("change", { file, ...fullReplaceRange(BROKEN), insertString: FIXED });
    await check([file]);

    assert.equal(
      problemTail("ok", allProblems(diags), root),
      "type errors: none",
      "a fixed buffer has to clear, and it is never written to disk — tsserver checks the buffer",
    );
  } finally {
    child.kill();
    // Best-effort: Windows refuses to remove a directory that is still a live
    // process's cwd, and a cleanup failure must not stand in for — or hide — an
    // assertion failure. The rm at the top of the test is the real cleanup.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // left for the next run to clear
    }
  }
});

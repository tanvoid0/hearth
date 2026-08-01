// .env parsing and redaction, kept import-free (like edit.ts and runlog.ts) so
// `npm test` runs it on plain node.
//
// Two callers with the same rule between them: the panel that shows these
// values masked, and the agent, which must not be handed them at all. Build
// plan §14 asks for the first; the second is the reason the first matters —
// `read_file .env` would otherwise put every key the project has into a model's
// context and into the saved transcript.

/** Files whose contents are secrets by convention. */
export function isSecretFile(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^\.env(\..+)?$/.test(name) && !/\.example$|\.sample$|\.template$/.test(name);
}

export interface EnvEntry {
  key: string;
  value: string;
  /** 1-based, so a write can go back to the same line. */
  line: number;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Strip one layer of matching quotes — dotenv treats `A="b"` and `A=b` alike. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

export function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line)) return; // a comment, not an assignment
    const match = ASSIGNMENT.exec(line);
    if (match) entries.push({ key: match[1], value: unquote(match[2]), line: i + 1 });
  });
  return entries;
}

/** Enough to recognise a value you set, not enough to use it. Short values are
 *  blanked entirely rather than half-shown: four characters of an eight-
 *  character secret is most of a secret. */
export function mask(value: string): string {
  if (value === "") return "";
  return value.length <= 8 ? "•".repeat(8) : `${"•".repeat(8)} ${value.slice(-4)}`;
}

/**
 * The file as the agent may see it: every key, no values.
 *
 * Keys are kept because the agent legitimately needs to know which variables
 * exist — the whole point of asking is usually "what is this app configured
 * with", and answering with nothing at all sends it guessing.
 */
export function redactEnv(text: string): string {
  return text
    .split("\n")
    .map((raw) => {
      const line = raw.replace(/\r$/, "");
      const match = ASSIGNMENT.exec(line);
      if (!match) return line; // comments and blanks are not secrets
      const length = unquote(match[2]).length;
      // An unset key has nothing to hide, and "<redacted; 0 chars>" reads as if
      // it did.
      return length === 0 ? `${match[1]}=` : `${match[1]}=<redacted; ${length} chars>`;
    })
    .join("\n");
}

/**
 * Change one value, leaving the rest of the file — comments, ordering, blank
 * lines — exactly as it was. Rebuilding the file from parsed entries would be
 * shorter and would silently delete every comment in it.
 */
export function setEnvValue(text: string, key: string, value: string): string {
  // Quote when the value contains anything a shell-style parser would split on;
  // leave it bare otherwise, which is how these files are usually written.
  const written = /[\s"'#]/.test(value) ? JSON.stringify(value) : value;
  const lines = text.split("\n");

  const at = lines.findIndex((raw) => ASSIGNMENT.exec(raw.replace(/\r$/, ""))?.[1] === key);
  if (at >= 0) {
    const prefix = /^\s*export\s+/.test(lines[at]) ? "export " : "";
    lines[at] = `${prefix}${key}=${written}`;
    return lines.join("\n");
  }

  // A new key goes at the end, after any trailing blank line rather than
  // before it.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(`${key}=${written}`, "");
  return lines.join("\n");
}

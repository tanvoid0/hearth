import { useEffect, useState } from "react";
import { listDir, readTextFile, writeTextFile } from "../lib/fs";
import { resolveInProject } from "../lib/edit";
import { isSecretFile, mask, parseEnv, setEnvValue, type EnvEntry } from "../lib/secrets";

/**
 * Build plan §14's dependency panel and .env manager, in one dock tab.
 *
 * One tab because they answer the same question from two sides — what is this
 * project wired up to — and because a panel per list is how a bottom dock ends
 * up with eight tabs nobody can find anything in.
 *
 * Values are masked until asked for. That's not theatre: the agent panel is a
 * screen-share away, and the whole point of `redactEnv` next door is that a
 * key should not be somewhere it can be read by accident.
 */
interface Dependency {
  name: string;
  range: string;
  dev: boolean;
}

async function readDependencies(root: string): Promise<Dependency[]> {
  try {
    const pkg = JSON.parse(await readTextFile(`${root}/package.json`));
    return [
      ...Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({ name, range: String(range), dev: false })),
      ...Object.entries(pkg.devDependencies ?? {}).map(([name, range]) => ({ name, range: String(range), dev: true })),
    ];
  } catch {
    return [];
  }
}

/** Only the root. A monorepo's package .env files are a different feature, and
 *  walking the tree for dotfiles is how you end up reading node_modules. */
async function findEnvFiles(root: string): Promise<string[]> {
  const entries = await listDir(root).catch(() => []);
  return entries.filter((e) => !e.is_dir && isSecretFile(e.name)).map((e) => e.name);
}

function EnvRow({ entry, onSave }: { entry: EnvEntry; onSave: (value: string) => Promise<void> }) {
  const [shown, setShown] = useState(false);
  const [draft, setDraft] = useState(entry.value);
  const [saving, setSaving] = useState(false);

  // A save rewrites the file and re-reads it, which remounts nothing — so the
  // draft has to follow the value it came from.
  useEffect(() => setDraft(entry.value), [entry.value]);

  return (
    <div className="flex items-center gap-2 border-b border-neutral-900 px-2 py-1">
      <span className="w-56 shrink-0 truncate font-mono text-[11px] text-neutral-300">{entry.key}</span>
      {shown ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || draft === entry.value) return;
            setSaving(true);
            void onSave(draft).finally(() => setSaving(false));
          }}
          spellCheck={false}
          className="min-w-0 flex-1 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-100 outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-600">
          {entry.value === "" ? "(empty)" : mask(entry.value)}
        </span>
      )}
      {shown && draft !== entry.value && (
        <span className="shrink-0 text-[10px] text-neutral-500">{saving ? "saving…" : "Enter to save"}</span>
      )}
      <button
        onClick={() => setShown((v) => !v)}
        className="shrink-0 rounded px-1.5 text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
      >
        {shown ? "hide" : "show"}
      </button>
    </div>
  );
}

export function ProjectPanel({ root }: { root: string }) {
  const [deps, setDeps] = useState<Dependency[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void readDependencies(root).then(setDeps);
    void findEnvFiles(root).then((found) => {
      setFiles(found);
      setFile(found[0] ?? null);
    });
  }, [root]);

  async function reload(name: string) {
    setError(null);
    try {
      setEntries(parseEnv(await readTextFile(resolveInProject(root, name))));
    } catch (err) {
      setEntries([]);
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (file) void reload(file);
    else setEntries([]);
  }, [root, file]);

  async function save(key: string, value: string) {
    if (!file) return;
    setError(null);
    try {
      const target = resolveInProject(root, file);
      // Re-read rather than rewrite from `entries`: the file may have been
      // edited in a tab since it was loaded here.
      await writeTextFile(target, setEnvValue(await readTextFile(target), key, value));
      await reload(file);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-2 text-[11px] text-neutral-500">
        <span className="uppercase tracking-wide">Project</span>
        <span className="text-neutral-600">
          {deps.length} dependenc{deps.length === 1 ? "y" : "ies"}
        </span>
      </div>

      {error && <div className="shrink-0 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">{error}</div>}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex items-center gap-2 bg-neutral-950 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
          Environment
          {files.map((name) => (
            <button
              key={name}
              onClick={() => setFile(name)}
              className={`rounded px-1.5 font-mono text-[10px] normal-case ${
                file === name ? "bg-neutral-700 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        {files.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-neutral-600">
            No .env file here. One created later shows up when this panel is reopened.
          </p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-neutral-600">No variables set in {file}.</p>
        ) : (
          entries.map((entry) => (
            <EnvRow key={entry.key} entry={entry} onSave={(value) => save(entry.key, value)} />
          ))
        )}

        <div className="mt-2 bg-neutral-950 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
          Dependencies
        </div>
        {deps.length === 0 ? (
          <p className="px-2 py-1.5 text-[12px] text-neutral-600">No package.json, or nothing depended on.</p>
        ) : (
          deps.map((dep) => (
            <div key={`${dep.name}:${dep.dev}`} className="flex items-center gap-2 border-b border-neutral-900 px-2 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-300">{dep.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-neutral-500">{dep.range}</span>
              {dep.dev && <span className="shrink-0 text-[10px] text-neutral-600">dev</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

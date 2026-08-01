import Database from "@tauri-apps/plugin-sql";
import { SCHEMA } from "./chatsql";

/**
 * The conversation database.
 *
 * One file for every project rather than one per project, which is the whole
 * reason this is a database: a transcript per project is a file, and a file
 * can't answer "where did I solve this before". `sqlite:` with a bare name
 * resolves under the app's own data directory, so it isn't something the user
 * finds in their repo.
 */
const DB_URL = "sqlite:hearth-chats.db";

/** Opened once and shared. Held as the promise, not the resolved handle, so
 *  concurrent callers during startup wait on the same connection instead of
 *  opening several and racing the schema. */
let connection: Promise<Database> | null = null;

export function db(): Promise<Database> {
  connection ??= Database.load(DB_URL).then(async (open) => {
    // Idempotent, so running it on every open costs three statements and
    // removes the need for a migration list that the tests can't reach.
    for (const statement of SCHEMA) await open.execute(statement);
    return open;
  });
  return connection;
}

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WHITEBOOKS_ENV_KEYS } from "../../packages/gst/src/whitebooks-connector.ts";

type Key = typeof WHITEBOOKS_ENV_KEYS[number];

const FIELDS: readonly { readonly key: Key; readonly secret?: true; readonly defaultValue?: string }[] = [
  { key: "WHITEBOOKS_BASE_URL", defaultValue: "https://apisandbox.whitebooks.in" },
  { key: "WHITEBOOKS_EINVOICE_CLIENT_ID" },
  { key: "WHITEBOOKS_EINVOICE_CLIENT_SECRET", secret: true },
  { key: "WHITEBOOKS_EWAYBILL_CLIENT_ID" },
  { key: "WHITEBOOKS_EWAYBILL_CLIENT_SECRET", secret: true },
  { key: "WHITEBOOKS_GSTIN" },
  { key: "WHITEBOOKS_USERNAME" },
  { key: "WHITEBOOKS_PASSWORD", secret: true },
  { key: "WHITEBOOKS_IP_ADDRESS" },
];

export const maskCredential = (value: string): string => value.length <= 3 ? "***" : `****${value.slice(-3)}`;

const decoded = (raw: string): string => {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "");
};

export const envValues = (source: string): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = decoded(match[2]);
  }
  return values;
};

export const updateEnv = (source: string, updates: Readonly<Record<string, string>>): string => {
  const remaining = new Map(Object.entries(updates));
  const lines = source === "" ? [] : source.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const next = lines.map((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${JSON.stringify(value)}`;
  });
  for (const [key, value] of remaining) next.push(`${key}=${JSON.stringify(value)}`);
  return `${next.join("\n")}\n`;
};

export const saveEnv = async (path: string, source: string, updates: Readonly<Record<string, string>>): Promise<void> => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, updateEnv(source, updates), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
};

const selectedFields = (args: readonly string[]) => {
  if (args.length === 0) return FIELDS;
  if (args.length !== 2 || args[0] !== "--only" || !WHITEBOOKS_ENV_KEYS.includes(args[1] as Key)) {
    throw new Error(`Use npm run gsp:credentials, or npm run gsp:credentials -- --only ${WHITEBOOKS_ENV_KEYS.join("|")}. Values are never accepted as arguments.`);
  }
  return FIELDS.filter((field) => field.key === args[1]);
};

export async function configureCredentials(args = process.argv.slice(2), path = resolve(process.cwd(), ".env")): Promise<void> {
  let source = "";
  try { source = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existing = envValues(source);
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
      callback();
    },
  });
  const questions = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const updates: Record<string, string> = {};
  try {
    for (const field of selectedFields(args)) {
      const current = existing[field.key] ?? "";
      const fallback = current || field.defaultValue || "";
      const hint = current ? ` [Enter keeps ${maskCredential(current)}]` : field.defaultValue ? ` [${field.defaultValue}]` : "";
      let value = "";
      while (value === "") {
        if (field.secret) {
          process.stdout.write(`${field.key}${hint}: `);
          muted = true;
          value = (await questions.question("")).trim() || fallback;
          muted = false;
          process.stdout.write("\n");
        } else {
          value = (await questions.question(`${field.key}${hint}: `)).trim() || fallback;
        }
        if (value === "") process.stdout.write("A value is required.\n");
      }
      updates[field.key] = value;
    }
  } finally {
    muted = false;
    questions.close();
  }
  await saveEnv(path, source, updates);
  for (const [key, value] of Object.entries(updates)) process.stdout.write(`Saved ${key}=${maskCredential(value)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureCredentials().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Credentials were not saved."); process.exitCode = 1; });
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { maskCredential, saveEnv } from "../gsp/credentials.ts";

test("credential updates preserve the rest of .env and leave the file owner-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gsp-credentials-"));
  const path = join(directory, ".env");
  await saveEnv(path, "KEEP_ME=yes\nWHITEBOOKS_PASSWORD=old\n", { WHITEBOOKS_PASSWORD: "new value" });

  assert.equal(await readFile(path, "utf8"), 'KEEP_ME=yes\nWHITEBOOKS_PASSWORD="new value"\n');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(maskCredential("new value"), "****lue");
  assert.equal(maskCredential("abc"), "***");
});

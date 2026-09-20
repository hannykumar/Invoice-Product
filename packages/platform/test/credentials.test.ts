import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialVault } from "../src/credentials.ts";

const KEYS = ["A_ONE", "A_TWO"] as const;

test("a half-filled credential file leaves the connector unconfigured instead of stopping the app", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "vault-")), ".env");
  await writeFile(path, "A_ONE=set\n");
  const warnings: string[] = [];

  const vault = FileCredentialVault.open(path, KEYS, ["A_TWO"], ["irp"], (message) => warnings.push(message));

  assert.equal(vault, null);
  assert.deepEqual(FileCredentialVault.missingKeys(path, KEYS), ["A_TWO"]);
  assert.match(warnings[0] ?? "", /A_TWO/);
});

test("a complete file opens, and an absent file is simply no credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vault-"));
  const path = join(directory, ".env");
  await writeFile(path, "A_ONE=set\nA_TWO=also\n");

  assert.notEqual(FileCredentialVault.open(path, KEYS, ["A_TWO"], ["irp"], () => {}), null);
  assert.equal(FileCredentialVault.open(join(directory, "absent"), KEYS, ["A_TWO"], ["irp"], () => {}), null);
});

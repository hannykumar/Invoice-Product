import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openWhitebooksCredentialVault, whitebooksIrpConnectorFromVault } from "../../packages/gst/src/whitebooks-connector.ts";

export async function checkWhitebooksConnection(path = resolve(process.cwd(), ".env")): Promise<string> {
  const vault = openWhitebooksCredentialVault(path);
  if (vault === null) throw new Error("WhiteBooks credentials are not configured. Run npm run gsp:credentials first.");
  const connection = await whitebooksIrpConnectorFromVault(vault).connection();
  return `Connected as GSTIN ${connection.gstin}, token valid until ${connection.tokenValidUntil}.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWhitebooksConnection().then(console.log, (error: unknown) => { console.error(error instanceof Error ? error.message : "The connection could not be checked."); process.exitCode = 1; });
}

import { createMigrationId } from "../../packages/platform/src/migration-ids.ts";

const [moduleName, ...descriptionParts] = process.argv.slice(2);
const description = descriptionParts.join(" ");
if (!moduleName || !description) throw new Error("Use: npm run db:migration:id -- <module> <description>");
console.log(createMigrationId(moduleName, description));

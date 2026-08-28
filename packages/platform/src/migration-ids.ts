import { randomBytes } from "node:crypto";
import type { Migration } from "./migration-definitions.ts";

const legacyMigrationIds = new Set([
  "0001_platform_foundation",
  "0002_authentication_sessions_and_invitations",
  "0003_approvals_commands_and_exception_evidence",
  "0004_bank_statement_imports",
  "0005_bank_statement_pdf_sources",
  "0006_master_data",
  "0007_notification_infrastructure",
  "0008_notification_policy",
]);

const generatedId = /^\d{8}T\d{9}Z_[a-z][a-z0-9-]*_[0-9a-f]{12}_[a-z][a-z0-9_]*$/;
const legacySequence = /^(\d{4})_/;

export function createMigrationId(moduleName: string, description: string, now = new Date(), entropy = randomBytes(6).toString("hex")): string {
  const moduleSlug = moduleName.trim().toLowerCase();
  const descriptionSlug = description.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!/^[a-z][a-z0-9-]*$/.test(moduleSlug)) throw new Error("Migration module must start with a letter and contain only lowercase letters, numbers or hyphens.");
  if (!/^[a-z][a-z0-9_]*$/.test(descriptionSlug)) throw new Error("Migration description must start with a letter and contain only letters, numbers, spaces, hyphens or underscores.");
  if (!/^[0-9a-f]{12}$/.test(entropy)) throw new Error("Migration entropy must contain exactly 12 lowercase hexadecimal characters.");
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${timestamp}_${moduleSlug}_${entropy}_${descriptionSlug}`;
}

export function validateMigrationRegistry(migrations: readonly Migration[]): void {
  const ids = new Set<string>();
  const legacySequences = new Map<string, string>();
  let previousId: string | undefined;
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
    if (previousId !== undefined && previousId > migration.id) throw new Error(`Migration registry is out of order: ${migration.id} appears after ${previousId}.`);
    ids.add(migration.id);

    const sequence = legacySequence.exec(migration.id)?.[1];
    if (sequence) {
      if (!legacyMigrationIds.has(migration.id)) throw new Error(`New numeric migration ids are not allowed: ${migration.id}. Run npm run db:migration:id instead.`);
      const previous = legacySequences.get(sequence);
      if (previous) throw new Error(`Legacy migration sequence ${sequence} is used by both ${previous} and ${migration.id}.`);
      legacySequences.set(sequence, migration.id);
    } else if (!generatedId.test(migration.id)) {
      throw new Error(`Invalid migration id: ${migration.id}. Run npm run db:migration:id instead.`);
    }
    previousId = migration.id;
  }
}

/** Issue #37 [E37] — public surface. See docs/contracts/migration.v1.md. */
export * from './model.ts';
export * from './csv.ts';
export * from './columns.ts';
export * from './coerce.ts';
export * from './rows.ts';
export * from './duplicates.ts';
export * from './error-file.ts';
export * from './ports.ts';
export * from './repository.ts';
export * from './service.ts';
export { MastersMigrationAdapter } from './adapters/masters.ts';
export { InventoryMigrationAdapter, MastersStockData } from './adapters/inventory.ts';
export { workbookToCsv, xlsxReader } from './adapters/xlsx.ts';

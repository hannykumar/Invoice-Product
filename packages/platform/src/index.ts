import { AccessControl, AuditLog, PlatformCommandService } from "./platform.ts";
export { AccessControl, AuditLog, PlatformCommandService } from "./platform.ts";
export * from "./types.ts";
export * from "./connectors.ts";
export * from "./auth.ts";
export function createPlatform() { const audit = new AuditLog(); return { audit, commands: new PlatformCommandService(audit), access: new AccessControl() }; }

import { AccessControl, AuditLog, ExceptionQueue, PlatformCommandService } from "./platform.ts";
export { AccessControl, AuditLog, ExceptionQueue, PlatformCommandService } from "./platform.ts";
export * from "./types.ts";
export * from "./connectors.ts";
export * from "./auth.ts";
export * from "./banking.ts";
export * from "./notifications.ts";
export function createPlatform() { const audit = new AuditLog(); return { audit, commands: new PlatformCommandService(audit), exceptions: new ExceptionQueue(audit), access: new AccessControl() }; }

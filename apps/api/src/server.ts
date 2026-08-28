import { createPlatform } from "../../../packages/platform/src/index.ts";

// The HTTP router belongs here. Keeping composition separate makes domain modules
// usable in tests, workers and future CLI tools without a web framework dependency.
const platform = createPlatform();
console.log(`Invoice Product API composition root ready with ${platform.audit.count()} audit events.`);


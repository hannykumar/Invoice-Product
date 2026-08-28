const direction = process.argv[2];
if (direction !== "up" && direction !== "down") throw new Error("Use: npm run db:migrate or npm run db:rollback");
console.log(`Migration ${direction} scaffold complete. Configure DATABASE_URL before production persistence.`);


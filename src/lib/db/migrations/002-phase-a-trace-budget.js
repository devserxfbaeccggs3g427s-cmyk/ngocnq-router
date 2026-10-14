// Phase A: trace storage, budget alerts, usageHistory attemptId
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 3,
  name: "phase-a-trace-budget",
  up(db) {
    // Create new tables
    for (const tableName of ["traces", "traceAttempts", "budgetAlerts"]) {
      db.exec(buildCreateTableSql(tableName, TABLES[tableName]));
      for (const idx of TABLES[tableName].indexes || []) {
        db.exec(idx);
      }
    }

    // Add attemptId to usageHistory (additive column)
    try {
      db.exec(`ALTER TABLE usageHistory ADD COLUMN attemptId TEXT`);
    } catch (e) {
      // Column may already exist via syncSchemaFromTables
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_attempt ON usageHistory(attemptId) WHERE attemptId IS NOT NULL`);

    // Add projectId/projectLabel to apiKeys (additive columns)
    try {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN projectId TEXT`);
    } catch {}
    try {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN projectLabel TEXT`);
    } catch {}
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ak_project ON apiKeys(projectId)`);
    } catch {}
  },
};
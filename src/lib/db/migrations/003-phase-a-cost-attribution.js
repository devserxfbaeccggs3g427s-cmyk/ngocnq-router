// Phase A: preserve unknown costs and add stable usage attribution.
import { TABLES } from "../schema.js";

function addColumn(db, table, column) {
  const definition = TABLES[table].columns[column];
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column may already exist via additive schema sync.
  }
}

export default {
  version: 4,
  name: "phase-a-cost-attribution",
  up(db) {
    addColumn(db, "usageHistory", "costStatus");
    addColumn(db, "usageHistory", "apiKeyId");
    addColumn(db, "usageHistory", "projectId");
    addColumn(db, "traces", "costStatus");
    addColumn(db, "traceAttempts", "costStatus");
    addColumn(db, "budgetAlerts", "budgetUsd");
    addColumn(db, "budgetAlerts", "currentCost");

    // Historical rows used 0 as both unknown and free, so they cannot safely be
    // reclassified. Keep them explicitly unknown; new writes carry exact status.
    db.exec(`UPDATE usageHistory SET costStatus = 'unknown' WHERE costStatus IS NULL OR costStatus = ''`);
    db.exec(`UPDATE traces SET costStatus = 'unknown' WHERE costStatus IS NULL OR costStatus = ''`);
    db.exec(`UPDATE traceAttempts SET costStatus = 'unknown' WHERE costStatus IS NULL OR costStatus = ''`);

    // Keep the oldest historical row for each attempt. Earlier development builds
    // could write duplicates before the constraint existed; preserve their usage but
    // detach later rows from the attempt identity so the unique index can be enforced.
    db.exec(`
      UPDATE usageHistory
      SET attemptId = NULL
      WHERE attemptId IS NOT NULL
        AND id NOT IN (
          SELECT MIN(id)
          FROM usageHistory
          WHERE attemptId IS NOT NULL
          GROUP BY attemptId
        )
    `);

    db.exec(`DROP INDEX IF EXISTS idx_uh_attempt`);
    for (const index of TABLES.usageHistory.indexes || []) {
      db.exec(index);
    }
  },
};

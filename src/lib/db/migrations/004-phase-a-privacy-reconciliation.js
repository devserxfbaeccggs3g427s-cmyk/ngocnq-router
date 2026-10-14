// Phase A v5: Privacy scrub (tokensJson), canonical ledger by attemptId with terminal UTC timestamps,
// idempotent repair, safety reconciliation. No new trace counters.
import { TABLES, buildCreateTableSql } from "../schema.js";

const tableExists = (db, name) =>
  !!db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);

// PRAGMA table_info via db.all — the same shape migrate.js already relies on,
// so every adapter (bun:sqlite / better-sqlite3 / node:sqlite / sql.js) agrees.
const columnExists = (db, table, column) =>
  db.all(`PRAGMA table_info(${table})`).some((col) => col.name === column);

export default {
  version: 5,
  name: "phase-a-privacy-reconciliation",
  up(db) {
    // 0. Nothing to reconcile on a database whose Phase A tables were never
    //    created (pre-Phase-A install reaches them via syncSchemaFromTables).
    if (!tableExists(db, "traceAttempts")) return;

    // 1. Remove tokensJson from traceAttempts (privacy — attempts hold provenance
    //    metadata only; numeric counters live solely in usageHistory). SQLite has
    //    no DROP COLUMN on every supported build, so rebuild-and-swap. Guarded on
    //    the column actually existing so a retry after a partial run is a no-op.
    if (columnExists(db, "traceAttempts", "tokensJson")) {
      db.exec(`DROP TABLE IF EXISTS traceAttempts_v5`);
      db.exec(buildCreateTableSql("traceAttempts_v5", TABLES.traceAttempts));

      db.exec(`
        INSERT INTO traceAttempts_v5(attemptId, requestId, provider, model, connectionId, startTime, endTime, status, httpStatus, ttftMs, durationMs, tokenSource, cost, costStatus)
        SELECT attemptId, requestId, provider, model, connectionId, startTime, endTime, status, httpStatus, ttftMs, durationMs, tokenSource, cost, costStatus
        FROM traceAttempts
      `);

      db.exec(`DROP TABLE traceAttempts`);
      db.exec(`ALTER TABLE traceAttempts_v5 RENAME TO traceAttempts`);
    }

    // Recreate indexes for traceAttempts (idempotent, from the schema of record)
    for (const idx of TABLES.traceAttempts.indexes || []) db.exec(idx);

    // 2. Billing timestamp must be the TERMINAL time. Backfill endTime for rows
    //    already terminal without one, derived from startTime + durationMs.
    //    App-level enforcement stays primary (finishAttempt always writes it).
    db.exec(`
      UPDATE traceAttempts
      SET endTime = CASE
        WHEN durationMs IS NOT NULL AND durationMs > 0
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', startTime, '+' || durationMs || ' milliseconds')
        ELSE startTime
      END
      WHERE status != 'running' AND endTime IS NULL
    `);

    // 3. Reconciliation: a usageHistory row whose attemptId points at no attempt
    //    is detached (attemptId -> NULL) rather than left claiming a linkage the
    //    trace tables cannot support.
    if (tableExists(db, "usageHistory")) {
      db.exec(`
        UPDATE usageHistory
        SET attemptId = NULL
        WHERE attemptId IS NOT NULL
          AND attemptId NOT IN (SELECT attemptId FROM traceAttempts)
      `);
    }

    // 4. Budget alert uniqueness is the whole point of the table — a DB that
    //    somehow lost the index gets it back here rather than silently
    //    accumulating duplicates.
    if (tableExists(db, "budgetAlerts")) {
      for (const idx of TABLES.budgetAlerts.indexes || []) {
        try { db.exec(idx); } catch { /* a conflicting duplicate set is reported by the unique index rebuild failing */ }
      }
    }
  },
};
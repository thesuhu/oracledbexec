/**
 * oraexectrans() with a slow query buried in the middle of a 5-query
 * transaction — demonstrates how tracking behaves query-by-query on a
 * single connection: each finished query is untracked immediately, only
 * the one still running shows up in getSlowQueries() while it's stuck.
 * Tracking is per-query only — the transaction as a whole (time spent in
 * commit() or between queries) is intentionally not tracked/visible.
 * Run with: node example/slow-query-in-transaction.js  (requires a configured .env, see .env.example)
 */

process.env.ORACLE_QUERY_TRACKING = 'true'

require('dotenv').config()
const oracledbexec = require('../oracledbexec')

async function main() {
    const poolAlias = 'slow_in_tx'

    // Pure PL/SQL busy-wait (see oracledbexec.test.js / example/queue-full-simulation.js
    // for why: portable, no DBMS_SESSION.SLEEP dependency).
    const spinSql = (seconds) =>
        `/* SLOW_QUERY_3 */ DECLARE v_start PLS_INTEGER; ` +
        `BEGIN SELECT DBMS_UTILITY.GET_TIME INTO v_start FROM DUAL; ` +
        `LOOP EXIT WHEN DBMS_UTILITY.GET_TIME - v_start > ${seconds * 100}; END LOOP; END;`

    await oracledbexec.initialize({ poolAlias, poolMin: 1, poolMax: 1 })

    try {
        // 5 queries in one transaction, one connection — sequential, not parallel.
        // Query index 2 (the 3rd) is deliberately slow (3s); the rest are instant.
        const queries = [
            { query: 'SELECT 1 as val FROM DUAL' },
            { query: 'SELECT 2 as val FROM DUAL' },
            { query: spinSql(3) }, // <- the slow one
            { query: 'SELECT 4 as val FROM DUAL' },
            { query: 'SELECT 5 as val FROM DUAL' }
        ]

        const txPromise = oracledbexec.oraexectrans(queries, poolAlias)

        // Poll while query 3 is (presumably) still running, to see who's tracked.
        await new Promise(resolve => setTimeout(resolve, 1500))

        const inFlight = oracledbexec.getSlowQueries(0).filter(q => q.poolAlias === poolAlias)
        console.log('\nWhile query 3 is stuck, getSlowQueries() shows:')
        console.table(inFlight.map(q => ({ queryId: q.queryId, sql: q.sql, elapsedMs: q.elapsedMs, caller: q.caller })))
        // Expect exactly 1 entry: query 3, the one actually still executing.
        // Queries 1 and 2 already finished and were untracked; queries 4 and 5
        // haven't started yet (no entry exists for them until their turn comes).
        // There's no separate "whole transaction" entry — only actual query
        // execution time is tracked, not time spent in commit() or between queries.

        await txPromise

        const afterCompletion = oracledbexec.getSlowQueries(0).filter(q => q.poolAlias === poolAlias)
        console.log('\nAfter the transaction completes, getSlowQueries() shows:', afterCompletion)
        // Expect: [] — every per-query entry is untracked once its query finishes.
    } finally {
        await oracledbexec.close(poolAlias)
    }
}

main()

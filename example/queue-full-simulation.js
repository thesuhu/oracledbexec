/**
 * Deliberately saturates a small pool with long-running queries, then sends
 * one more request than the pool + queue can serve, so it fails with
 * NJS-040 (waited past queueTimeout) — demonstrating the queue_timeout
 * event's heldBy: who was actually holding connections.
 * Run with: node example/queue-full-simulation.js  (requires a configured .env, see .env.example)
 */

// Force query tracking on for this demo, so the simulation below gets a
// populated `heldBy`. Set before requiring dotenv/oracledbexec, since
// oracledbexec reads this env var once at require time — and dotenv.config()
// never overrides an already-set process.env value, so this wins over .env.
process.env.ORACLE_QUERY_TRACKING = 'true'

require('dotenv').config()
const oracledbexec = require('../oracledbexec')

async function main() {
    const poolAlias = 'simulate_queue'

    // Pure PL/SQL busy-wait (no DBMS_SESSION.SLEEP dependency, see oracledbexec.test.js)
    // — portable across Oracle versions/grants. Holds a connection for `seconds`.
    // Uses "SELECT INTO" rather than ":=" to assign v_start — bind-sql-string (used
    // for dev-mode SQL logging) misparses ":=" as an empty bind variable and throws.
    const spinSql = (seconds) =>
        `/* SIMULATE_HOLDER */ DECLARE v_start PLS_INTEGER; ` +
        `BEGIN SELECT DBMS_UTILITY.GET_TIME INTO v_start FROM DUAL; ` +
        `LOOP EXIT WHEN DBMS_UTILITY.GET_TIME - v_start > ${seconds * 100}; END LOOP; END;`

    await oracledbexec.initialize(
        { poolAlias, poolMin: 2, poolMax: 2, poolIncrement: 0, queueMax: 5, queueTimeout: 2000 },
        (event) => {
            if (event.event === oracledbexec.POOL_EVENTS.QUEUE_TIMEOUT) {
                console.error(`\n🧪 [simulate] ${event.poolAlias} queue full — waited ${event.elapsedMs}ms then failed`)
                console.log('   Who was holding connections (heldBy):')
                console.table(event.heldBy)
            }
        }
    )

    try {
        // Saturate both connections for 5s each — well past this pool's queueTimeout (2s).
        const holders = [
            oracledbexec.oraexec(spinSql(5), {}, poolAlias).catch(() => {}),
            oracledbexec.oraexec(spinSql(5), {}, poolAlias).catch(() => {})
        ]

        // Give the holders a moment to actually grab both connections.
        await new Promise(resolve => setTimeout(resolve, 300))

        // Pool is full — this one queues, waits 2s, and fails with NJS-040.
        try {
            await oracledbexec.oraexec('SELECT 1 FROM DUAL', {}, poolAlias)
        } catch (err) {
            console.log(`\nExpected failure: ${err.message}`)
        }

        // getSlowQueries() shows what's still (or was) holding connections — the culprit
        // behind the NJS-040 above, same info as the event callback's heldBy, live.
        console.log('\ngetSlowQueries:', oracledbexec.getSlowQueries(0).filter(q => q.poolAlias === poolAlias))

        await Promise.all(holders)
    } finally {
        await oracledbexec.close(poolAlias)
    }
}

main()

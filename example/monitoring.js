/**
 * Pool event callback + monitoring/diagnostics usage
 * (POOL_EVENTS, getPoolStats, getPoolStatisticsRealtime, getSlowQueries).
 * Run with: node example/monitoring.js  (requires a configured .env, see .env.example)
 */

require('dotenv').config()
const oracledbexec = require('../oracledbexec')
const { POOL_EVENTS } = oracledbexec

async function main() {
    await oracledbexec.initialize({}, (event) => {
        switch (event.event) {
            case POOL_EVENTS.HIGH_POOL_USAGE:
                console.warn(`⚠️  Pool ${event.poolAlias} at ${event.usagePercent.toFixed(1)}%`)
                break
            case POOL_EVENTS.POOL_EXHAUSTED:
                console.error(`🚨 Pool ${event.poolAlias} exhausted`, event.stats)
                break
            case POOL_EVENTS.QUEUE_TIMEOUT:
                console.error(`⏱️  Query stuck ${event.elapsedMs}ms in ${event.poolAlias}: ${event.sql} ${event.param} (${event.caller})`)
                if (event.heldBy.length) console.table(event.heldBy)
                break
        }
    })

    try {
        console.log('getPoolStats:', oracledbexec.getPoolStats())
        console.log('getPoolStatisticsRealtime:', oracledbexec.getPoolStatisticsRealtime())

        // Queries still running now, past 60s (default threshold) — a live view.
        console.log('getSlowQueries:', oracledbexec.getSlowQueries())
    } finally {
        await oracledbexec.close()
    }
}

main()

/**
 * Transaction usage (oraexectrans) — multiple queries, auto commit/rollback.
 * Run with: node example/transaction.js  (requires a configured .env, see .env.example)
 */

require('dotenv').config()
const oracledbexec = require('../oracledbexec')

async function main() {
    await oracledbexec.initialize()

    try {
        const txResults = await oracledbexec.oraexectrans([
            { query: 'SELECT 10 as val FROM DUAL' },
            { query: 'SELECT 20 as val FROM DUAL' }
        ])
        console.log('oraexectrans:', txResults.map(r => r.results.rows))
    } finally {
        await oracledbexec.close()
    }
}

main()

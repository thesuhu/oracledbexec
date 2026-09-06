/**
 * Basic single-query usage (oraexec).
 * Run with: node example/basic-query.js  (requires a configured .env, see .env.example)
 */

require('dotenv').config()
const oracledbexec = require('../oracledbexec')

async function main() {
    await oracledbexec.initialize()

    try {
        const result = await oracledbexec.oraexec(
            'SELECT * FROM countries WHERE country_id = :country_id',
            { country_id: 'JP' }
        )
        console.log('oraexec:', result.rows)
    } finally {
        await oracledbexec.close()
    }
}

main()

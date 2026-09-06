/**
 * Manual transaction usage (begintrans/exectrans/committrans/rollbacktrans).
 * Run with: node example/manual-transaction.js  (requires a configured .env, see .env.example)
 */

require('dotenv').config()
const oracledbexec = require('../oracledbexec')

async function main() {
    await oracledbexec.initialize()

    try {
        const connection = await oracledbexec.begintrans()
        try {
            const manual = await oracledbexec.exectrans(connection, 'SELECT 99 as val FROM DUAL')
            console.log('exectrans:', manual.rows)
            await oracledbexec.committrans(connection)
        } catch (err) {
            await oracledbexec.rollbacktrans(connection)
            throw err
        }
    } finally {
        await oracledbexec.close()
    }
}

main()

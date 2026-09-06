/**
 * UNIT TEST FOR ORACLEDBEXEC
 * Using Jest framework for professional testing.
 * Standardizing on v2.1.0 features.
 */

require('dotenv').config()
const db = require('./oracledbexec')
const oracledb = require('oracledb')

// Increase timeout as Oracle connections can be slow
jest.setTimeout(30000)

describe('OracleDBExec Library Tests (v2.1.0)', () => {

    // Initialize pool before all tests
    beforeAll(async () => {
        try {
            await db.initialize()
        } catch (err) {
            console.error('Failed to initialize primary pool:', err.message)
        }
    })

    // Close all pools after all tests
    afterAll(async () => {
        await db.close()
    })

    describe('Basic Execution (oraexec)', () => {
        test('should execute a simple query successfully', async () => {
            const sql = 'SELECT 1 as num FROM DUAL'
            const result = await db.oraexec(sql)

            expect(result).toBeDefined()
            expect(result.rows).toBeDefined()
            expect(result.rows[0].NUM).toBe(1)
        })

        test('should support custom execution options', async () => {
            const sql = 'SELECT 0.5 as val FROM DUAL'
            const options = {
                fetchInfo: { "VAL": { type: oracledb.STRING } }
            }
            const result = await db.oraexec(sql, {}, 'default', options)
            // Use parseFloat to handle both "0.5" or ".5" formatting
            expect(parseFloat(result.rows[0].VAL)).toBe(0.5)
        })

        test('should throw error for invalid SQL and show caller trace', async () => {
            const sql = 'SELECT * FROM NON_EXISTENT_TABLE_999'
            await expect(db.oraexec(sql)).rejects.toThrow()
        })
    })

    describe('Transaction Management (oraexectrans)', () => {
        test('should execute bulk queries in a transaction', async () => {
            const queries = [
                { query: 'SELECT 10 as val FROM DUAL' },
                { query: 'SELECT 20 as val FROM DUAL' }
            ]
            const results = await db.oraexectrans(queries)

            expect(results).toHaveLength(2)
            expect(results[0].results.rows[0].VAL).toBe(10)
            expect(results[1].results.rows[0].VAL).toBe(20)
        })
    })

    describe('Manual Transaction', () => {
        test('should handle manual begin, exec, and commit', async () => {
            const conn = await db.begintrans()
            expect(conn).toBeDefined()

            try {
                const res = await db.exectrans(conn, 'SELECT 99 as val FROM DUAL')
                expect(res.rows[0].VAL).toBe(99)
                await db.committrans(conn)
            } catch (err) {
                await db.rollbacktrans(conn)
                throw err
            }
        })
    })

    describe('Monitoring & Stats', () => {
        test('should return custom pool statistics', () => {
            const stats = db.getPoolStats()
            expect(stats).toBeDefined()
        })

        test('should return raw realtime statistics', () => {
            const stats = db.getPoolStatisticsRealtime()
            // Should not throw even if null
            expect(stats !== undefined).toBe(true)
        })
    })

    describe('Slow Query Tracking & Pool Events (v2.1.0)', () => {
        test('getSlowQueries returns an array when ORACLE_QUERY_TRACKING is disabled (default)', () => {
            const result = db.getSlowQueries(0)
            expect(Array.isArray(result)).toBe(true)
        })

        test('tracks an in-flight query and clears it on completion when ORACLE_QUERY_TRACKING=true', async () => {
            process.env.ORACLE_QUERY_TRACKING = 'true'
            jest.resetModules()
            const dbTracked = require('./oracledbexec')
            await dbTracked.initialize({ poolAlias: 'tracked_pool', poolMax: 2, poolMin: 1 })

            try {
                // Pure PL/SQL busy-wait spin loop using DBMS_UTILITY.GET_TIME (centiseconds,
                // monotonic, granted to PUBLIC everywhere) — avoids SYSTIMESTAMP/timezone
                // comparison pitfalls and doesn't depend on DBMS_SESSION.SLEEP being available.
                const slowSql = "/* SPINWAIT_HOLDER */ DECLARE v_start PLS_INTEGER := DBMS_UTILITY.GET_TIME; BEGIN LOOP EXIT WHEN DBMS_UTILITY.GET_TIME - v_start > 200; END LOOP; END;"

                let match
                await Promise.all([
                    dbTracked.oraexec(slowSql, {}, 'tracked_pool'),
                    (async () => {
                        // Give the query a moment to register as in-flight
                        await new Promise(resolve => setTimeout(resolve, 300))
                        const inFlight = dbTracked.getSlowQueries(0)
                        match = inFlight.find(q => q.poolAlias === 'tracked_pool' && q.sql.includes('SPINWAIT_HOLDER'))
                    })()
                ])

                expect(match).toBeDefined()
                // oraexec() resolves _getCaller() synchronously at its very top, before any
                // await, so it reflects this test's own call site (line 119 above) rather than
                // something deeper in oracledbexec.js's internals — should reliably be this
                // file, not the 'unknown' fallback.
                expect(typeof match.caller).toBe('string')
                expect(match.caller).not.toBe('unknown')
                expect(match.caller).toContain('oracledbexec.test.js')

                const afterCompletion = dbTracked.getSlowQueries(0)
                expect(afterCompletion.some(q => q.queryId === match.queryId)).toBe(false)
            } finally {
                await dbTracked.close('tracked_pool')
                delete process.env.ORACLE_QUERY_TRACKING
            }
        })

        test('records NJS-040 queue timeout with a heldBy snapshot of the connection-holding query', async () => {
            process.env.ORACLE_QUERY_TRACKING = 'true'
            jest.resetModules()
            const dbQueue = require('./oracledbexec')

            const events = []
            await dbQueue.initialize(
                { poolAlias: 'queue_pool', poolMax: 1, poolMin: 1, poolIncrement: 0, queueTimeout: 1000, queueMax: 10 },
                (evt) => events.push(evt)
            )

            try {
                // Holds the pool's only connection for 3s (DBMS_UTILITY.GET_TIME spin-wait, see above).
                const holderSql = "/* SPINWAIT_HOLDER */ DECLARE v_start PLS_INTEGER := DBMS_UTILITY.GET_TIME; BEGIN LOOP EXIT WHEN DBMS_UTILITY.GET_TIME - v_start > 300; END LOOP; END;"
                const holder = dbQueue.oraexec(holderSql, {}, 'queue_pool')

                // Give the holder time to actually grab the connection.
                await new Promise(resolve => setTimeout(resolve, 200))

                // Should queue for 1s (queueTimeout) then reject with NJS-040, well before the holder finishes.
                await expect(dbQueue.oraexec('SELECT 1 FROM DUAL', {}, 'queue_pool')).rejects.toThrow(/NJS-040/)

                const queueEvent = events.find(e => e.event === 'queue_timeout')
                expect(queueEvent).toBeDefined()
                // caller resolved synchronously at the top of oraexec(), before any
                // await, so it should reliably be this file — not the 'unknown' fallback.
                expect(queueEvent.caller).not.toBe('unknown')
                expect(queueEvent.caller).toContain('oracledbexec.test.js')
                expect(queueEvent.heldBy.length).toBeGreaterThan(0)
                expect(queueEvent.heldBy[0].sql).toContain('SPINWAIT_HOLDER')
                expect(queueEvent.heldBy[0].caller).not.toBe('unknown')
                expect(queueEvent.heldBy[0].caller).toContain('oracledbexec.test.js')

                await holder
            } finally {
                await dbQueue.close('queue_pool')
                delete process.env.ORACLE_QUERY_TRACKING
            }
        })
    })

    describe('Caller Resolution (v2.1.0 fix — resolved before any await, not deep in internals)', () => {
        test('oraexectrans() reports the same caller for every query in the transaction', async () => {
            process.env.ORACLE_QUERY_TRACKING = 'true'
            jest.resetModules()
            const dbTx = require('./oracledbexec')
            await dbTx.initialize({ poolAlias: 'caller_tx_pool', poolMax: 2, poolMin: 1 })

            try {
                const slowSql = "/* CALLER_TX_HOLDER */ DECLARE v_start PLS_INTEGER := DBMS_UTILITY.GET_TIME; BEGIN LOOP EXIT WHEN DBMS_UTILITY.GET_TIME - v_start > 200; END LOOP; END;"

                let match
                await Promise.all([
                    dbTx.oraexectrans([
                        { query: 'SELECT 1 as val FROM DUAL' },
                        { query: slowSql }, // <- the one we expect to catch in-flight below
                        { query: 'SELECT 2 as val FROM DUAL' }
                    ], 'caller_tx_pool'),
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, 100))
                        const inFlight = dbTx.getSlowQueries(0)
                        match = inFlight.find(q => q.poolAlias === 'caller_tx_pool' && q.sql.includes('CALLER_TX_HOLDER'))
                    })()
                ])

                expect(match).toBeDefined()
                // caller is resolved once, synchronously, at the top of oraexectrans() —
                // the line that called oraexectrans() (this file), not somewhere inside
                // the per-query loop in oracledbexec.js.
                expect(match.caller).not.toBe('unknown')
                expect(match.caller).toContain('oracledbexec.test.js')
            } finally {
                await dbTx.close('caller_tx_pool')
                delete process.env.ORACLE_QUERY_TRACKING
            }
        })

        test('exectrans() (manual transaction) reports the real call-site caller', async () => {
            process.env.ORACLE_QUERY_TRACKING = 'true'
            jest.resetModules()
            const dbManual = require('./oracledbexec')
            await dbManual.initialize({ poolAlias: 'caller_manual_pool', poolMax: 1, poolMin: 1 })

            const slowSql = "/* CALLER_MANUAL_HOLDER */ DECLARE v_start PLS_INTEGER := DBMS_UTILITY.GET_TIME; BEGIN LOOP EXIT WHEN DBMS_UTILITY.GET_TIME - v_start > 200; END LOOP; END;"
            let conn
            try {
                conn = await dbManual.begintrans('caller_manual_pool')

                let match
                await Promise.all([
                    dbManual.exectrans(conn, slowSql),
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, 100))
                        const inFlight = dbManual.getSlowQueries(0)
                        match = inFlight.find(q => q.poolAlias === 'caller_manual_pool' && q.sql.includes('CALLER_MANUAL_HOLDER'))
                    })()
                ])

                expect(match).toBeDefined()
                expect(match.caller).not.toBe('unknown')
                expect(match.caller).toContain('oracledbexec.test.js')

                await dbManual.committrans(conn)
                conn = null // committrans already closed it
            } finally {
                if (conn) await dbManual.rollbacktrans(conn).catch(() => {})
                await dbManual.close('caller_manual_pool')
                delete process.env.ORACLE_QUERY_TRACKING
            }
        })

        test('begintrans() reports the real call-site caller on a queue_timeout', async () => {
            jest.resetModules()
            const dbBegin = require('./oracledbexec')

            const events = []
            await dbBegin.initialize(
                { poolAlias: 'caller_begin_pool', poolMax: 1, poolMin: 1, poolIncrement: 0, queueTimeout: 1000, queueMax: 10 },
                (evt) => events.push(evt)
            )

            try {
                const holderSql = "/* CALLER_BEGIN_HOLDER */ DECLARE v_start PLS_INTEGER := DBMS_UTILITY.GET_TIME; BEGIN LOOP EXIT WHEN DBMS_UTILITY.GET_TIME - v_start > 300; END LOOP; END;"
                const holder = dbBegin.oraexec(holderSql, {}, 'caller_begin_pool')

                await new Promise(resolve => setTimeout(resolve, 200))

                // Pool's only connection is held — this should queue, wait 1s, and
                // fail with NJS-040, well before the holder finishes.
                await expect(dbBegin.begintrans('caller_begin_pool')).rejects.toThrow(/NJS-040/)

                const queueEvent = events.find(e => e.event === 'queue_timeout')
                expect(queueEvent).toBeDefined()
                expect(queueEvent.caller).not.toBe('unknown')
                expect(queueEvent.caller).toContain('oracledbexec.test.js')

                await holder
            } finally {
                await dbBegin.close('caller_begin_pool')
            }
        })

        // colorconsole captures `const log = console.log` once at require time (before any
        // spy exists), so jest.spyOn(console, 'log') never intercepts it — that captured
        // reference stays bound to the original function. Spying on process.stdout.write
        // works instead, since Node's console.log resolves it live on every call.
        test('initialize() logs the real call-site caller on failure', async () => {
            const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
            try {
                await expect(db.initialize({ user: '', password: '', connectString: '' })).rejects.toThrow()

                const logged = writeSpy.mock.calls.map(args => args[0]).join('\n')
                expect(logged).toContain('Initialization failed at')
                expect(logged).toContain('oracledbexec.test.js')
            } finally {
                writeSpy.mockRestore()
            }
        })

        test('committrans() logs the real call-site caller on failure', async () => {
            const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
            // Fake connection — no live DB needed, just needs .commit() to reject and .close() to resolve.
            const fakeConnection = {
                commit: () => Promise.reject(new Error('simulated commit failure')),
                close: () => Promise.resolve()
            }
            try {
                await expect(db.committrans(fakeConnection)).rejects.toThrow('simulated commit failure')

                const logged = writeSpy.mock.calls.map(args => args[0]).join('\n')
                expect(logged).toContain('Commit error at')
                expect(logged).toContain('oracledbexec.test.js')
            } finally {
                writeSpy.mockRestore()
            }
        })

        test('rollbacktrans() logs the real call-site caller on failure', async () => {
            const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
            const fakeConnection = {
                rollback: () => Promise.reject(new Error('simulated rollback failure')),
                close: () => Promise.resolve()
            }
            try {
                await expect(db.rollbacktrans(fakeConnection)).rejects.toThrow('simulated rollback failure')

                const logged = writeSpy.mock.calls.map(args => args[0]).join('\n')
                expect(logged).toContain('Rollback error at')
                expect(logged).toContain('oracledbexec.test.js')
            } finally {
                writeSpy.mockRestore()
            }
        })
    })
})

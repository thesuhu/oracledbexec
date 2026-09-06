const oracledb = require('oracledb')
const { queryBindToString } = require('bind-sql-string')
const { logConsole, errorConsole, sqlLogConsole } = require('@thesuhu/colorconsole')

// Event names sent to the onPoolEvent callback passed to initialize() — use these
// instead of hardcoding the strings so a typo can't silently miss an event.
const POOL_EVENTS = Object.freeze({
    HIGH_POOL_USAGE: 'high_pool_usage',
    POOL_EXHAUSTED: 'pool_exhausted',
    POOL_RECOVERED: 'pool_recovered',
    QUEUE_TIMEOUT: 'queue_timeout',
    POOL_INITIALIZED: 'pool_initialized',
    POOL_CLOSED: 'pool_closed'
})
exports.POOL_EVENTS = POOL_EVENTS

// ── ENVIRONMENT CONFIGURATION ────────────────────────────────────────

const env = process.env.NODE_ENV || 'dev'
const isDev = ['dev', 'devel', 'development'].includes(env)
const thinMode = process.env.THIN_MODE || 'true'

// Helper for safe integer parsing
const safeParseInt = (val, defaultValue, allowZero = false) => {
    const parsed = parseInt(val, 10)
    if (isNaN(parsed) || parsed < 0) return defaultValue
    if (!allowZero && parsed === 0) return defaultValue
    return parsed
}

const poolClosingTime = safeParseInt(process.env.POOL_CLOSING_TIME, 0, true)

// Built-in monitoring config
const enableMonitoring = process.env.ORACLE_POOL_MONITORING === 'true'
const monitoringInterval = safeParseInt(process.env.ORACLE_MONITOR_INTERVAL, 30000)

// Slow query tracking config (opt-in, off by default)
const enableQueryTracking = process.env.ORACLE_QUERY_TRACKING === 'true'

// Set Thread Pool Size BEFORE any async tasks
const poolMaxDefault = safeParseInt(process.env.POOL_MAX, 8)
process.env.UV_THREADPOOL_SIZE = poolMaxDefault + 4

// Oracle Thin Mode setup
if (thinMode === 'false') {
    try {
        const initOptions = {}
        if (process.env.ORACLE_CLIENT_LIB_DIR) {
            initOptions.libDir = process.env.ORACLE_CLIENT_LIB_DIR
        }
        oracledb.initOracleClient(initOptions)
    } catch (err) {
        errorConsole('Oracle Client initialization failed: ' + err.message)
    }
}

// Default Database Config
const dbconfig = {
    user: process.env.ORA_USR,
    password: process.env.ORA_PWD,
    connectString: process.env.ORA_CONSTR,
    poolMin: safeParseInt(process.env.POOL_MIN, 2),
    poolMax: poolMaxDefault,
    poolIncrement: safeParseInt(process.env.POOL_INCREMENT, 1),
    poolAlias: process.env.POOL_ALIAS || 'default',
    poolPingInterval: safeParseInt(process.env.POOL_PING_INTERVAL, 30),
    poolTimeout: safeParseInt(process.env.POOL_TIMEOUT, 120, true),
    queueMax: safeParseInt(process.env.QUEUE_MAX, 50, true),
    queueTimeout: safeParseInt(process.env.QUEUE_TIMEOUT, 5000, true),
}

const poolMonitors = new Map()
const activePools = new Set()
// Live in-flight queries, one sub-map per pool alias (flag-gated, churns fast,
// cleared on completion). Keyed per alias — not one flat Map — so a busy pool
// can't evict another pool's tracked entries out from under it.
const activeQueriesByAlias = new Map()
const poolEventCallbacks = new Map()

// Per pool alias, not a global total — each pool alias gets its own budget.
const MAX_TRACKED_QUERIES = 1000
// Cap on how many connection-holding queries _snapshotHolders() reports per
// queue timeout — top N by elapsed time, enough to spot the culprit without
// bloating the queue_timeout event/log entry.
const MAX_HELD_BY = 5

/**
 * Gets (creating if needed) the per-pool-alias sub-map from a two-level store.
 * @param {Map<string, Map>} store
 * @param {string} poolAlias
 * @returns {Map}
 */
const _aliasMap = (store, poolAlias) => {
    let map = store.get(poolAlias)
    if (!map) {
        map = new Map()
        store.set(poolAlias, map)
    }
    return map
}

/**
 * Invokes the registered event callback for a pool alias, if any.
 * Errors thrown by the callback are caught so they never break monitoring/execution.
 * @param {string} poolAlias
 * @param {Object} payload
 */
const _fireEvent = (poolAlias, payload) => {
    const cb = poolEventCallbacks.get(poolAlias)
    if (typeof cb !== 'function') return
    try {
        cb(payload)
    } catch (err) {
        errorConsole(`⚠️  Pool event callback error: ${err.message}`)
    }
}

// ── POOL MONITOR CLASS ───────────────────────────────────────────────

/**
 * Built-in Pool Monitor to track health and statistics of Oracle connection pools.
 */
class BuiltInPoolMonitor {
    /**
     * @param {string} poolAlias
     * @param {number} intervalMs
     */
    constructor(poolAlias, intervalMs) {
        this.poolAlias = poolAlias
        this.intervalMs = intervalMs
        this.monitorInterval = null
        // Tracks whether the last check was warning/exhausted, so we know when
        // to fire POOL_RECOVERED — only on the transition back to healthy, not
        // on every healthy check.
        this.wasUnhealthy = false
        this.stats = {
            totalConnections: 0,
            busyConnections: 0,
            freeConnections: 0,
            queuedRequests: 0,
            lastCheck: null,
            poolStatus: 'unknown',
            warnings: 0,
            errors: []
        }
    }

    /**
     * Start the monitoring interval.
     */
    start() {
        if (this.monitorInterval) return
        logConsole(`🔍 Pool monitoring active: ${this.poolAlias}`)
        this.monitorInterval = setInterval(() => this.checkPoolHealth(), this.intervalMs)
    }

    /**
     * Stop the monitoring interval.
     */
    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval)
            this.monitorInterval = null
            logConsole('Pool monitoring stopped')
        }
    }

    /**
     * Perform a health check on the pool and update internal stats.
     */
    checkPoolHealth() {
        try {
            const pool = oracledb.getPool(this.poolAlias)
            // pool.connectionsOpen is already the TOTAL number of connections the pool
            // has physically opened (busy + idle combined), not just the idle ones.
            this.stats = {
                ...this.stats,
                totalConnections: pool.connectionsOpen,
                busyConnections: pool.connectionsInUse,
                freeConnections: pool.connectionsOpen - pool.connectionsInUse,
                queuedRequests: pool.queueLength || 0,
                lastCheck: new Date().toISOString(),
                poolStatus: 'healthy'
            }

            const usagePercent = (this.stats.busyConnections / Math.max(this.stats.totalConnections, 1)) * 100
            const isExhausted = this.stats.busyConnections >= this.stats.totalConnections && this.stats.totalConnections > 0
            const isUnhealthy = usagePercent > 80 || isExhausted

            if (usagePercent > 80) {
                this.stats.poolStatus = 'warning'
                this.stats.warnings++
                if (this.stats.warnings % 10 === 1) {
                    logConsole(`⚠️  High pool usage: ${usagePercent.toFixed(1)}%`)
                }
                _fireEvent(this.poolAlias, {
                    event: POOL_EVENTS.HIGH_POOL_USAGE,
                    poolAlias: this.poolAlias,
                    usagePercent,
                    stats: this.stats,
                    timestamp: this.stats.lastCheck
                })
            }

            if (isExhausted) {
                this.stats.poolStatus = 'exhausted'
                errorConsole('🚨 Pool exhausted!')
                _fireEvent(this.poolAlias, {
                    event: POOL_EVENTS.POOL_EXHAUSTED,
                    poolAlias: this.poolAlias,
                    stats: this.stats,
                    timestamp: this.stats.lastCheck
                })
            }

            if (!isUnhealthy && this.wasUnhealthy) {
                logConsole(`✅ Pool recovered: ${this.poolAlias}`)
                _fireEvent(this.poolAlias, {
                    event: POOL_EVENTS.POOL_RECOVERED,
                    poolAlias: this.poolAlias,
                    stats: this.stats,
                    timestamp: this.stats.lastCheck
                })
            }
            this.wasUnhealthy = isUnhealthy
        } catch (err) {
            this._logError(err.message)
        }
    }

    /**
     * @param {string} message
     */
    _logError(message) {
        this.stats.errors.push({ timestamp: new Date().toISOString(), error: message })
        if (this.stats.errors.length > 10) this.stats.errors.shift()
    }

    /**
     * @returns {Object} Current pool statistics
     */
    getStats() { return this.stats }
}

// ── INTERNAL HELPERS ────────────────────────────────────────────────

/**
 * Cleans up and truncates SQL for logging purposes.
 * @param {string} sql
 * @returns {string} Truncated SQL snippet.
 */
const _shortSql = (sql) => {
    if (!sql || typeof sql !== 'string') return ''
    return sql.replace(/\s+/g, ' ').trim().substring(0, 50) + (sql.length > 50 ? '...' : '')
}

/**
 * Stringifies and truncates bind parameters for tracking/logging purposes,
 * so a slow/stuck query can be reproduced from what getSlowQueries() reports.
 * @param {Object|Array} param
 * @returns {string} Truncated JSON snippet, or '' if there's nothing to show.
 */
const _shortParam = (param) => {
    if (!param || (typeof param === 'object' && Object.keys(param).length === 0)) return ''
    try {
        const str = JSON.stringify(param)
        return str.length > 100 ? `${str.substring(0, 100)}...` : str
    } catch (_) {
        return ''
    }
}

/**
 * Captures the caller's stack frame to identify the source of the call.
 * @returns {string} Filename and line info (e.g., "user.controller.js:42").
 */
const _getCaller = () => {
    try {
        const stack = new Error().stack.split('\n')
        const frame = stack.find(line =>
            line.includes('at ') &&
            !line.includes('oracledbexec.js') &&
            !line.includes('node:internal') &&
            !line.includes('Error')
        )
        if (!frame) return 'unknown'

        // Extract filename and line (supports Mac/Linux/Windows paths)
        const match = frame.match(/[\\/]([^\\/():]+):(\d+):(\d+)/) || frame.match(/at ([^\\/():]+):(\d+):(\d+)/)
        if (match) {
            return `${match[1]}:${match[2]}`
        }
        return 'unknown'
    } catch (_) {
        return 'unknown'
    }
}

/**
 * Logs the query and its parameters in dev mode, under the given query ID —
 * the same ID used for tracking (_trackStart) so a query can be correlated
 * between the dev console log and getSlowQueries() output.
 * @param {string} queryId
 * @param {string} sql
 * @param {Object} param
 */
const _logQuery = (queryId, sql, param) => {
    if (isDev) {
        sqlLogConsole(`[QID:${queryId}] ${queryBindToString(sql, param)}`)
    }
}

/**
 * Generates a short random correlation ID (QID/TXID/tracking key).
 * 8 hex chars (~4 billion combinations) — keeps collisions negligible even with
 * MAX_TRACKED_QUERIES concurrent entries per pool alias.
 * padEnd guards against Math.random() occasionally yielding fewer hex digits.
 * @returns {string}
 */
const _genId = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0').toUpperCase()

/**
 * Evicts the oldest entry (Map preserves insertion order, oldest first)
 * from the given map whenever it's at capacity, so it never exceeds
 * MAX_TRACKED_QUERIES and stays ordered oldest → newest.
 * @param {Map} map
 */
const _evictOldestIfFull = (map) => {
    if (map.size >= MAX_TRACKED_QUERIES) {
        map.delete(map.keys().next().value)
    }
}

/**
 * Detects a connection pool exhaustion error: NJS-040 (queue timeout, request
 * waited QUEUE_TIMEOUT without getting a connection) or NJS-076 (queue full,
 * queueMax reached). Both are direct evidence the pool ran out of connections.
 * @param {Error} err
 * @returns {boolean}
 */
const _isQueueTimeoutError = (err) => !!(err && err.message && (err.message.includes('NJS-040') || err.message.includes('NJS-076')))

/**
 * Registers a query as currently running, for slow-query tracking.
 * No-op unless ORACLE_QUERY_TRACKING is enabled.
 * @param {string} queryId
 * @param {string} sql
 * @param {Object|Array} param Bind parameters, so a slow/stuck query can be reproduced.
 * @param {string} poolAlias
 * @param {string} [caller] Pre-resolved caller (see _getCaller) — pass this when the call site
 *   is several `await`s removed from the original request, so the stack is captured early
 *   (synchronously, at the top of the exported function) instead of at this deeper point,
 *   where V8 may have already lost it. Falls back to resolving it here if omitted.
 */
const _trackStart = (queryId, sql, param, poolAlias, caller = _getCaller()) => {
    if (!enableQueryTracking) return
    const map = _aliasMap(activeQueriesByAlias, poolAlias)
    _evictOldestIfFull(map)
    map.set(queryId, {
        sql: _shortSql(sql),
        param: _shortParam(param),
        poolAlias,
        caller,
        startTime: Date.now()
    })
}

/**
 * Unregisters a query once it finishes (success or error).
 * @param {string} queryId
 * @param {string} poolAlias
 */
const _trackEnd = (queryId, poolAlias) => {
    const map = activeQueriesByAlias.get(poolAlias)
    if (map) map.delete(queryId)
}

/**
 * Snapshots the queries currently holding a connection on the given pool,
 * sorted by longest-running first. Taken at the moment NJS-040/076 is raised,
 * since activeQueriesByAlias churns fast and the holder may finish (and be
 * removed) before the caller gets around to querying getSlowQueries() themselves.
 * @param {string} poolAlias
 * @returns {Array<{sql: string, param: string, caller: string, elapsedMs: number}>}
 */
const _snapshotHolders = (poolAlias) => {
    const map = activeQueriesByAlias.get(poolAlias)
    if (!map) return []
    const now = Date.now()
    return [...map.values()]
        .map(q => ({ sql: q.sql, param: q.param, caller: q.caller, elapsedMs: now - q.startTime }))
        .sort((a, b) => b.elapsedMs - a.elapsedMs)
        .slice(0, MAX_HELD_BY)
}

/**
 * Fires the queue_timeout pool event for a connection-pool queue timeout
 * (NJS-040 waited past queueTimeout, or NJS-076 queue full past queueMax) —
 * this is a real-time push, not a stored record; there's no pull/history API
 * for past incidents, only the live in-flight view (getSlowQueries()) and
 * this event, fired the instant the failure happens.
 * Captures a snapshot (heldBy) of the queries currently holding connections
 * on this pool, so the culprit is visible even if it finishes right after
 * the event fires and before the callback gets a chance to look.
 * @param {string} sql
 * @param {Object|Array} param Bind parameters of the request that failed to get a connection.
 * @param {string} poolAlias
 * @param {number} queueStartTime Timestamp when the connection was requested.
 * @param {string} [caller] Pre-resolved caller (see _trackStart's jsdoc for why) — this always
 *   fires from inside a catch block, at least one `await` removed from the original call site,
 *   so passing it in early avoids an unreliable/late _getCaller() resolution here.
 */
const _fireQueueTimeoutEvent = (sql, param, poolAlias, queueStartTime, caller = _getCaller()) => {
    _fireEvent(poolAlias, {
        event: POOL_EVENTS.QUEUE_TIMEOUT,
        poolAlias,
        sql: _shortSql(sql),
        param: _shortParam(param),
        caller,
        elapsedMs: Date.now() - queueStartTime,
        heldBy: _snapshotHolders(poolAlias),
        timestamp: new Date().toISOString()
    })
}

/**
 * Logs the execution duration in a neat format.
 * @param {number} startTime
 * @param {string} queryId
 * @param {string} [label='Execution time']
 */
const _logTime = (startTime, queryId, label = 'Execution time') => {
    if (isDev) {
        const duration = Date.now() - startTime
        const formattedTime = duration > 1000 ? `${(duration / 1000).toFixed(2)}s` : `${duration}ms`
        logConsole(`⏱️  [QID:${queryId}] ${label}: ${formattedTime}`)
    }
}

// ── EXPORTED METHODS ────────────────────────────────────────────────

/**
 * Sets which Oracle DB types are auto-converted to JS strings on fetch — most
 * commonly used for `oracledb.CLOB` (and `oracledb.NCLOB`, a separate type)
 * so LOB columns come back as plain strings instead of Lob stream objects.
 * This sets oracledb's global `fetchAsString`, applying to every query on
 * this same oracledb instance (i.e. every query made through this library).
 * Call once at app startup, before running any queries.
 * @param {Array<oracledb.DbType>} types e.g. [oracledb.CLOB, oracledb.NCLOB]
 */
exports.setFetchAsString = (types) => {
    oracledb.fetchAsString = types
}

/**
 * Initialize Oracle connection pool.
 * @param {oracledb.PoolAttributes} [customConfig] Optional custom configuration to override environment defaults.
 * @param {function(Object): void} [onPoolEvent] Optional callback invoked on pool events —
 *   compare `event.event` against the exported `POOL_EVENTS` constants:
 *   `POOL_EVENTS.HIGH_POOL_USAGE` (>80% usage, requires ORACLE_POOL_MONITORING=true),
 *   `POOL_EVENTS.POOL_EXHAUSTED` (requires ORACLE_POOL_MONITORING=true),
 *   `POOL_EVENTS.POOL_RECOVERED` (back to healthy after warning/exhausted, requires ORACLE_POOL_MONITORING=true),
 *   `POOL_EVENTS.QUEUE_TIMEOUT` (NJS-040/NJS-076, fires regardless of monitoring),
 *   `POOL_EVENTS.POOL_INITIALIZED` (fires once the pool is ready),
 *   `POOL_EVENTS.POOL_CLOSED` (fires once this pool is closed).
 * @returns {Promise<void>}
 * @throws {Error} If configuration is missing or pool creation fails.
 */
exports.initialize = async (customConfig = {}, onPoolEvent = null) => {
    // Resolved before the await below, so it reflects the app's actual
    // initialize() call site — see _trackStart's jsdoc.
    const caller = _getCaller()
    try {
        // Merge customConfig with dbconfig (custom overrides defaults)
        const config = { ...dbconfig, ...customConfig }
        if (!config.user || !config.password || !config.connectString) {
            throw new Error('Missing DB credentials (user, password, or connectString)')
        }

        const alias = config.poolAlias || 'default'
        logConsole(`🚀 Initializing pool: ${alias}`)
        await oracledb.createPool(config)
        activePools.add(alias)

        if (typeof onPoolEvent === 'function') {
            poolEventCallbacks.set(alias, onPoolEvent)
        }

        _fireEvent(alias, {
            event: POOL_EVENTS.POOL_INITIALIZED,
            poolAlias: alias,
            timestamp: new Date().toISOString()
        })

        // Start built-in monitoring if enabled
        if (enableMonitoring) {
            const monitor = new BuiltInPoolMonitor(alias, monitoringInterval)
            monitor.start()
            poolMonitors.set(alias, monitor)
        }
    } catch (err) {
        errorConsole(`❌ Initialization failed at ${caller}: ${err.message}`)
        throw err
    }
}

/**
 * Close connection pool(s).
 * @param {string|null} [poolAlias] The alias of the pool to close. If null/undefined, closes all active pools.
 * @returns {Promise<void>}
 */
exports.close = async (poolAlias = null) => {
    try {
        // Stop specific monitor or all monitors
        if (poolAlias) {
            const monitor = poolMonitors.get(poolAlias)
            if (monitor) {
                monitor.stop()
                poolMonitors.delete(poolAlias)
            }

            const pool = oracledb.getPool(poolAlias)
            await pool.close(poolClosingTime)
            activePools.delete(poolAlias)
            _fireEvent(poolAlias, {
                event: POOL_EVENTS.POOL_CLOSED,
                poolAlias,
                timestamp: new Date().toISOString()
            })
            poolEventCallbacks.delete(poolAlias)
            logConsole(`🔌 Pool closed: ${poolAlias}`)
        } else {
            // Stop all monitors
            for (const [alias, monitor] of poolMonitors) {
                monitor.stop()
            }
            poolMonitors.clear()

            // Close all pools
            for (const alias of activePools) {
                try {
                    const pool = oracledb.getPool(alias)
                    await pool.close(poolClosingTime)
                    _fireEvent(alias, {
                        event: POOL_EVENTS.POOL_CLOSED,
                        poolAlias: alias,
                        timestamp: new Date().toISOString()
                    })
                } catch (e) {
                    // Ignore if already closed
                }
            }
            activePools.clear()
            poolEventCallbacks.clear()
            logConsole('🔌 All pools closed')
        }
    } catch (err) {
        errorConsole('Error closing pools: ' + err.message)
    }
}

// ── QUERY EXECUTION ─────────────────────────────────────────────────

/**
 * Execute single query with auto-commit.
 * @param {string} sql SQL query string.
 * @param {Object|Array} [param] Bind parameters for the query (Object or Array).
 * @param {string} [poolAlias='default'] Pool alias to use.
 * @param {oracledb.ExecuteOptions} [options] Optional execution options to override defaults.
 * @returns {Promise<oracledb.Result<any>>}
 * @throws {Error} If execution fails.
 */
exports.oraexec = async (sql, param = {}, poolAlias = 'default', options = {}) => {
    if (!sql || typeof sql !== 'string') throw new Error('Valid SQL query string is required')

    let connection
    const qid = _genId()
    const requestStartTime = Date.now()
    // Resolved synchronously here, before any await, so the stack still
    // reflects the app's actual call site — see _trackStart's jsdoc.
    const caller = _getCaller()
    try {
        connection = await oracledb.getPool(poolAlias).getConnection()

        _logQuery(qid, sql, param)
        _trackStart(qid, sql, param, poolAlias, caller)

        const execOptions = {
            outFormat: oracledb.OBJECT,
            autoCommit: true,
            ...options
        }

        const startTime = Date.now()
        const result = await connection.execute(sql, param, execOptions)

        _logTime(startTime, qid)

        return result
    } catch (err) {
        if (_isQueueTimeoutError(err)) {
            _fireQueueTimeoutEvent(sql, param, poolAlias, requestStartTime, caller)
        }
        errorConsole(`🔥 SQL Execution error at ${caller} [SQL: ${_shortSql(sql)}]: ${err.message}`)
        throw err
    } finally {
        _trackEnd(qid, poolAlias)
        if (connection) {
            try {
                await connection.close()
            } catch (ce) {
                errorConsole(`⚠️  Connection close error: ${ce.message}`)
            }
        }
    }
}

/**
 * Execute multiple queries in a single transaction.
 * @param {Array<{query: string, parameters?: Object|Array}>} queries Array of query objects.
 * @param {string} [poolAlias='default'] Pool alias to use.
 * @param {oracledb.ExecuteOptions} [options] Optional execution options for each query in the transaction.
 * @returns {Promise<Array<{queryid: number, results: oracledb.Result<any>}>>}
 * @throws {Error} If any query in the transaction fails; performs automatic rollback.
 */
exports.oraexectrans = async (queries, poolAlias = 'default', options = {}) => {
    if (!Array.isArray(queries) || queries.length === 0) throw new Error('Queries must be a non-empty array')

    let connection
    let currentIndex = -1
    let committing = false
    let qid
    // Identifies the whole transaction attempt — used for the "Transaction total"
    // trace and, if the pool can't hand out a connection at all, as the queryId
    // for the resulting queue_timeout entry, so it's the same ID either way.
    // Not itself tracked in activeQueries — only individual queries are (see
    // qid below); a commit() or inter-query gap is intentionally not visible
    // in getSlowQueries()/heldBy, only actual query execution time is.
    const txid = _genId()
    const requestStartTime = Date.now()
    const firstQuery = queries[0] || {}
    const txDescription = `[TRANSACTION x${queries.length}] ${firstQuery.query || 'unknown'}`
    // Resolved synchronously here, before any await, so it reflects the app's
    // actual oraexectrans() call site — reused for every query in the loop
    // below instead of re-resolving _getCaller() at each (progressively
    // deeper, less reliable) await point. See _trackStart's jsdoc.
    const caller = _getCaller()
    try {
        connection = await oracledb.getPool(poolAlias).getConnection()
        const results = []

        const execOptions = {
            outFormat: oracledb.OBJECT,
            autoCommit: false,
            ...options
        }

        const startTime = Date.now()
        for (let i = 0; i < queries.length; i++) {
            currentIndex = i
            const { query: sql, parameters: param = {} } = queries[i]
            if (!sql) throw new Error(`Query at index ${i} is missing 'query' field`)

            qid = _genId()
            _logQuery(qid, sql, param)
            _trackStart(qid, sql, param, poolAlias, caller)
            const qStartTime = Date.now()

            const res = await connection.execute(sql, param, execOptions)
            _trackEnd(qid, poolAlias)

            _logTime(qStartTime, qid, `Query ${i} exec`)
            results.push({ queryid: i, results: res })
        }

        // Past the per-query loop now — an error here is a commit failure, not
        // a query failure, so the catch block below must not attribute it to
        // queries[currentIndex] (which already succeeded).
        committing = true
        await connection.commit()
        _logTime(startTime, txid, 'Transaction total')
        return results
    } catch (err) {
        if (_isQueueTimeoutError(err)) {
            _fireQueueTimeoutEvent(txDescription, firstQuery.parameters, poolAlias, requestStartTime, caller)
        }
        if (connection) await connection.rollback().catch(re => errorConsole(`Rollback failed: ${re.message}`))
        if (committing) {
            errorConsole(`💥 SQL Transaction commit error at ${caller}: ${err.message}`)
        } else {
            const failedQuery = (queries[currentIndex] && queries[currentIndex].query) ? queries[currentIndex].query : 'unknown'
            errorConsole(`💥 SQL Transaction error [Index: ${currentIndex}] at ${caller} [SQL: ${_shortSql(failedQuery)}]: ${err.message}`)
        }
        throw err
    } finally {
        if (qid) _trackEnd(qid, poolAlias)
        if (connection) await connection.close().catch(ce => errorConsole(`Connection close error: ${ce.message}`))
    }
}

// ── MANUAL TRANSACTION ──────────────────────────────────────────────

/**
 * Start a manual transaction session.
 * @param {string} [poolAlias='default'] Pool alias to use.
 * @returns {Promise<oracledb.Connection>} Active Oracle connection for manual transaction.
 */
exports.begintrans = async (poolAlias = 'default') => {
    const qid = _genId()
    const requestStartTime = Date.now()
    // Resolved before the await below, so it reflects the app's actual
    // begintrans() call site — see _trackStart's jsdoc.
    const caller = _getCaller()
    try {
        const connection = await oracledb.getPool(poolAlias).getConnection()
        // Tag the connection with its real pool alias so exectrans() can track
        // against it — without this, heldBy snapshots for a manual transaction's
        // queries would never match a queue_timeout on the pool they actually hold.
        connection._oracledbexecPoolAlias = poolAlias
        if (isDev) sqlLogConsole(`[QID:${qid}] 🔓 Manual transaction started`)
        return connection
    } catch (err) {
        if (_isQueueTimeoutError(err)) {
            _fireQueueTimeoutEvent('[MANUAL TRANSACTION begintrans]', null, poolAlias, requestStartTime, caller)
        }
        errorConsole(`❌ Error starting transaction at ${caller}: ${err.message}`)
        throw err
    }
}

/**
 * Execute query within an existing transaction session.
 * @param {oracledb.Connection} connection Active Oracle connection.
 * @param {string} sql SQL query string.
 * @param {Object|Array} [param] Bind parameters for the query.
 * @param {oracledb.ExecuteOptions} [options] Optional execution options.
 * @returns {Promise<oracledb.Result<any>>}
 * @throws {Error} If execution fails.
 */
exports.exectrans = async (connection, sql, param = {}, options = {}) => {
    if (!connection) throw new Error('Active connection is required')
    if (!sql) throw new Error('SQL query string is required')

    const qid = _genId()
    const poolAlias = connection._oracledbexecPoolAlias || 'manual-transaction'
    const caller = _getCaller()
    try {
        _logQuery(qid, sql, param)
        _trackStart(qid, sql, param, poolAlias, caller)
        const execOptions = {
            outFormat: oracledb.OBJECT,
            autoCommit: false,
            ...options
        }
        const startTime = Date.now()
        const result = await connection.execute(sql, param, execOptions)
        _logTime(startTime, qid, 'Exec duration')
        return result
    } catch (err) {
        errorConsole(`🔥 SQL Transaction exec error at ${caller} [SQL: ${_shortSql(sql)}]: ${err.message}`)
        throw err
    } finally {
        _trackEnd(qid, poolAlias)
    }
}

/**
 * Commit a manual transaction.
 * @param {oracledb.Connection} connection Active Oracle connection.
 * @returns {Promise<void>}
 */
exports.committrans = async (connection) => {
    if (!connection) throw new Error('Connection is required')
    // Resolved before the await below, so it reflects the app's actual
    // committrans() call site — see _trackStart's jsdoc.
    const caller = _getCaller()
    try {
        await connection.commit()
        if (isDev) sqlLogConsole('💎 Manual transaction committed')
    } catch (err) {
        errorConsole(`❌ Commit error at ${caller}: ${err.message}`)
        throw err
    } finally {
        await connection.close().catch(ce => errorConsole(`Connection close error: ${ce.message}`))
    }
}

/**
 * Rollback a manual transaction.
 * @param {oracledb.Connection} connection Active Oracle connection.
 * @returns {Promise<void>}
 */
exports.rollbacktrans = async (connection) => {
    if (!connection) throw new Error('Connection is required')
    // Resolved before the await below, so it reflects the app's actual
    // rollbacktrans() call site — see _trackStart's jsdoc.
    const caller = _getCaller()
    try {
        await connection.rollback()
        if (isDev) sqlLogConsole('↩️  Manual transaction rolled back')
    } catch (err) {
        errorConsole(`❌ Rollback error at ${caller}: ${err.message}`)
        throw err
    } finally {
        await connection.close().catch(ce => errorConsole(`Connection close error: ${ce.message}`))
    }
}

// ── MONITORING & DIAGNOSTICS ────────────────────────────────────────

/**
 * Get pool statistics if monitoring is enabled.
 * @param {string} [poolAlias='default']
 * @returns {Object} Pool statistics or status message.
 */
exports.getPoolStats = (poolAlias = 'default') => {
    const monitor = poolMonitors.get(poolAlias)
    return monitor ? monitor.getStats() : {
        monitoring: false,
        message: `Monitoring is disabled for pool: ${poolAlias}`
    }
}

/**
 * Get raw Oracle DB pool statistics directly from oracledb realtime
 * @param {string} [poolAlias='default']
 * @returns {oracledb.Statistics|null}
 */
exports.getPoolStatisticsRealtime = (poolAlias = 'default') => {
    try {
        const pool = oracledb.getPool(poolAlias)
        return pool ? pool.getStatistics() : null
    } catch (err) {
        return null
    }
}

/**
 * Yields every [queryId, info] entry across all per-alias sub-maps of a
 * two-level tracking store.
 * @param {Map<string, Map>} store
 */
function* _allEntries(store) {
    for (const map of store.values()) {
        yield* map
    }
}

/**
 * Get currently running queries that have exceeded a duration threshold —
 * a live view, recomputed from "now" on every call. Use this to see what's
 * holding connections right now, e.g. while a pool is full or after a
 * queue_timeout event fires, to find the culprit query yourself.
 * Requires ORACLE_QUERY_TRACKING=true; returns [] when disabled (default),
 * since there's nothing to compute "now" against without tracking on.
 * @param {number} [thresholdMs=60000] Minimum running duration in ms to be reported.
 * @returns {Array<{queryId: string, sql: string, param: string, poolAlias: string, caller: string, startedAt: string, elapsedMs: number}>}
 */
exports.getSlowQueries = (thresholdMs = 60000) => {
    const now = Date.now()
    const slow = []
    for (const [queryId, info] of _allEntries(activeQueriesByAlias)) {
        const elapsedMs = now - info.startTime
        if (elapsedMs >= thresholdMs) {
            slow.push({
                queryId,
                sql: info.sql,
                param: info.param,
                poolAlias: info.poolAlias,
                caller: info.caller,
                startedAt: new Date(info.startTime).toISOString(),
                elapsedMs
            })
        }
    }
    return slow.sort((a, b) => b.elapsedMs - a.elapsedMs)
}

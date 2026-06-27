const oracledb = require('oracledb')
const { queryBindToString } = require('bind-sql-string')
const { logConsole, errorConsole, sqlLogConsole } = require('@thesuhu/colorconsole')

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
            this.stats = {
                ...this.stats,
                totalConnections: pool.connectionsInUse + pool.connectionsOpen,
                busyConnections: pool.connectionsInUse,
                freeConnections: pool.connectionsOpen,
                queuedRequests: pool.queueLength || 0,
                lastCheck: new Date().toISOString(),
                poolStatus: 'healthy'
            }

            const usagePercent = (this.stats.busyConnections / Math.max(this.stats.totalConnections, 1)) * 100
            if (usagePercent > 80) {
                this.stats.poolStatus = 'warning'
                this.stats.warnings++
                if (this.stats.warnings % 10 === 1) {
                    logConsole(`⚠️  High pool usage: ${usagePercent.toFixed(1)}%`)
                }
            }

            if (this.stats.busyConnections >= this.stats.totalConnections && this.stats.totalConnections > 0) {
                this.stats.poolStatus = 'exhausted'
                errorConsole('🚨 Pool exhausted!')
            }
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
 * Logs the query and its parameters in dev mode.
 * @param {string} sql
 * @param {Object} param
 * @returns {string} Unique Query ID.
 */
const _logQuery = (sql, param) => {
    const queryId = Math.random().toString(16).slice(2, 6).toUpperCase()
    if (isDev) {
        sqlLogConsole(`[QID:${queryId}] ${queryBindToString(sql, param)}`)
    }
    return queryId
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
 * Initialize Oracle connection pool.
 * @param {oracledb.PoolAttributes} [customConfig] Optional custom configuration to override environment defaults.
 * @returns {Promise<void>}
 * @throws {Error} If configuration is missing or pool creation fails.
 */
exports.initialize = async (customConfig = {}) => {
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
        // Start built-in monitoring if enabled
        if (enableMonitoring) {
            const monitor = new BuiltInPoolMonitor(alias, monitoringInterval)
            monitor.start()
            poolMonitors.set(alias, monitor)
        }
    } catch (err) {
        errorConsole(`❌ Initialization failed at ${_getCaller()}: ${err.message}`)
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
                } catch (e) {
                    // Ignore if already closed
                }
            }
            activePools.clear()
            logConsole('🔌 All pools closed')
        }
    } catch (err) {
        errorConsole('Error closing pools: ' + err.message)
    }
}

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
    try {
        connection = await oracledb.getPool(poolAlias).getConnection()

        const qid = _logQuery(sql, param)

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
        errorConsole(`🔥 SQL Execution error at ${_getCaller()} [SQL: ${_shortSql(sql)}]: ${err.message}`)
        throw err
    } finally {
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
    try {
        connection = await oracledb.getPool(poolAlias).getConnection()
        const results = []

        const execOptions = {
            outFormat: oracledb.OBJECT,
            autoCommit: false,
            ...options
        }

        const txid = Math.random().toString(16).slice(2, 6).toUpperCase()
        const startTime = Date.now()
        for (let i = 0; i < queries.length; i++) {
            currentIndex = i
            const { query: sql, parameters: param = {} } = queries[i]
            if (!sql) throw new Error(`Query at index ${i} is missing 'query' field`)

            const qid = _logQuery(sql, param)
            const qStartTime = Date.now()

            const res = await connection.execute(sql, param, execOptions)

            _logTime(qStartTime, qid, `Query ${i} exec`)
            results.push({ queryid: i, results: res })
        }

        await connection.commit()
        _logTime(startTime, txid, 'Transaction total')
        return results
    } catch (err) {
        const failedQuery = (queries[currentIndex] && queries[currentIndex].query) ? queries[currentIndex].query : 'unknown'
        if (connection) await connection.rollback().catch(re => errorConsole(`Rollback failed: ${re.message}`))
        errorConsole(`💥 SQL Transaction error [Index: ${currentIndex}] at ${_getCaller()} [SQL: ${_shortSql(failedQuery)}]: ${err.message}`)
        throw err
    } finally {
        if (connection) await connection.close().catch(ce => errorConsole(`Connection close error: ${ce.message}`))
    }
}

/**
 * Start a manual transaction session.
 * @param {string} [poolAlias='default'] Pool alias to use.
 * @returns {Promise<oracledb.Connection>} Active Oracle connection for manual transaction.
 */
exports.begintrans = async (poolAlias = 'default') => {
    try {
        const connection = await oracledb.getPool(poolAlias).getConnection()
        if (isDev) sqlLogConsole('🔓 Manual transaction started')
        return connection
    } catch (err) {
        errorConsole(`❌ Error starting transaction at ${_getCaller()}: ${err.message}`)
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

    try {
        const qid = _logQuery(sql, param)
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
        errorConsole(`🔥 SQL Transaction exec error at ${_getCaller()} [SQL: ${_shortSql(sql)}]: ${err.message}`)
        throw err
    }
}

/**
 * Commit a manual transaction.
 * @param {oracledb.Connection} connection Active Oracle connection.
 * @returns {Promise<void>}
 */
exports.committrans = async (connection) => {
    if (!connection) throw new Error('Connection is required')
    try {
        await connection.commit()
        if (isDev) sqlLogConsole('💎 Manual transaction committed')
    } catch (err) {
        errorConsole(`❌ Commit error at ${_getCaller()}: ${err.message}`)
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
    try {
        await connection.rollback()
        if (isDev) sqlLogConsole('↩️  Manual transaction rolled back')
    } catch (err) {
        errorConsole(`❌ Rollback error at ${_getCaller()}: ${err.message}`)
        throw err
    } finally {
        await connection.close().catch(ce => errorConsole(`Connection close error: ${ce.message}`))
    }
}


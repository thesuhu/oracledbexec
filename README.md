# oracledbexec

[![npm](https://img.shields.io/npm/v/oracledbexec.svg?style=flat-square)](https://www.npmjs.com/package/oracledbexec)
[![license](https://img.shields.io/github/license/thesuhu/oracledbexec?style=flat-square)](https://github.com/thesuhu/oracledbexec/blob/master/LICENSE)

Running Oracle queries made easier.

## Install

```sh
npm install oracledbexec --save
```

## What's New in v2.0.0

Version `2.0.0` promotes `oracledbexec` to a production-ready release with a stronger runtime model, safer logging defaults, and better debugging support.

- **Async/Await Architecture**: the core execution flow now uses async/await consistently for cleaner non-blocking query handling.
- **Smart Threading**: `UV_THREADPOOL_SIZE` is automatically aligned with `POOL_MAX` at startup to reduce Oracle driver bottlenecks.
- **Multi-Pool Support**: multiple Oracle pools can be initialized and managed in parallel through pool aliases.
- **High Observability**: query logs include `QID`/`TXID` correlation IDs, caller tracing, and execution timing in development mode.
- **Safer Configuration**: numeric environment variables are validated with `safeParseInt` to avoid bad `0`, negative, or invalid values.
- **Guaranteed Cleanup**: connections are always closed in `finally` blocks, including failure paths.
- **Monitoring & Packaging**: built-in pool monitoring supports aliased pools, and the published package is limited to runtime files needed on npm.

## Environment Variables

This module reads environment variables for configuration. If environment variables are not found, default values will be used. You can also pass database configuration parameters when initializing the module.

### Database Configuration
* **ORA_USR**: the database user name. (required, no default)
* **ORA_PWD**: the password of the database user. (required, no default)
* **ORA_CONSTR**: connection string `<host>:<port>/<service name>`. (required, no default)

### Pool Configuration (Production Optimized)
* **POOL_MIN**: the minimum number of connections in the pool. (default: `2`)
* **POOL_MAX**: the maximum number of connections. (default: `8`)
* **POOL_INCREMENT**: connections opened when more are needed. (default: `1`)
* **POOL_ALIAS**: pool identifier for multiple pools. (default: `default`)
* **POOL_PING_INTERVAL**: connection health check interval in seconds. (default: `30`)
* **POOL_TIMEOUT**: idle connection timeout in seconds. (default: `120`)
* **POOL_CLOSING_TIME**: graceful pool shutdown wait time in seconds. (default: `0`)

### Queue Configuration
* **QUEUE_MAX**: maximum queued connection requests. (default: `50`)
* **QUEUE_TIMEOUT**: queue wait timeout in milliseconds. (default: `5000`)

### Client Configuration
* **THIN_MODE**: enable Oracle thin client mode. (default: `true`)
* **ORACLE_CLIENT_LIB_DIR**: path to Oracle Client libraries. (Optional, required only if `THIN_MODE=false`).

### Environment & Logging (New)
* **NODE_ENV**: set to `dev`, `devel`, or `development` to enable full SQL logs and execution timers. Any other value (for example `production`) disables verbose SQL logging and limits error output to short SQL snippets.
* **UV_THREADPOOL_SIZE**: automatically set by the library based on `POOL_MAX` (`POOL_MAX + 4`). In most cases you do not need to manage it manually.

### Built-in Monitoring (New Feature)
* **ORACLE_POOL_MONITORING**: enable automatic pool monitoring. (default: `false`)
* **ORACLE_MONITOR_INTERVAL**: monitoring check interval in milliseconds. (default: `30000`)

## Usage

### Basic Setup

Initialize database in `index.js/app.js` file to create connection pool:

```js
const oracledbexec = require('oracledbexec')

// Initialize with environment variables
await oracledbexec.initialize()
```

Or pass custom database configuration:

```js
const oracledbexec = require('oracledbexec')

let dbconfig = {
    user: 'hr',
    password: 'hr',
    connectString: 'localhost:1521/XEPDB1',
    poolMin: 2,        // Production optimized
    poolMax: 8,        // Production optimized
    poolIncrement: 1,  // Allow gradual scaling
    poolAlias: 'default',
    poolPingInterval: 30,
    poolTimeout: 120,
    queueMax: 50,
    queueTimeout: 5000,
}
await oracledbexec.initialize(dbconfig)
```

Initialize more than one pool:

```js
const oracledbexec = require('oracledbexec')

await oracledbexec.initialize({
    user: 'hr',
    password: 'hr',
    connectString: 'localhost:1521/XEPDB1',
    poolAlias: 'main'
})

await oracledbexec.initialize({
    user: 'reporting',
    password: 'secret',
    connectString: 'localhost:1521/XEPDB1',
    poolAlias: 'reporting'
})
```

### Built-in Pool Monitoring (New Feature)

Enable automatic pool monitoring by setting environment variable:
```bash
ORACLE_POOL_MONITORING=true
ORACLE_MONITOR_INTERVAL=30000  # Check every 30 seconds
```

Get pool statistics programmatically:
```js
const { getPoolStats } = require('oracledbexec')

// Get current pool status
const stats = getPoolStats()
console.log(stats)
/*
Output:
{
  totalConnections: 3,
  busyConnections: 1,
  freeConnections: 2,
  queuedRequests: 0,
  lastCheck: '2025-08-13T10:30:00.000Z',
  poolStatus: 'healthy', // 'healthy', 'warning', 'exhausted'
  warnings: 0,
  errors: []
}
*/

// Get monitoring stats for a specific pool alias
const reportingStats = getPoolStats('reporting')
```

### Single Query Execution

Execute single SQL statements with automatic connection management:

```js
const { oraexec } = require('oracledbexec')

try {
    let sql = `SELECT * FROM countries WHERE country_id = :country_id`
    let param = {country_id: 'JP'}
    let result = await oraexec(sql, param)
    console.log(result.rows)
} catch (err) {
    console.log(err.message)
}
```

Use specific pool:
```js
let result = await oraexec(sql, param, 'hrpool')
```

Advanced: Custom Execution Options

By default, the library uses the following settings if `options` is not provided:
*   `outFormat`: `oracledb.OBJECT` (Results are returned as objects instead of arrays).
*   `autoCommit`: `true` for `oraexec`, and `false` for transaction methods.

```js
// Example 1: Fetch a specific column as string and limit rows
const options = {
    fetchInfo: { "COMMISSION_PCT": { type: oracledb.STRING } },
    maxRows: 100
}
let result = await oraexec(sql, param, 'default', options)

// Example 2: Use ResultSet for large data sets
const rsOptions = { resultSet: true }
const rsResult = await oraexec(sql, param, 'default', rsOptions)
// Use rsResult.resultSet...

// Example 3: Disable auto-commit for single query
const manualOptions = { autoCommit: false }
const res = await oraexec(sql, param, 'default', manualOptions)
// Manual commit required via begintrans connection or other means
```

### Transaction Execution

For multiple SQL statements with automatic rollback on failure:

```js
const { oraexectrans } = require('oracledbexec')

try {
    let queries = []
    queries.push({
        query: `INSERT INTO countries VALUES (:country_id, :country_name)`,
        parameters: {country_id: 'ID', country_name: 'Indonesia'}
    })
    queries.push({
        query: `INSERT INTO countries VALUES (:country_id, :country_name)`,
        parameters: {country_id: 'JP', country_name: 'Japan'}
    })
    queries.push({
        query: `INSERT INTO countries VALUES (:country_id, :country_name)`,
        parameters: {country_id: 'CN', country_name: 'China'}
    })

    await oraexectrans(queries)
    console.log('All queries executed successfully')
} catch (err) {
    console.log('Transaction failed, all changes rolled back:', err.message)
}
```

Use specific pool:
```js
await oraexectrans(queries, 'hrpool')
```

### Manual Transaction Control

For complex transactions requiring intermediate processing:

**⚠️ Important**: Always close sessions to prevent connection leaks!

```js
const { begintrans, exectrans, committrans, rollbacktrans } = require('oracledbexec')

let session
try {
    // Start transaction session
    session = await begintrans()

    // Execute first query
    let sql = `SELECT country_name FROM countries WHERE country_id = :country_id`
    let param = {country_id: 'ID'}
    let result = await exectrans(session, sql, param)

    // Process result and execute second query
    sql = `INSERT INTO sometable VALUES (:name, :country_name)`
    param = {
        name: 'Some Name',
        country_name: result.rows[0].country_name
    }
    await exectrans(session, sql, param)

    // Commit transaction
    await committrans(session)
    console.log('Transaction committed successfully')

} catch (err) {
    // Rollback on error
    if (session) {
        await rollbacktrans(session)
    }
    console.log('Transaction rolled back:', err.message)
}
```

Use specific pool for transaction:
```js
let session = await begintrans('hrpool')
```

### Graceful Shutdown

Properly close connection pools when your application shuts down. You can close a specific pool by passing its alias, or leave it empty to close **all** active pools.

```js
const { close } = require('oracledbexec')

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...')
    try {
        // Close all active pools
        await close()

        // OR close a specific pool:
        // await close('hrpool')

        console.log('Database pools closed')
        process.exit(0)
    } catch (err) {
        console.error('Error closing pools:', err.message)
        process.exit(1)
    }
})
```

## Production Best Practices

### Recommended Environment Configuration

```bash
# Database connection
ORA_USR=your_username
ORA_PWD=your_password
ORA_CONSTR=host:port/service_name

# Production-optimized pool settings
POOL_MIN=2
POOL_MAX=8
POOL_INCREMENT=1
POOL_PING_INTERVAL=30
POOL_TIMEOUT=120

# Queue settings
QUEUE_MAX=50
QUEUE_TIMEOUT=5000
THIN_MODE=true # or false
ORACLE_CLIENT_LIB_DIR=/path/to/oracle_instant_client_home_dir # (Optional) Required only if THIN_MODE=false
ORACLE_POOL_MONITORING=true # or false
ORACLE_MONITOR_INTERVAL=30000

# Use thin client
THIN_MODE=true
```

### Error Handling & Observability (Improved)

All functions throw errors that should be caught. Version `2.0.0` adds advanced diagnostics:

- **Caller Tracing**: Error logs show exactly which file and line number in your application triggered the error.
- **Short SQL Snippets**: Error logs include a compact SQL preview to help identify the failing statement without printing long query text.
- **Correlation IDs**: Logs are tagged with `[QID:XXXX]` or `[TXID:XXXX]` to link SQL execution with its duration, even during high concurrency.
- **Execution Timing**: Dev mode displays per-query execution duration, and transaction mode logs both query-level and total transaction timing.

```js
try {
    const result = await oraexec('SELECT * FROM invalid_table')
} catch (error) {
    // Log will show: 🔥 SQL Execution error at user.controller.js:42 [SQL: SELECT * FROM...] : ORA-XXXXX
    console.error('Database error:', error.message)
}
```

### Connection Leak Prevention

The library automatically manages connections and prevents leaks:
- All connections are properly closed in `finally` blocks
- Failed connections are automatically cleaned up
- Pool monitoring alerts when connections are exhausted

## API Reference

### Functions

| Function | Description | Parameters | Returns |
|----------|-------------|------------|---------|
| `initialize(config?)` | Initialize connection pool | `config` (Optional) | `Promise<void>` |
| `close(alias?)` | Close specific or all pools | `alias` (Optional) | `Promise<void>` |
| `oraexec(sql, params?, alias?, options?)` | Execute single query | `sql`, `params`, `alias`, `options` | `Promise<result>` |
| `oraexectrans(queries, alias?, options?)` | Execute transaction | `queries`, `alias`, `options` | `Promise<results[]>` |
| `begintrans(alias?)` | Start manual transaction | `alias` (Optional) | `Promise<connection>` |
| `exectrans(conn, sql, params?, options?)` | Execute in transaction | `conn`, `sql`, `params`, `options` | `Promise<result>` |
| `committrans(connection)` | Commit transaction | `connection` | `Promise<void>` |
| `rollbacktrans(connection)` | Rollback transaction | `connection` | `Promise<void>` |
| `getPoolStats(alias?)` | Get custom pool stats | `alias` (Optional) | `Object` |
| `getPoolStatisticsRealtime(alias?)` | Get raw Oracle stats in realtime | `alias` (Optional) | `Object` |

### Behavior Notes

- `initialize(customConfig)` performs a shallow merge over environment-based defaults, so only provided keys override the base configuration.
- `oraexec(sql, params, alias, options)` is backward compatible and now accepts Oracle execution `options`.
- `oraexectrans(queries, alias, options)` also accepts execution `options`, while keeping `autoCommit: false`.
- `getPoolStats(alias?)` can inspect a specific pool alias and returns a friendly status object when monitoring is disabled.
- `close()` closes all active pools when no alias is provided.

### Built-in Monitoring

When `ORACLE_POOL_MONITORING=true`:
- Automatic health checks every 30 seconds by default.
- Customize frequency using `ORACLE_MONITOR_INTERVAL` (in milliseconds).
- Warnings when pool usage > 80% (logged every 10 checks to avoid spam).
- Alerts when pool is exhausted.
- Connection statistics tracking (Busy, Free, Queued).
- Error logging and history tracking (last 10 errors).
- Each initialized pool alias gets its own monitor instance.

## Testing

Version `2.0.0` includes a Jest-based test suite covering:

- single query execution
- custom execution options
- invalid SQL error handling
- transaction execution
- manual transaction lifecycle
- built-in pool stats
- realtime pool statistics access

Release verification for `v2.0.0` targets `7/7` passing tests, including decimal handling checks such as `.5` versus `0.5`, plus clean process exit after the suite finishes.

## Changelog

### Version 2.0.1
- ✅ **Bug Fixing**: `_logQuery` on `oraexectrans` always throw sql parameters errors

### Version 2.0.0 (Major Modernization)
- ✅ **Caller Source Tracing**: Implemented `_getCaller` to trace filename and line number in every error log.
- ✅ **Query Correlation (QID/TXID)**: Unique ID tagging on every log to distinguish parallel query executions.
- ✅ **Smart Execution Timers**: Automated duration unit conversion (ms/s) linked by Query ID.
- ✅ **Flexible Execution Options**: Added `options` parameter support for core functions (`oraexec`, `oraexectrans`, etc.).
- ✅ **Safer Error Logging**: Compact SQL snippets are used in error logs to avoid dumping long statements.
- ✅ **Multi-Pool Lifecycle**: Improved `close()` function to support closing all active pools simultaneously.
- ✅ **Thread Pool Optimization**: Relocated `UV_THREADPOOL_SIZE` for earlier engine initialization.
- ✅ **Configuration Hardening**: Numeric environment variables are validated with `safeParseInt`.
- ✅ **Guaranteed Cleanup**: Connection close paths are enforced across single-query and transaction flows.
- ✅ **Professional Testing**: Integrated Jest test suite for comprehensive coverage.

### Version 1.8.1 (Legacy)
- ✅ **Production-optimized defaults**: Conservative pool sizing (2-8 connections)
- ✅ **Built-in monitoring**: Optional automatic pool health monitoring
- ✅ **Enhanced error handling**: Guaranteed connection cleanup
- ✅ **Connection leak prevention**: Try-finally blocks ensure proper cleanup
- ✅ **Improved transaction management**: Better rollback and commit handling
- ✅ **Pool statistics API**: `getPoolStats()` function for monitoring
- ✅ **Configurable timeouts**: Reduced queue timeout to prevent hanging
- ✅ **Input validation**: Enhanced parameter validation
- ✅ **Graceful shutdown**: Proper pool closing with configurable wait time

That's all.

If you find this useful, please ⭐ the repository. Any feedback is welcome.

If you find this project helpful, feel free to [**Buy me a coffee! :coffee:**](https://saweria.co/thesuhu). I would be really thankful for your support, whether it's a coffee or just a kind comment, as it helps me a lot in maintaining this work.

## License

[MIT](https://github.com/thesuhu/oracledbexec/blob/master/LICENSE)

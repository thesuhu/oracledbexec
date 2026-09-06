# oracledbexec

[![npm](https://img.shields.io/npm/v/oracledbexec.svg?style=flat-square)](https://www.npmjs.com/package/oracledbexec)
[![license](https://img.shields.io/github/license/thesuhu/oracledbexec?style=flat-square)](https://github.com/thesuhu/oracledbexec/blob/master/LICENSE)

Running Oracle queries made easier.

## Install

```sh
npm install oracledbexec --save
```

## What's New in v2.1.0

Version `2.1.0` improves production diagnostics with live slow-query tracking, richer pool events, and more reliable caller attribution.

- **Live Slow-Query Tracking**: opt-in tracking through `ORACLE_QUERY_TRACKING=true` and `getSlowQueries(thresholdMs?)` exposes currently running queries.
- **Actionable Queue Timeouts**: `queue_timeout` events include a `heldBy` snapshot with query IDs, caller locations, SQL, and bind parameters.
- **Pool Event Callback**: `initialize(config?, onPoolEvent?)` reports pool lifecycle, health, recovery, and queue-timeout events.
- **Reliable Observability**: caller locations are captured before asynchronous work begins, and 8-character `QID`/`TXID` values reduce collisions.
- **Cross-Pool Isolation**: in-flight queries are tracked independently for each pool alias.
- **Fetch Conversion**: `setFetchAsString(types)` configures Oracle types such as CLOB/NCLOB to be returned as strings.
- **Monitoring Fixes**: pool usage statistics and manual-transaction attribution now reflect the correct pool and connection state.

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

### Slow Query Tracking (New Feature)
* **ORACLE_QUERY_TRACKING**: enable in-flight query tracking used by `getSlowQueries()`. (default: `false`)

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

### Fetch CLOB/NCLOB as String (New Feature)

By default, node-oracledb returns `CLOB`/`NCLOB` columns as Lob stream objects. Call `setFetchAsString()` once at startup, before running any queries, to have them come back as plain JS strings instead:

```js
const oracledbexec = require('oracledbexec')
const oracledb = require('oracledb')

oracledbexec.setFetchAsString([oracledb.CLOB, oracledb.NCLOB])
await oracledbexec.initialize()

const result = await oracledbexec.oraexec('SELECT description FROM articles WHERE id = :id', { id: 1 })
console.log(typeof result.rows[0].DESCRIPTION) // 'string'
```

- `CLOB` and `NCLOB` are **separate types** in node-oracledb — pass both explicitly if your schema uses both.
- This sets node-oracledb's global `fetchAsString`, so it applies to every query made through this library (this is why it's a one-time call, not a per-query option).
- Defined in code rather than an env var by design — the type list (`oracledb.CLOB`, `oracledb.NCLOB`, etc.) is only available from the `oracledb` module itself, and this keeps it explicit at your app's startup rather than implicit config.

### Pool Event Callback (New Feature)

Pass a callback as the 2nd argument to `initialize()` to react to pool health events in real time — no polling required.

```js
const oracledbexec = require('oracledbexec')
const { POOL_EVENTS } = oracledbexec // { HIGH_POOL_USAGE, POOL_EXHAUSTED, POOL_RECOVERED, QUEUE_TIMEOUT, POOL_INITIALIZED, POOL_CLOSED }

await oracledbexec.initialize({}, (event) => {
    console.log(event) // see exactly what's sent, per event type, below

    switch (event.event) {
        case POOL_EVENTS.POOL_INITIALIZED:
            console.log(`Pool ${event.poolAlias} ready`)
            break
        case POOL_EVENTS.HIGH_POOL_USAGE:
            console.warn(`Pool ${event.poolAlias} at ${event.usagePercent.toFixed(1)}%`)
            break
        case POOL_EVENTS.POOL_EXHAUSTED:
            console.error(`Pool ${event.poolAlias} exhausted`, event.stats)
            break
        case POOL_EVENTS.POOL_RECOVERED:
            console.log(`Pool ${event.poolAlias} back to healthy`)
            break
        case POOL_EVENTS.QUEUE_TIMEOUT:
            console.error(`Query stuck ${event.elapsedMs}ms in ${event.poolAlias}: ${event.sql} ${event.param} (${event.caller})`)
            if (event.heldBy.length) console.table(event.heldBy) // who's actually holding connections
            break
        case POOL_EVENTS.POOL_CLOSED:
            console.log(`Pool ${event.poolAlias} closed`)
            break
    }
})
```

`POOL_EVENTS` is exported so you never have to hardcode/typo the event name strings — `event.event` will always equal one of `POOL_EVENTS.HIGH_POOL_USAGE` (`'high_pool_usage'`), `POOL_EVENTS.POOL_EXHAUSTED` (`'pool_exhausted'`), `POOL_EVENTS.POOL_RECOVERED` (`'pool_recovered'`), `POOL_EVENTS.QUEUE_TIMEOUT` (`'queue_timeout'`), `POOL_EVENTS.POOL_INITIALIZED` (`'pool_initialized'`), or `POOL_EVENTS.POOL_CLOSED` (`'pool_closed'`).

There are 6 possible events, distinguished by `event.event`. Below is the **exact object your callback receives** for each case — real field names and real example values, not just a type shape — so you know what's safe to read.

#### `pool_initialized`

Fired once, right after the pool is created and ready to use — before any built-in monitoring starts. Always fires, regardless of `ORACLE_POOL_MONITORING`.

```js
// What your callback receives:
{
    event: 'pool_initialized',
    poolAlias: 'default',
    timestamp: '2026-08-12T10:30:00.000Z'
}
```

#### `high_pool_usage`

Fired from the periodic health check when pool usage crosses 80%. **Requires `ORACLE_POOL_MONITORING=true`** — never fires otherwise.

```js
// What your callback receives:
{
    event: 'high_pool_usage',
    poolAlias: 'default',
    usagePercent: 87.5,             // busyConnections / totalConnections * 100
    stats: {                        // same shape as getPoolStats()
        totalConnections: 8,
        busyConnections: 7,
        freeConnections: 1,
        queuedRequests: 0,
        lastCheck: '2026-08-12T10:30:00.000Z',
        poolStatus: 'warning',
        warnings: 3,
        errors: []
    },
    timestamp: '2026-08-12T10:30:00.000Z'
}
```

#### `pool_exhausted`

Fired from the same periodic health check when **all** connections are busy (`busyConnections >= totalConnections`). **Requires `ORACLE_POOL_MONITORING=true`**.

```js
// What your callback receives:
{
    event: 'pool_exhausted',
    poolAlias: 'default',
    stats: { /* same shape as getPoolStats(), poolStatus: 'exhausted' */ },
    timestamp: '2026-08-12T10:30:00.000Z'
}
```

#### `pool_recovered`

Fired from the same periodic health check on the **transition back to healthy** — the check right after a `high_pool_usage`/`pool_exhausted` state, once usage drops to ≤80% and the pool isn't exhausted anymore. Only fires once per recovery, not on every subsequent healthy check. **Requires `ORACLE_POOL_MONITORING=true`**.

```js
// What your callback receives:
{
    event: 'pool_recovered',
    poolAlias: 'default',
    stats: { /* same shape as getPoolStats(), poolStatus: 'healthy' */ },
    timestamp: '2026-08-12T10:30:00.000Z'
}
```

#### `queue_timeout`

Fired immediately when a request fails to get a connection — `NJS-040` (waited past `queueTimeout`) or `NJS-076` (pool's request queue is full, past `queueMax`). **Fires regardless of `ORACLE_POOL_MONITORING`** — this is a hard error on the request itself, not a periodic check.

```js
// What your callback receives:
{
    event: 'queue_timeout',
    poolAlias: 'default',
    sql: 'UPDATE orders SET status = :status WHERE order_id...',  // the request that failed to get a connection (truncated to 50 chars)
    param: '{"status":"SHIPPED","order_id":10245}',                // its bind parameters (JSON, truncated to 100 chars)
    caller: 'checkout.controller.js:117',                          // file:line of the code that issued it
    elapsedMs: 5023,                                                // how long it waited before failing
    heldBy: [                                                       // who's actually holding connections right now — the likely culprit(s).
        {                                                           // snapshot taken at the moment of failure, up to 5 entries, longest-running first.
            sql: 'BEGIN big_batch_job(:id); END;',                 // only populated when ORACLE_QUERY_TRACKING=true — otherwise []
            param: '{"id":99}',
            caller: 'batch.controller.js:88',
            elapsedMs: 45210
        }
    ],
    timestamp: '2026-08-12T10:30:00.000Z'
}
```

#### `pool_closed`

Fired once a pool finishes closing — via `close(alias)` or `close()` (all pools). The callback is invoked *before* it's unregistered, so this is your last chance to see it for that alias.

```js
// What your callback receives:
{
    event: 'pool_closed',
    poolAlias: 'default',
    timestamp: '2026-08-12T10:30:00.000Z'
}
```

**Notes:**
- Callback errors are caught internally and logged — they never crash query execution or monitoring.
- One callback per pool alias (registered per `initialize()` call); re-initializing the same alias replaces it.
- `heldBy` is your fastest way to find the actual offending query and params in your source code without a separate lookup — it's captured and delivered the instant the timeout fires.

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

### Slow Query Tracking (New Feature)

`getSlowQueries(thresholdMs?)` — a **live** view of what's holding connections right now, e.g. while a pool is full. Recomputed from the current time on every call.

Disabled by default — enable it explicitly:
```bash
ORACLE_QUERY_TRACKING=true
```

```js
const { getSlowQueries } = require('oracledbexec')

// Queries still running past 60 seconds (default threshold)
const stuck = getSlowQueries()

// Or a custom threshold, in milliseconds
const stuckOver10s = getSlowQueries(10000)

console.log(stuck)
/*
Output:
[
  {
    queryId: 'A1B2C3D4',
    sql: 'SELECT * FROM orders WHERE status = :status...',
    param: '{"status":"PENDING"}',
    poolAlias: 'default',
    caller: 'orders.controller.js:42',
    startedAt: '2026-08-06T10:30:00.000Z',
    elapsedMs: 45210          // grows every call — this query is still running right now
  }
]
*/
```

**Field reference:**

| Field | Meaning |
|-------|---------|
| `queryId` | Short random ID for the entry (matches `[QID:...]` in dev logs). |
| `sql` | First 50 chars of the SQL/PL-SQL text. |
| `param` | Bind parameters as JSON, truncated to 100 chars — lets you reproduce the exact query. |
| `poolAlias` | Which pool the query is running against. |
| `caller` | `file:line` of the code that issued the call, when it could be resolved (best-effort — falls back to `'unknown'`). |
| `startedAt` | ISO timestamp the query started. |
| `elapsedMs` | How long it's been running, computed fresh as of this call — keeps growing on each subsequent call until the query finishes. |

Returns `[]` when `ORACLE_QUERY_TRACKING` is not enabled (no tracking overhead by default) — there's nothing to report without in-flight tracking on. For **why a `queue_timeout` (`NJS-040`/`NJS-076`) failure isn't a `getSlowQueries()` entry** — it's a request that already died trying to get a connection, not something "still running" — see the `heldBy` field on the [pool event callback](#pool-event-callback-new-feature)'s `queue_timeout` event, which is the culprit snapshot taken at the moment of failure.

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

All functions throw errors that should be caught. Version `2.1.0` includes advanced diagnostics:

- **Caller Tracing**: Error logs show exactly which file and line number in your application triggered the error.
- **Short SQL Snippets**: Error logs include a compact SQL preview to help identify the failing statement without printing long query text.
- **Correlation IDs**: Logs are tagged with `[QID:XXXXXXXX]` or `[TXID:XXXXXXXX]` (8 hex chars) to link SQL execution with its duration, even during high concurrency.
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
| `initialize(config?, onPoolEvent?)` | Initialize connection pool | `config` (Optional), `onPoolEvent` (Optional callback) | `Promise<void>` |
| `setFetchAsString(types)` | Auto-convert given Oracle DB types (e.g. CLOB/NCLOB) to JS strings on fetch | `types` (Array of `oracledb.DbType`) | `void` |
| `close(alias?)` | Close specific or all pools | `alias` (Optional) | `Promise<void>` |
| `oraexec(sql, params?, alias?, options?)` | Execute single query | `sql`, `params`, `alias`, `options` | `Promise<result>` |
| `oraexectrans(queries, alias?, options?)` | Execute transaction | `queries`, `alias`, `options` | `Promise<results[]>` |
| `begintrans(alias?)` | Start manual transaction | `alias` (Optional) | `Promise<connection>` |
| `exectrans(conn, sql, params?, options?)` | Execute in transaction | `conn`, `sql`, `params`, `options` | `Promise<result>` |
| `committrans(connection)` | Commit transaction | `connection` | `Promise<void>` |
| `rollbacktrans(connection)` | Rollback transaction | `connection` | `Promise<void>` |
| `getPoolStats(alias?)` | Get custom pool stats | `alias` (Optional) | `Object` |
| `getPoolStatisticsRealtime(alias?)` | Get raw Oracle stats in realtime | `alias` (Optional) | `Object` |
| `getSlowQueries(thresholdMs?)` | Live: queries still running past threshold | `thresholdMs` (Optional, default `60000`) | `Array<Object>` |
| `POOL_EVENTS` | Constant object of pool event names — not a function, an export | — | `{ HIGH_POOL_USAGE, POOL_EXHAUSTED, POOL_RECOVERED, QUEUE_TIMEOUT, POOL_INITIALIZED, POOL_CLOSED }` |

### Behavior Notes

- `initialize(customConfig)` performs a shallow merge over environment-based defaults, so only provided keys override the base configuration.
- `oraexec(sql, params, alias, options)` is backward compatible and now accepts Oracle execution `options`.
- `oraexectrans(queries, alias, options)` also accepts execution `options`, while keeping `autoCommit: false`.
- `getPoolStats(alias?)` can inspect a specific pool alias and returns a friendly status object when monitoring is disabled.
- `close()` closes all active pools when no alias is provided.
- `getSlowQueries(thresholdMs?)` returns `[]` when `ORACLE_QUERY_TRACKING` is not enabled (no tracking overhead by default) — it only reports currently-running queries, so there's nothing to report without tracking on.

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

Version `2.1.0` includes a Jest-based test suite covering:

- single query execution
- custom execution options
- invalid SQL error handling
- transaction execution
- manual transaction lifecycle
- built-in pool stats
- realtime pool statistics access
- in-flight slow query tracking and cleanup
- `NJS-040` queue timeout with `heldBy` culprit snapshot and pool event callback

Release verification for `v2.1.0` targets all 16 tests passing, plus a clean process exit after the suite finishes.

## Changelog

### Version 2.1.0
- ✅ **Slow Query Tracking**: new `getSlowQueries(thresholdMs?)` — a **live** view of in-flight queries running longer than threshold (default `60000`ms), recomputed from "now" on every call. Opt-in via `ORACLE_QUERY_TRACKING=true`, disabled by default (returns `[]`).
- ✅ **`heldBy` Culprit Snapshot on `queue_timeout`**: the pool event callback's `queue_timeout` event carries `heldBy` — a snapshot of up to 5 queries actually holding connections at the moment of failure, delivered in real time so you can find the offending code without a separate lookup. Populated only when `ORACLE_QUERY_TRACKING` was on at the time. There's no separate pull/history API for past incidents — `getSlowQueries()` is the only tracking query surface, and it's intentionally live-only.
- ✅ **Bind Parameters Tracked**: every `getSlowQueries()` entry (and each `heldBy` culprit) carries `param` — its bind parameters as JSON, truncated to 100 chars — so a stuck query can be reproduced, not just located.
- ✅ **One Query ID End-to-End**: the same QID is now used for a request's dev-mode SQL log and its `getSlowQueries()` entry — generated once, up front, before the request even attempts to get a connection.
- ✅ **Pool Event Callback**: `initialize(config?, onPoolEvent?)` accepts an optional callback fired on `pool_initialized` (once, right after the pool is ready), `high_pool_usage`/`pool_exhausted`/`pool_recovered` (all require `ORACLE_POOL_MONITORING=true` — `pool_recovered` fires once on the transition back to healthy), `queue_timeout` (`NJS-040`/`NJS-076`, always fires), and `pool_closed` (once the pool finishes closing). Exported `POOL_EVENTS` constant (`{ HIGH_POOL_USAGE, POOL_EXHAUSTED, POOL_RECOVERED, QUEUE_TIMEOUT, POOL_INITIALIZED, POOL_CLOSED }`) avoids hardcoding the event name strings.
- ✅ **Longer Correlation IDs**: `QID`/`TXID`/`queryId` widened from 4 to 8 hex chars (~4 billion combinations) — at the 4-char size, collisions became statistically likely once concurrent tracked queries approached the hundreds, which could silently overwrite a tracked entry and corrupt tracking results.
- ✅ **`setFetchAsString(types)`**: auto-convert given Oracle DB types (e.g. `oracledb.CLOB`/`oracledb.NCLOB`) to plain JS strings on fetch. A one-time call at startup — code-defined (not an env var) since it needs the actual `oracledb` type constants.
- 🐛 **Bug Fix — Wrong Pool Usage Stats**: `totalConnections`/`freeConnections` used `pool.connectionsOpen` as if it were the idle-connection count, but it's already the pool's *total* open connections (busy + idle) — this double-counted busy connections and understated `usagePercent`, making `pool_exhausted`/`high_pool_usage` events nearly impossible to trigger correctly. Fixed.
- 🐛 **Bug Fix — `heldBy` Blind to Manual Transactions**: `exectrans()` tracked queries under the literal pool alias `'manual-transaction'` instead of the connection's real pool, so a long-running manual-transaction query never showed up as a `heldBy` culprit for a `queue_timeout` on its actual pool. `begintrans()` now tags the connection with its real pool alias so tracking is correct.
- 🐛 **Bug Fix — Cross-Pool Tracking Eviction**: in-flight query tracking was a single global map shared across all pool aliases under one combined 1000-entry cap, so a busy pool's traffic could evict another pool's legitimately tracked entries. Now keyed per pool alias, each with its own independent 1000-entry cap.
- 🐛 **Bug Fix — `oraexectrans()` Misattributed Commit Failures**: if `connection.commit()` itself failed (all queries having already succeeded), the error log wrongly blamed the last executed query (`[Index: N] [SQL: ...]`) instead of the commit step. Commit failures now log distinctly as a commit error.
- 🐛 **Bug Fix — Unreliable `caller`**: `caller` (in `getSlowQueries()` entries, `queue_timeout`'s `heldBy`, and error logs) was resolved from the call stack at the point tracking/logging actually happened — for every function that awaits anything before its catch block (`oraexec`, `oraexectrans`, `begintrans`, `exectrans`, `initialize`, `committrans`, `rollbacktrans`), that's after at least one `await`, where V8 doesn't reliably preserve the original stack, so it often came back `'unknown'` or pointed at the wrong frame. It's now resolved once, synchronously, at the very top of each function — before any `await` — and reused everywhere within that call. For `oraexectrans()` specifically, every query in the transaction now reports the same `caller`: the line that called `oraexectrans(...)`, not wherever inside the library's internal loop the stack happened to still be intact.
- ℹ️ **Note — `oraexectrans()` Tracking Is Per-Query Only**: `getSlowQueries()`/`heldBy` reflect actual query execution time, not the whole transaction — time spent in `connection.commit()` or between queries on the same connection is not tracked. This is intentional: tracking a synthetic transaction-wide entry was considered but dropped for being confusing (it showed up as an extra, oddly-labeled entry alongside the real slow query) — see `example/slow-query-in-transaction.js`.

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

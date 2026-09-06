# Changelog

## Version 2.1.0 (August 2026) - Slow Query Tracking

### 🚀 New Feature

#### Slow Query Tracking
- ✅ **`getSlowQueries(thresholdMs)`** - a **live** view: lists currently running queries stuck longer than threshold (default 60000ms), recomputed from "now" on every call
- ✅ **Opt-in via `ORACLE_QUERY_TRACKING=true`** - disabled by default, zero overhead when off (`getSlowQueries()` returns `[]`)
- ✅ **Bind parameters tracked (`param`)** - every entry carries its bind parameters (JSON, truncated to 100 chars) so a stuck query can be reproduced, not just identified
- ✅ **Capped at 1000 entries per pool alias** - oldest evicted first (Map insertion order), bounds memory use without one busy pool evicting another pool's tracked entries
- ✅ Tracks SQL snippet, bind parameters, pool alias, caller (`file:line`), start time, elapsed ms
- ✅ Works across `oraexec`, `oraexectrans`, `begintrans`, `exectrans`
- ✅ **One query ID end-to-end** - the QID generated for a request (before it even attempts to get a connection) is the same one used in dev-mode SQL logs and its `getSlowQueries()` entry — no more mismatched IDs between what you see in logs and what tracking reports
- ✅ **8-char correlation IDs** - `QID`/`TXID`/`queryId` widened from 4 to 8 hex chars (~4 billion combinations) to keep ID collisions negligible even at `MAX_TRACKED_QUERIES` (1000) concurrent entries
- ✅ No separate pull/history API for past `NJS-040`/`NJS-076` incidents by design — an incident already happened and is over, so it doesn't belong in a live view; see the `queue_timeout` pool event below instead

#### Pool Event Callback
- ✅ **`initialize(config?, onPoolEvent?)`** - optional 2nd param callback fired on pool events
- ✅ Events: `pool_initialized` (fires once, right after the pool is ready), `high_pool_usage` (>80%), `pool_exhausted`, `pool_recovered` (fires once on the transition back to healthy — all three require `ORACLE_POOL_MONITORING=true`), `queue_timeout` (`NJS-040`/`NJS-076`, always fires regardless of monitoring), `pool_closed` (fires once, when the pool finishes closing)
- ✅ **`POOL_EVENTS` constant** - exported `{ HIGH_POOL_USAGE, POOL_EXHAUSTED, POOL_RECOVERED, QUEUE_TIMEOUT, POOL_INITIALIZED, POOL_CLOSED }` so event names never need to be hardcoded/typo'd in a `switch`/`if`
- ✅ **`heldBy` culprit snapshot** - the `queue_timeout` event carries `heldBy`, up to 5 queries (each with `sql`, `param`, `caller`, `elapsedMs`) that were actually holding connections at the moment of failure, longest-running first — taken and delivered immediately, in real time, so it isn't lost if the culprit finishes before you get a chance to look. Only populated when `ORACLE_QUERY_TRACKING` was on at the time
- ✅ Callback errors are caught internally and logged, never break execution/monitoring

```javascript
// Enable via env
// ORACLE_QUERY_TRACKING=true

const running = oracledbexec.getSlowQueries(60000)
// [{ queryId, sql, param, poolAlias, caller, startedAt, elapsedMs }, ...] — live, recomputed every call

await oracledbexec.initialize({}, (event) => {
    if (event.event === oracledbexec.POOL_EVENTS.QUEUE_TIMEOUT) {
        console.log(event.heldBy) // [{ sql, param, caller, elapsedMs }, ...] — real-time culprit snapshot
    }
})
```

#### Fetch CLOB/NCLOB as String
- ✅ **`setFetchAsString(types)`** - auto-convert given Oracle DB types (e.g. `oracledb.CLOB`, `oracledb.NCLOB` — separate types, pass both if needed) to plain JS strings on fetch, instead of Lob stream objects
- ✅ Code-defined, not an env var — call once at startup, before running queries; needs the actual `oracledb` type constants
- ✅ Sets node-oracledb's global `fetchAsString` directly on the same `oracledb` instance this library uses internally, so it's unaffected by whether the app's own `oracledb` dependency gets deduped to the same singleton or not

```javascript
const oracledb = require('oracledb')
oracledbexec.setFetchAsString([oracledb.CLOB, oracledb.NCLOB])
await oracledbexec.initialize()
```

### 🐛 Bug Fixes
- ✅ **Wrong pool usage stats**: `getPoolStats()`/`getPoolStatisticsRealtime()` health checks used `pool.connectionsInUse + pool.connectionsOpen` for `totalConnections` and `pool.connectionsOpen` for `freeConnections` — but `connectionsOpen` is already the pool's *total* physically-open connections (busy + idle), not just idle ones. This double-counted busy connections in `totalConnections` and mislabeled the total as `freeConnections`, understating `usagePercent` and making `pool_exhausted`/`high_pool_usage` events nearly impossible to trigger correctly. Fixed to `totalConnections: pool.connectionsOpen` and `freeConnections: pool.connectionsOpen - pool.connectionsInUse`.
- ✅ **`heldBy` blind to manual transactions**: `exectrans()` tracked every query under the literal pool alias `'manual-transaction'` instead of the connection's real pool, so `heldBy` snapshots never matched a long-running manual-transaction query as the culprit behind a `queue_timeout` on its actual pool. `begintrans()` now tags the connection with its real pool alias so `exectrans()` tracks against it correctly.
- ✅ **Cross-pool tracking eviction**: in-flight query tracking was a single global map shared across all pool aliases under one combined 1000-entry cap, so a busy pool's traffic could evict another pool's legitimately tracked entries. Now keyed per pool alias, each with its own independent 1000-entry cap.
- ✅ **`oraexectrans()` misattributed commit failures**: if `connection.commit()` itself failed (all queries having already succeeded), the error log wrongly blamed the last executed query instead of the commit step. Commit failures now log distinctly.
- ✅ **Unreliable `caller`**: `caller` used to be resolved from the call stack after at least one `await` (inside the tracking/error-handling code itself), where V8 doesn't reliably preserve the original stack — often `'unknown'` or the wrong frame. Now resolved once, synchronously, at the top of every function that has one (`oraexec`, `oraexectrans`, `begintrans`, `exectrans`, `initialize`, `committrans`, `rollbacktrans`), before any `await`, and reused throughout. `oraexectrans()` queries all now report the same `caller` — the line that called `oraexectrans(...)` — instead of an unreliable per-query resolution deep in the loop.
- ℹ️ **Note: `oraexectrans()` tracking is per-query only, by design**: `getSlowQueries()` reflects actual query execution time, not the whole transaction — time in `connection.commit()` or between queries isn't tracked. A transaction-wide entry was tried and dropped for being confusing (an extra entry alongside the actual slow query, both showing similar durations).
- ✅ **`getSlowQueries()` no longer mixes live and past-incident data**: `NJS-040`/`NJS-076` queue-timeout incidents used to be merged into `getSlowQueries()` with a `queueTimeout: true` flag and a permanent log, but that function is meant to be purely a *live* view recomputed on every call — an incident already happened and is over, so its data shouldn't be conflated with "still running now". Queue-timeout info is now delivered only through the `queue_timeout` pool event's `heldBy`, in real time; there's no separate pull/history API for it.

---

## Version 1.8.1+ (August 2025) - Production Optimization Release

### 🚀 Major Features

#### Built-in Pool Monitoring
- ✅ **Automatic pool health monitoring** with configurable intervals
- ✅ **Real-time statistics** via `getPoolStats()` API
- ✅ **Smart alerting** with warnings at >80% usage and exhaustion alerts
- ✅ **Zero-configuration setup** - just set `ORACLE_POOL_MONITORING=true`
- ✅ **Console logging** with emoji indicators for easy monitoring
- ✅ **Error tracking** with history (last 10 errors kept)

#### Production-Optimized Defaults
- ✅ **Conservative pool sizing**: Default 2-8 connections (was 10-10)
- ✅ **Flexible scaling**: `poolIncrement=1` for gradual growth
- ✅ **Faster health checks**: `poolPingInterval=30s` (was 60s)
- ✅ **Shorter timeouts**: `poolTimeout=120s`, `queueTimeout=5s`
- ✅ **Smaller queue**: `queueMax=50` to prevent overload

### 🔧 Technical Improvements

#### Connection Management
- ✅ **Guaranteed connection cleanup** with try-finally blocks
- ✅ **Connection leak prevention** in all error scenarios
- ✅ **Enhanced error handling** with proper rollback in transactions
- ✅ **Input validation** for all function parameters
- ✅ **Async/await consistency** throughout the library

#### Security & Configuration
- ✅ **Removed default credentials** - now requires environment variables
- ✅ **Environment-first configuration** - reads from process.env by default
- ✅ **Graceful shutdown support** with configurable wait times
- ✅ **Thread pool optimization** - automatically sized based on pool settings

### 📊 API Enhancements

#### New Functions
- ✅ **`getPoolStats()`** - Get real-time pool statistics
- ✅ **Enhanced `initialize()`** - Better error handling and validation
- ✅ **Improved transaction functions** - Better cleanup and error handling

#### Better Error Messages
- ✅ **Detailed error context** in all functions
- ✅ **Troubleshooting hints** for common issues
- ✅ **Consistent error format** across all functions

### 🎯 Bug Fixes

#### Pool Exhaustion Issues
- ✅ **Fixed connection leaks** that caused pool exhaustion
- ✅ **Proper cleanup** in error scenarios
- ✅ **Race condition fixes** in connection management
- ✅ **Memory leak prevention** in monitoring and error tracking

#### Transaction Handling
- ✅ **Guaranteed rollback** on transaction failures
- ✅ **Session cleanup** in manual transaction control
- ✅ **Better error propagation** in transaction chains

### 📚 Documentation

#### Comprehensive Guides
- ✅ **Updated README.md** with all new features
- ✅ **Implementation Guide** for developers
- ✅ **Built-in Monitoring documentation**
- ✅ **Production best practices**
- ✅ **Troubleshooting guide**

#### Code Examples
- ✅ **Health check endpoints** implementation
- ✅ **Monitoring setup** examples
- ✅ **Error handling** patterns
- ✅ **Production deployment** guides

### ⚙️ Environment Variables

#### New Variables
```bash
# Monitoring
ORACLE_POOL_MONITORING=true/false
ORACLE_MONITOR_INTERVAL=30000

# Pool optimization
POOL_MIN=2
POOL_MAX=8
POOL_INCREMENT=1
POOL_TIMEOUT=120
QUEUE_TIMEOUT=5000

# Graceful shutdown
POOL_CLOSING_TIME=0
```

#### Removed Defaults
- ❌ **No more hardcoded credentials** (hr/hr/localhost)
- ❌ **No more fallback connection strings**
- ✅ **Requires explicit configuration** for security

### 🔄 Breaking Changes

#### Configuration
- **Environment variables now required** for database connection
- **Default pool size changed** from 10-10 to 2-8
- **Timeout values reduced** for better production behavior

#### Function Signatures
- **All functions maintain backward compatibility**
- **New optional parameters** don't break existing code
- **Enhanced error handling** may reveal previously hidden issues

### 📈 Performance Improvements

#### Pool Management
- ✅ **Reduced memory usage** with optimized pool sizing
- ✅ **Faster connection establishment** with better defaults
- ✅ **Lower latency** with reduced timeouts
- ✅ **Better resource utilization** with monitoring insights

#### Monitoring Overhead
- ✅ **Minimal performance impact** (~1-2ms per monitoring check)
- ✅ **Configurable intervals** to balance monitoring vs performance
- ✅ **Efficient statistics collection** with caching

### 🚚 Migration Guide

#### From v1.8.0 and earlier

1. **Update environment variables**:
   ```bash
   # Add required variables
   ORA_USR=your_username
   ORA_PWD=your_password
   ORA_CONSTR=your_connection_string
   
   # Optional: Enable monitoring
   ORACLE_POOL_MONITORING=true
   ```

2. **Remove external monitoring** (if using):
   ```bash
   rm pool-monitor.js pool-stats-route.js
   ```

3. **Update application code**:
   ```javascript
   // Old: Custom configuration object
   oracledbexec.initialize(customConfig)
   
   // New: Environment-based (recommended)
   oracledbexec.initialize()
   
   // Or still use custom config
   oracledbexec.initialize(customConfig)
   ```

4. **Add health endpoints** (recommended):
   ```javascript
   app.get('/api/pool-stats', (req, res) => {
       const stats = oracledbexec.getPoolStats()
       res.json({ success: true, poolStats: stats })
   })
   ```

### 🎯 Production Readiness

#### Validated In Production
- ✅ **Pool exhaustion fixes** tested under load
- ✅ **Connection leak prevention** verified
- ✅ **Monitoring accuracy** confirmed
- ✅ **Graceful shutdown** tested in various scenarios

#### Recommended Settings
```bash
# Production environment
NODE_ENV=production
ORACLE_POOL_MONITORING=true
POOL_MIN=2
POOL_MAX=8
POOL_INCREMENT=1
POOL_PING_INTERVAL=30
POOL_TIMEOUT=120
QUEUE_MAX=50
QUEUE_TIMEOUT=5000
```

### 🙏 Acknowledgments

- **Fixed pool exhaustion issues** that required periodic application restarts
- **Improved monitoring** from external scripts to built-in solution
- **Enhanced production reliability** with better error handling
- **Simplified deployment** with environment-first configuration

---

**Release Date**: August 13, 2025
**Compatibility**: Node.js 14+ with Oracle Database 12c+
**Testing**: Validated with Oracle 19c on production workloads

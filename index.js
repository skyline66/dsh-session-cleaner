/**
 * Session Cleaner — Host half.
 *
 * The DeepSeek Harness session log is append-only by design and no public
 * Host service deletes sessions. This plugin fills that gap through the one
 * sanctioned seam: the JSONL persistence backend keeps each session under
 * `<dsh-home>/sessions/<project-dir>/<session-id>/`, and the workspace
 * registry filters log-less session ids out of its tables on read.
 *
 * Deletion therefore runs as:
 *   1. `workspaceRegistry.archiveSession(id, { stopActivity: true })` — stops
 *      any running turn / job / subagent / reminder through the composed
 *      activity providers and marks the session archived, so the UI hides it
 *      immediately and every wake path is gated before the log disappears.
 *   2. Remove the session's own log directory (after a strict "does this
 *      really look like a session log" check) and its projection-cache record.
 *   3. `workspaceRegistry.unarchiveSession(id)` — drops the archive marker so
 *      no stale id remains in the durable archived set.
 *
 * The Client half reaches this half through same-origin POSTs to
 * `/session-cleaner/api/*`, admitted only through
 * `ctx.connection.requestRejection()` like every other trusted browser peer.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const LOG_FILE_RE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/i
const API_PREFIX = '/session-cleaner/api'

class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, limit = 1024 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ApiError(413, 'payload-too-large', 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ApiError(400, 'bad-json', 'request body is not valid JSON')
  }
}

/** Accept `xxxxxxxx-…` or `session-xxxxxxxx-…`; return the full stored id. */function normalizeSessionId(raw) {
  const value = String(raw ?? '').trim()
  const bare = value.replace(/^session-/i, '').toLowerCase()
  if (!SESSION_ID_RE.test(bare)) {
    throw new ApiError(400, 'bad-session-id', 'sessionId must be a UUID (with or without the "session-" prefix)')
  }
  return `session-${bare}`
}

export const inject = ['webServer', 'connection']

export function apply(ctx, config) {
  const root = path.resolve(String(config?.root || path.join(os.homedir(), '.dsh', 'sessions')))
  const dshHome = path.dirname(root)
  const projCacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  const auditDir = path.join(dshHome, 'storages', 'session-cleaner')
  const auditFile = path.join(auditDir, 'audit.log')

  const log = (...parts) => ctx.logger.info(['[session-cleaner]', ...parts].join(' '))

  /** Append one JSONL audit record; audit failures never fail the operation. */
  async function audit(record) {
    try {
      await fs.mkdir(auditDir, { recursive: true })
      await fs.appendFile(auditFile, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`, 'utf8')
    } catch {
      // best effort
    }
  }

  async function describeSession(query, fullId) {
    try {
      const snapshot = await query.readSession(fullId)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      return {
        eventCount: events.length,
        firstSeq: events[0]?.seq,
        lastSeq: events[events.length - 1]?.seq,
        headTypes: events.slice(0, 4).map(event => event?.type),
        tailTypes: events.slice(-4).map(event => event?.type),
      }
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  /** Locate `<root>/<project-dir>/<sessionId>` without trusting the id as a path segment. */
  async function findSessionDir(fullId) {
    let projectDirs
    try {
      projectDirs = await fs.readdir(root, { withFileTypes: true })
    } catch (error) {
      throw new ApiError(500, 'root-unreadable', `session root "${root}" is not readable: ${error?.message ?? error}`)
    }
    for (const project of projectDirs) {
      if (!project.isDirectory()) continue
      const candidate = path.resolve(root, project.name, fullId)
      if (!candidate.startsWith(root + path.sep)) continue
      const stat = await fs.stat(candidate).then(s => s, () => undefined)
      if (stat?.isDirectory()) return candidate
    }
    return undefined
  }

  /** Guard against removing a directory that is not a session log. */
  async function looksLikeSessionLog(dir) {
    const names = await fs.readdir(dir).catch(() => [])
    return names.some(name => LOG_FILE_RE.test(name))
  }

  async function removeSessionArtifacts(fullId) {
    const dir = await findSessionDir(fullId)
    let removedLog = false
    if (dir !== undefined) {
      if (!(await looksLikeSessionLog(dir))) {
        throw new ApiError(409, 'not-a-session-dir', `refusing to delete "${dir}": no session log found inside`)
      }
      await fs.rm(dir, { recursive: true, force: false })
      removedLog = true
    }
    let removedCache = false
    const cacheFile = path.join(projCacheDir, `${fullId}.json`)
    try {
      await fs.rm(cacheFile, { force: true })
      removedCache = true
    } catch {
      // best effort
    }
    return { sessionDir: dir, removedLog, removedCache }
  }

  /**
   * Stop any running work and hide the session before its log disappears.
   * Returns the registry (or undefined when the workspace feature is absent).
   */
  async function stopAndDetach(fullId) {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.archiveSession === 'function') {
      try {
        await registry.archiveSession(fullId, { stopActivity: true })
      } catch (error) {
        // A session that no longer exists anywhere is fine to continue past;
        // anything else is fatal and must not delete data behind an error.
        const text = String(error?.message ?? error)
        if (!/not\s+(found|live|persisted)|unknown\s+session|enoent/i.test(text)) throw error
      }
      return registry
    }
    const agents = ctx.get('agents')
    if (agents !== undefined && typeof agents.get === 'function' && agents.get(fullId) !== undefined) {
      throw new ApiError(409, 'session-live', '该会话仍在运行中，请先停止会话内的活动再删除 (the session is still live; stop its activity first)')
    }
    return undefined
  }

  /** Drop the archive marker so no stale id stays in the durable archived set. */
  async function detachArchiveMarker(registry, fullId) {
    if (registry !== undefined && typeof registry.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(fullId)
      } catch {
        // best effort
      }
    }
  }

  async function deleteSession(payload) {
    const fullId = normalizeSessionId(payload?.sessionId)
    const registry = await stopAndDetach(fullId)
    const artifacts = await removeSessionArtifacts(fullId)
    await detachArchiveMarker(registry, fullId)
    log(
      'deleted session',
      fullId,
      artifacts.removedLog ? `(log: ${artifacts.sessionDir})` : '(log already absent)',
      artifacts.removedCache ? '(projection cache removed)' : '',
    )
    await audit({ action: 'delete', sessionId: fullId, ...artifacts })
    return { ok: true, ...artifacts }
  }

  /**
   * Fork the session's prefix at `atSeq` into a same-titled continuation and
   * delete the original. The Client half performs the fork through its typed
   * `ctx.sessions.fork({ sessionId, atSeq, increaseTitle: false })` face and
   * then calls this method with the source id; this handler expects the fork
   * to already exist and only deletes the original.
   */
  async function deleteAfterFork(payload) {
    const fullId = normalizeSessionId(payload?.sessionId)
    const query = ctx.get('sessionQuery')
    const childId = typeof payload?.childId === 'string' ? payload.childId : undefined
    const sourceBefore = query ? await describeSession(query, fullId) : undefined
    const childBefore = query && childId ? await describeSession(query, childId) : undefined
    // Safety guard: the fork must actually have cut the log. If the child still
    // reaches the source's last sequence, the boundary was ignored — refuse to
    // delete the source instead of destroying untrimmed history.
    if (
      childBefore &&
      sourceBefore &&
      Number.isSafeInteger(childBefore.lastSeq) &&
      Number.isSafeInteger(sourceBefore.lastSeq) &&
      childBefore.lastSeq >= sourceBefore.lastSeq
    ) {
      throw new ApiError(409, 'trim-no-cut', 'the continuation session still contains the full source log; refusing to delete the source')
    }
    const registry = await stopAndDetach(fullId)
    const artifacts = await removeSessionArtifacts(fullId)
    await detachArchiveMarker(registry, fullId)
    log('trimmed session', fullId, 'kept prefix in', String(childId ?? '(unknown child)'))
    await audit({
      action: 'trim',
      sessionId: fullId,
      childId,
      sourceBefore,
      childBefore,
      ...artifacts,
    })
    return { ok: true, ...artifacts }
  }

  /** Read-only diagnostics used by verification. */
  async function sessionInfo(payload) {
    const fullId = normalizeSessionId(payload?.sessionId)
    const query = ctx.get('sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') {
      throw new ApiError(500, 'no-query', 'sessionQuery is not composed')
    }
    const snapshot = await query.readSession(fullId)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const describe = event => ({ seq: event?.seq, type: event?.type })
    return {
      ok: true,
      eventCount: events.length,
      firstSeq: events[0]?.seq,
      lastSeq: events[events.length - 1]?.seq,
      head: events.slice(0, 6).map(describe),
      tail: events.slice(-6).map(describe),
    }
  }

  /** Debug sink: lets Client halves report live slot-prop shapes to the audit file. */
  async function debugReport(payload) {
    try {
      log('debug:', JSON.stringify(payload?.data ?? payload ?? {}).slice(0, 1500))
    } catch {
      // ignore
    }
    await audit({ action: 'debug', data: payload?.data ?? payload ?? {} })
    return { ok: true }
  }

  const methods = {
    delete: deleteSession,
    trim: deleteAfterFork,
    info: sessionInfo,
    debug: debugReport,
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const rejection = ctx.connection?.requestRejection?.(req)
        if (rejection !== undefined && rejection !== null) {
          sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : undefined
        if (method === undefined || method.includes('/') || !Object.hasOwn(methods, method)) {
          throw new ApiError(404, 'not-found', 'unknown method')
        }
        const payload = await readJsonBody(req)
        const result = await methods[method](payload)
        sendJson(res, 200, result)
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500
        const code = error instanceof ApiError ? error.code : 'internal'
        const message = String(error?.message ?? error)
        if (status >= 500) log(`request failed: ${message}`)
        sendJson(res, status, { ok: false, error: { code, message } })
      }
    },
  }), 'session-cleaner: api routes')
}

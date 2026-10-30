/**
 * End-to-end tests for the session-cleaner Host half.
 *
 * Runs the real `index.js` apply() against a mock Cordis context and a fixture
 * that mirrors the real on-disk JSONL persistence layout
 * (`<root>/<project-dir>/<session-id>/session.vN.jsonl.zstd` plus the
 * projection-cache directory), so the route handler, guards, path logic, and
 * audit trail are all exercised without a live Host.
 *
 * Usage: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { apply } = await import(new URL(`file:///${packageRoot.replace(/\\/g, '/')}/index.js`))

const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const UUID_C = '99999999-8888-7777-6666-555555555555'
const ID_A = `session-${UUID_A}`
const ID_B = `session-${UUID_B}`
const ID_C = `session-${UUID_C}`
const ID_DECOY = 'session-00000000-0000-0000-0000-000000000000'

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`FAIL - ${name}`)
    throw error
  }
}

/** Build a fixture home mirroring the real persistence layout. */
async function makeFixture() {
  const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'session-cleaner-home-'))
  const projA = path.join(fixtureHome, 'sessions', '--C-fixture-project-a--', ID_A)
  const projB = path.join(fixtureHome, 'sessions', '--C-fixture-project-b--', ID_B)
  const noCwd = path.join(fixtureHome, 'sessions', '_no-cwd_', ID_C)
  for (const dir of [projA, projB, noCwd]) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), 'fixture-log-bytes')
  }
  // A decoy directory without any session log.
  const decoy = path.join(fixtureHome, 'sessions', '--C-fixture-project-a--', ID_DECOY)
  await fs.mkdir(decoy, { recursive: true })
  await fs.writeFile(path.join(decoy, 'notes.txt'), 'not a log')
  const cacheDir = path.join(fixtureHome, 'storages', 'session_projcache', 'sessions')
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.writeFile(path.join(cacheDir, `${ID_A}.json`), '{}')
  await fs.writeFile(path.join(cacheDir, `${ID_B}.json`), '{}')
  return {
    fixtureHome,
    sessionsRoot: path.join(fixtureHome, 'sessions'),
    projA,
    projB,
    noCwd,
    decoy,
    cacheDir,
    auditFile: path.join(fixtureHome, 'storages', 'session-cleaner', 'audit.log'),
  }
}

/** Fresh fixture + plugin mounted on a mock context, per test. */
async function makeTest(overrides = {}) {
  const fixture = await makeFixture()
  const registryCalls = []
  const registry = {
    archiveSession: async (id, options) => {
      registryCalls.push(['archive', id, options])
      if (overrides.archiveError) throw overrides.archiveError
    },
    unarchiveSession: async id => {
      registryCalls.push(['unarchive', id, undefined])
      if (overrides.unarchiveError) throw overrides.unarchiveError
    },
  }
  const agents = overrides.liveAgent
    ? { get: id => (id === overrides.liveAgent ? { id } : undefined) }
    : { get: () => undefined }
  const events = overrides.events ?? [
    { seq: 1, type: 'session/start' },
    { seq: 2, type: 'user/message' },
    { seq: 3, type: 'assistant/message' },
  ]
  let handler = undefined
  const ctx = {
    webServer: {
      register: registered => {
        assert.equal(registered.kind, 'prefix')
        assert.equal(registered.path, '/session-cleaner/api')
        handler = registered.handler
        return () => {}
      },
    },
    connection: { requestRejection: req => (req.headers?.['x-rejected'] ? { reason: 'untrusted' } : undefined) },
    get: key => {
      if (key === 'workspaceRegistry') return overrides.noRegistry ? undefined : registry
      if (key === 'agents') return agents
      if (key === 'sessionQuery') {
        return { readSession: async id => ({ events: id === ID_A ? events : events.slice(0, 1) }) }
      }
      return undefined
    },
    logger: { info: () => {} },
    effect: (fn, label) => {
      void label
      return fn()
    },
  }
  apply(ctx, { root: fixture.sessionsRoot })
  assert.ok(typeof handler === 'function', 'plugin did not register its route')

  const invoke = async (method, body, headers = {}) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method: 'POST',
      url: `/session-cleaner/api/${method}`,
      headers,
      async *[Symbol.asyncIterator]() {
        yield* chunks
      },
    }
    const response = { statusCode: undefined, body: undefined, writableEnded: false }
    response.writeHead = (status, _headers) => {
      response.statusCode = status
      return response
    }
    response.end = payload => {
      response.body = payload
      response.writableEnded = true
    }
    await handler(req, response)
    return { status: response.statusCode, body: JSON.parse(response.body) }
  }
  return { fixture, invoke, registryCalls }
}

await test('info returns event statistics for a persisted session', async () => {
  const { invoke } = await makeTest()
  const result = await invoke('info', { sessionId: ID_A })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.eventCount, 3)
  assert.equal(result.body.lastSeq, 3)
  assert.deepEqual(result.body.head[0], { seq: 1, type: 'session/start' })
})

await test('info rejects untrusted requests via requestRejection', async () => {
  const { invoke } = await makeTest()
  const result = await invoke('info', { sessionId: ID_A }, { 'x-rejected': 'yes' })
  assert.equal(result.status, 403)
  assert.equal(result.body.ok, false)
})

await test('info rejects malformed session ids', async () => {
  const { invoke } = await makeTest()
  for (const bad of ['../../etc', 'not-a-uuid', '', undefined, 'session-']) {
    const result = await invoke('info', { sessionId: bad })
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(bad)}`)
    assert.equal(result.body.error.code, 'bad-session-id')
  }
})

await test('unknown methods answer 404', async () => {
  const { invoke } = await makeTest()
  const result = await invoke('nuke-everything', {})
  assert.equal(result.status, 404)
})

await test('delete removes the log dir and projection cache, archiving first and unarchiving last', async () => {
  const { fixture, invoke, registryCalls } = await makeTest()
  const result = await invoke('delete', { sessionId: ID_A })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.removedLog, true)
  assert.equal(result.body.removedCache, true)
  await assert.rejects(() => fs.stat(fixture.projA), /ENOENT/)
  await assert.rejects(() => fs.stat(path.join(fixture.cacheDir, `${ID_A}.json`)), /ENOENT/)
  await fs.stat(fixture.projB) // other sessions untouched
  assert.deepEqual(registryCalls, [
    ['archive', ID_A, { stopActivity: true }],
    ['unarchive', ID_A, undefined],
  ])
})

await test('delete accepts bare UUIDs and no-cwd project dirs', async () => {
  const { fixture, invoke } = await makeTest()
  const result = await invoke('delete', { sessionId: UUID_C })
  assert.equal(result.status, 200)
  assert.equal(result.body.removedLog, true)
  await assert.rejects(() => fs.stat(fixture.noCwd), /ENOENT/)
})

await test('delete refuses directories without a session log', async () => {
  const { fixture, invoke } = await makeTest()
  const result = await invoke('delete', { sessionId: ID_DECOY })
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'not-a-session-dir')
  await fs.stat(fixture.decoy) // untouched
})

await test('delete succeeds when the log is already gone', async () => {
  const { invoke } = await makeTest()
  const first = await invoke('delete', { sessionId: ID_B })
  assert.equal(first.status, 200)
  assert.equal(first.body.removedLog, true)
  // Second call on the same fixture: no log left, still succeeds.
  const second = await invoke('delete', { sessionId: ID_B })
  assert.equal(second.status, 200)
  assert.equal(second.body.removedLog, false)
})

await test('delete refuses a live agent when no workspace registry is composed', async () => {
  const { fixture, invoke } = await makeTest({ noRegistry: true, liveAgent: ID_A })
  const result = await invoke('delete', { sessionId: ID_A })
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'session-live')
  await fs.stat(fixture.projA) // untouched
})

await test('delete continues past an unknown-session archive failure', async () => {
  const { fixture, invoke } = await makeTest({
    archiveError: new Error('session not found in live or persisted sessions'),
  })
  const result = await invoke('delete', { sessionId: ID_A })
  assert.equal(result.status, 200)
  assert.equal(result.body.removedLog, true)
  await assert.rejects(() => fs.stat(fixture.projA), /ENOENT/)
})

await test('delete fails loud on unrelated archive failures', async () => {
  const { fixture, invoke } = await makeTest({ archiveError: new Error('EACCES: registry write failed') })
  const result = await invoke('delete', { sessionId: ID_A })
  assert.equal(result.status, 500)
  await fs.stat(fixture.projA) // untouched
})

await test('unarchive failures never fail the deletion', async () => {
  const { invoke } = await makeTest({ unarchiveError: new Error('registry unavailable') })
  const result = await invoke('delete', { sessionId: ID_A })
  assert.equal(result.status, 200)
})

await test('trim audits fork boundary facts and deletes the source', async () => {
  const { fixture, invoke } = await makeTest()
  const result = await invoke('trim', { sessionId: ID_A, childId: ID_B })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  await assert.rejects(() => fs.stat(fixture.projA), /ENOENT/)
  const auditRaw = await fs.readFile(fixture.auditFile, 'utf8')
  const records = auditRaw.trim().split('\n').map(line => JSON.parse(line))
  const trim = records.find(record => record.action === 'trim')
  assert.ok(trim, 'trim audit record missing')
  assert.equal(trim.sourceBefore.eventCount, 3)
  assert.equal(trim.sourceBefore.lastSeq, 3)
  assert.equal(trim.childBefore.eventCount, 1)
  assert.equal(trim.childId, ID_B)
})

await test('trim refuses when the child still holds the full source log', async () => {
  const { fixture, invoke } = await makeTest()
  // readSession returns the full event list for every id except ID_A; make the
  // child report the same last seq as the source to simulate a boundary miss.
  const result = await invoke('trim', { sessionId: ID_A, childId: ID_A })
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'trim-no-cut')
  await fs.stat(fixture.projA) // source untouched
})

await test('audit log records delete actions', async () => {
  const { fixture, invoke } = await makeTest()
  await invoke('delete', { sessionId: ID_B })
  const auditRaw = await fs.readFile(fixture.auditFile, 'utf8')
  const records = auditRaw.trim().split('\n').map(line => JSON.parse(line))
  const del = records.find(record => record.action === 'delete' && record.sessionId === ID_B)
  assert.ok(del, 'delete audit record missing')
  assert.equal(del.removedLog, true)
})

console.log(`\n${passed} tests passed`)

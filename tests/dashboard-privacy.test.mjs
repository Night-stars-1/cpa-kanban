import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createDashboardServer } from '../server.mjs';

const PRIMARY = {
  name: '10-private-owner.json', auth_index: 'PRIVATE_INDEX_PRIMARY', provider: 'codex',
  account: 'private-owner@example.test', account_id: 'PRIVATE_WORKSPACE_PRIMARY',
};
const SECONDARY = {
  name: '20-private-secondary.json', auth_index: 'PRIVATE_INDEX_SECONDARY', provider: 'codex',
  account: 'private-secondary@example.test', account_id: 'PRIVATE_WORKSPACE_SECONDARY',
};
const PRIVATE_VALUES = [
  ...Object.values(PRIMARY).filter((value) => value !== 'codex'),
  ...Object.values(SECONDARY).filter((value) => value !== 'codex'),
  '00-private-bridge.json', 'private-bridge@example.test', 'PRIVATE_PLAN',
  'PRIVATE_WINDOW', 'PRIVATE_SCOPE', 'PRIVATE_MODEL', 'PRIVATE_AVAILABILITY',
  'PRIVATE_UPSTREAM_ERROR', 'fixture-key',
];
const PUBLIC_ROW_FIELDS = [
  'windowLabel', 'windowMode', 'startMs', 'endMs', 'usedPercent', 'observedAtMs',
  'stale', 'current', 'previous', 'forecast', 'unavailableReason',
].sort();
const PRIVATE_FIELDS = new Set([
  'id', 'accountId', 'accountName', 'provider', 'plan', 'sourceLabel', 'warnings',
  'account', 'row_key', 'account_key', 'auth_index', 'auth_file_snapshot',
  'account_snapshot', 'provider_window_id', 'window_key', 'model_scope_key', 'model_ids',
]);

function assertNoPrivateData(value, upstreamUrl) {
  const json = JSON.stringify(value);
  for (const secret of [...PRIVATE_VALUES, upstreamUrl]) {
    assert.equal(json.includes(secret), false, `Private value must not reach the HTTP response: ${secret}`);
  }
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      assert.equal(PRIVATE_FIELDS.has(key), false, `Private field leaked: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

async function startManagerFixture() {
  const now = Date.now();
  const state = { mode: 'normal', calls: [] };
  const cycle = (duration, previous = false) => {
    const start = now - 3600000;
    return {
      id: previous ? 10 : 11, state: previous ? 'closed' : 'active',
      scheduled_start_ms: previous ? start - duration * 1000 : start,
      scheduled_end_ms: previous ? start : start + duration * 1000,
      actual_start_ms: previous ? start - duration * 1000 : start,
      actual_end_ms: previous ? start : null, duration_seconds: duration,
      boundary_accuracy: 'exact', end_reason: previous ? 'scheduled' : '', forecast_eligible: true,
    };
  };
  const window = (id, duration, extra = {}) => ({
    provider_window_id: id, window_kind: duration === 604800 ? 'weekly' : 'five_hour',
    window_mode: 'fixed', model_scope_kind: 'all', model_scope_key: '', model_ids: [],
    source: 'api_query', observed_at_ms: now - 60000, boundary_accuracy: 'exact',
    cycle_start_ms: now - 3600000, cycle_end_ms: now - 3600000 + duration * 1000,
    duration_seconds: duration, used_percent: 25, remaining_percent: 75,
    plan_type: 'PRIVATE_PLAN', stale: false, availability: 'active',
    field_sources: { quota: { source: 'api_query', observed_at_ms: now - 60000 } },
    current_cycle: cycle(duration), previous_cycle: cycle(duration, true), ...extra,
  });
  const windows = [
    window('PRIVATE_WINDOW_SHORT', 18000),
    window('PRIVATE_WINDOW_WEEKLY', 604800),
    window('PRIVATE_WINDOW_FAMILY', 604800, { model_scope_kind: 'family', model_scope_key: 'PRIVATE_SCOPE_OWNER' }),
    window('PRIVATE_WINDOW_MODELS', 18000, { model_scope_kind: 'models', model_ids: ['PRIVATE_MODEL_OWNER@example.test'] }),
    window('PRIVATE_WINDOW_AVAILABILITY', 7200, { availability: 'PRIVATE_AVAILABILITY_OWNER@example.test' }),
    window('PRIVATE_WINDOW_OWNER@example.test', 0, {
      window_kind: 'PRIVATE_SCOPE_UNKNOWN', window_mode: 'non_window',
      duration_seconds: null, cycle_start_ms: null, cycle_end_ms: null,
      boundary_accuracy: 'unknown', current_cycle: null, previous_cycle: null,
    }),
  ];
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : null;
    state.calls.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    const send = (value, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.url === '/usage-service/info') return send({ service: 'cpa-manager-plus', adminReady: true });
    if (state.mode === 'denied' || req.headers.authorization !== 'Bearer fixture-key') {
      return send({ error: `PRIVATE_UPSTREAM_ERROR ${PRIMARY.account} ${PRIMARY.name}` }, 401);
    }
    if (req.url === '/v0/management/auth-files') {
      return send({ files: state.mode === 'empty' ? [] : [
        { name: '00-private-bridge.json', auth_index: 'bridge', provider: 'cline-pass', account: 'private-bridge@example.test' },
        PRIMARY, SECONDARY,
      ] });
    }
    if (req.url === '/v0/management/quota-snapshots/query') {
      return send({ generated_at_ms: now, items: body.accounts.map((account) => ({
        row_key: account.row_key, account_key: account.row_key, provider: 'codex',
        windows: state.mode === 'duplicate' ? [windows[0], windows[0]] : windows,
      })) });
    }
    if (req.url === '/v0/management/monitoring/account-window-usage') {
      return send({ generated_at_ms: now, items: body.windows.map((entry) => {
        const secondary = entry.row_key.includes(SECONDARY.name);
        const amount = secondary ? 99900 : entry.provider_window_id === 'PRIVATE_WINDOW_WEEKLY' ? 700 : 100;
        const n = entry.period === 'current' ? amount : amount * 0.8;
        return {
          ...entry, matched: true, total_requests: n, total_tokens: n * 1000,
          total_cost: n / 100, last_seen_ms: Math.min(entry.to_ms - 1000, now - 61000),
          sync_status: 'ready', scope_match_status: 'complete', unmatched_requests: 0,
          accountName: PRIMARY.account, provider: PRIMARY.provider, plan: 'PRIVATE_PLAN',
        };
      }) });
    }
    send({ error: 'Unexpected fixture route' }, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

test('window dashboard keeps private upstream identity out of successful, empty and failed responses', async () => {
  const keys = ['HOST', 'CPA_MANAGER_BASE_URL', 'CPA_MANAGER_ADMIN_KEY'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const upstream = await startManagerFixture();
  let app;
  try {
    process.env.HOST = '127.0.0.1';
    process.env.CPA_MANAGER_BASE_URL = upstream.url;
    process.env.CPA_MANAGER_ADMIN_KEY = 'fixture-key';
    app = await createDashboardServer({ production: true, port: 0 });
    const read = async () => {
      const response = await fetch(`${app.url}/api/snapshot`);
      return { status: response.status, data: await response.json() };
    };
    const result = await read();
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.data).sort(), ['generatedAtMs', 'rows']);
    assert.equal(result.data.rows.length, 6);
    assertNoPrivateData(result.data, upstream.url);
    for (const row of result.data.rows) {
      assert.deepEqual(Object.keys(row).sort(), PUBLIC_ROW_FIELDS);
      if (row.current) assert.deepEqual(Object.keys(row.current).sort(), ['cost', 'lastSeenMs', 'requests', 'tokens']);
      if (row.previous) assert.deepEqual(Object.keys(row.previous).sort(), ['cost', 'lastSeenMs', 'requests', 'tokens']);
      if (row.forecast) assert.deepEqual(Object.keys(row.forecast).sort(), ['basis', 'cost', 'requests', 'tokens']);
    }
    const weekly = result.data.rows.find((row) => row.current?.requests === 700);
    assert.deepEqual(weekly.forecast, { requests: 2800, tokens: 2800000, cost: 28, basis: 'quota' });
    const usageRequests = upstream.state.calls
      .filter((call) => call.path === '/v0/management/monitoring/account-window-usage')
      .flatMap((call) => call.body.windows);
    assert.equal(usageRequests.some((entry) => entry.period === 'current'), true);
    for (const entry of usageRequests) {
      assert.equal(entry.auth_file_snapshot, PRIMARY.name);
      assert.equal(entry.auth_index, PRIMARY.auth_index);
      assert.equal(entry.row_key.includes(PRIMARY.name), true);
      assert.equal(entry.row_key.includes(SECONDARY.name), false);
    }
    assert.equal(upstream.state.calls.some((call) => call.method === 'POST' && ![
      '/v0/management/quota-snapshots/query', '/v0/management/monitoring/account-window-usage',
    ].includes(call.path)), false);

    upstream.state.mode = 'empty';
    const empty = await read();
    assert.equal(empty.status, 200);
    assert.deepEqual(Object.keys(empty.data).sort(), ['generatedAtMs', 'rows']);
    assert.deepEqual(empty.data.rows, []);
    assertNoPrivateData(empty.data, upstream.url);

    for (const mode of ['duplicate', 'denied']) {
      upstream.state.mode = mode;
      const failed = await read();
      assert.equal(failed.status, 502);
      assert.deepEqual(Object.keys(failed.data), ['error']);
      assertNoPrivateData(failed.data, upstream.url);
    }
  } finally {
    await app?.close();
    await upstream.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

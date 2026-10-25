/**
 * cpa-manager-plus 只读适配器。
 *
 * 只允许四个上游请求（见 ROUTE_METHODS）：
 *   GET  /usage-service/info
 *   GET  /v0/management/auth-files
 *   POST /v0/management/quota-snapshots/query            （只读查询，绝不写快照）
 *   POST /v0/management/monitoring/account-window-usage
 *
 * 身份、窗口区间、模型范围与预测语义移植自 cpa-manager-plus
 * (MIT, Copyright (c) 2026 Seakee)。
 */

import { buildWindowUsageRanges, resolveWindowForecast } from './forecast.mjs';

const SELECTION_KEY_SEPARATOR = '\u0000';
const REQUEST_TIMEOUT_MS = 30_000;
const SNAPSHOT_ACCOUNT_BATCH_SIZE = 200;
const WINDOW_USAGE_BATCH_SIZE = 400;

const INFO_ROUTE = '/usage-service/info';
const AUTH_FILES_ROUTE = '/v0/management/auth-files';
const SNAPSHOT_QUERY_ROUTE = '/v0/management/quota-snapshots/query';
const WINDOW_USAGE_ROUTE = '/v0/management/monitoring/account-window-usage';

const ROUTE_METHODS = new Map([
  [INFO_ROUTE, 'GET'],
  [AUTH_FILES_ROUTE, 'GET'],
  [SNAPSHOT_QUERY_ROUTE, 'POST'],
  [WINDOW_USAGE_ROUTE, 'POST'],
]);

const MANAGER_SERVICE_IDS = new Set(['cpa-manager-plus', 'cpa-manager', 'cpa-usage-service']);
const SUPPORTED_PROVIDERS = new Set(['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta']);
const WINDOW_MODES = new Set(['fixed', 'calendar', 'rolling', 'non_window', 'unknown']);
const BOUNDARY_ACCURACIES = new Set(['exact', 'derived', 'estimated', 'unknown']);
const MODEL_SCOPE_KINDS = new Set(['all', 'family', 'models', 'product', 'feature']);

const WINDOW_KIND_LABELS = new Map([
  ['five_hour', '5 小时窗口'],
  ['daily', '24 小时窗口'],
  ['weekly', '7 天窗口'],
  ['monthly', '30 天窗口'],
  ['rolling_24h', '滚动 24 小时窗口'],
  ['billing', '计费窗口'],
  ['payg', '按量计费窗口'],
  ['product', '产品额度窗口'],
  ['summary', '汇总额度窗口'],
]);

class AdapterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AdapterError';
    this.status = options.status;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPositiveFinite = (value) => isFiniteNumber(value) && value > 0;
const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const malformed = (message) => new AdapterError(message);

/* ------------------------------------------------------------------ */
/* 地址与密钥                                                          */
/* ------------------------------------------------------------------ */

const stripManagementSuffix = (pathname) => {
  let path = pathname;
  for (let index = 0; index < 4; index += 1) {
    const before = path;
    path = path.replace(/\/+$/, '');
    path = path.replace(/\/v0\/management$/i, '');
    path = path.replace(/\/+$/, '');
    path = path.replace(/\/management\.html$/i, '');
    if (path === before) break;
  }
  return path.replace(/\/+$/, '');
};

const normalizeBaseUrl = (input) => {
  if (typeof input !== 'string') throw new AdapterError('请填写管理器地址。');
  let value = input.trim();
  if (!value) throw new AdapterError('请填写管理器地址。');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AdapterError('实例地址格式无效，请填写类似 http://127.0.0.1:8317 的地址。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AdapterError('实例地址必须使用 http:// 或 https://。');
  }
  if (url.username || url.password) {
    throw new AdapterError('实例地址不能包含用户名或密码。');
  }
  if (url.search) throw new AdapterError('实例地址不能包含查询参数。');
  if (url.hash) throw new AdapterError('实例地址不能包含片段（#）。');

  const path = stripManagementSuffix(url.pathname);
  const baseUrl = `${url.origin}${path}`;
  return { baseUrl, sourceLabel: baseUrl };
};

const normalizeManagementKey = (key) => {
  if (typeof key !== 'string' || !key.trim()) throw new AdapterError('请填写管理密钥。');
  const trimmed = key.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new AdapterError('管理密钥包含无效字符。');
  return trimmed;
};

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const assertAllowedRoute = (route, method) => {
  if (ROUTE_METHODS.get(route) !== method) {
    throw new AdapterError('内部请求被拒绝：适配器仅允许固定的只读路由。');
  }
};

const httpErrorMessage = (label, status) => {
  if (status === 401 || status === 403) {
    return `读取${label}被拒绝（HTTP ${status}），请检查管理密钥。`;
  }
  if (status === 404) {
    return `读取${label}时接口不存在（HTTP 404），请确认实例为 cpa-manager-plus 且版本支持该接口。`;
  }
  if (status === 405) return `读取${label}的请求方法不被支持（HTTP 405）。`;
  if (status === 429) return `读取${label}过于频繁（HTTP 429），请稍后再试。`;
  if (status >= 500) return `读取${label}时管理器内部错误（HTTP ${status}）。`;
  return `读取${label}失败（HTTP ${status}）。`;
};

const transportErrorMessage = (error, label) => {
  const description = `${error?.name ?? ''} ${error?.message ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase();
  if (description.includes('redirect')) {
    return '实例地址发生了重定向，已拒绝请求以保护管理密钥。';
  }
  if (description.includes('timeout') || description.includes('abort')) {
    return `读取${label}超时（${REQUEST_TIMEOUT_MS / 1000} 秒）。`;
  }
  return `无法连接管理器（读取${label}时网络请求失败），请检查地址与网络。`;
};

const requestJson = async ({ baseUrl, route, method, label, key = '', body, parseFailureMessage }) => {
  assertAllowedRoute(route, method);
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AdapterError(transportErrorMessage(error, label));
  }

  if (!response.ok) {
    throw new AdapterError(httpErrorMessage(label, response.status), { status: response.status });
  }

  let text;
  try {
    text = await response.text();
  } catch {
    throw new AdapterError(`读取${label}时响应读取失败。`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AdapterError(parseFailureMessage ?? `${label}返回了无法解析的 JSON。`);
  }
};

const readManagerInfo = async (baseUrl) => {
  let data;
  try {
    data = await requestJson({
      baseUrl,
      route: INFO_ROUTE,
      method: 'GET',
      label: '管理器信息',
      parseFailureMessage:
        '实例地址返回的不是有效的管理器信息（/usage-service/info 响应格式异常），可能是普通 CPA 实例。',
    });
  } catch (error) {
    if (error instanceof AdapterError && error.status === 404) {
      throw new AdapterError(
        '该地址看起来是普通 CPA 实例：/usage-service/info 不存在，缺少配额快照与窗口用量接口。请填写 cpa-manager-plus 管理服务地址。',
        { status: 404 }
      );
    }
    throw error;
  }

  if (!isRecord(data)) {
    throw new AdapterError(
      '实例地址返回的管理器信息格式异常（不是 JSON 对象），可能是普通 CPA 实例。'
    );
  }
  const service = typeof data.service === 'string' ? data.service.trim() : '';
  if (!MANAGER_SERVICE_IDS.has(service)) {
    if (!service) {
      throw new AdapterError(
        '该地址不是 cpa-manager-plus：/usage-service/info 缺少 service 标识，可能是普通 CPA 实例。'
      );
    }
    const safeService = service.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, '?');
    throw new AdapterError(
      `该地址不是受支持的 CPA 管理器（service=${safeService}），普通 CPA 缺少配额快照接口。请填写 cpa-manager-plus 地址。`
    );
  }
};

/* ------------------------------------------------------------------ */
/* 账号清单（CPA auth-files，含上游别名与去重语义）                     */
/* ------------------------------------------------------------------ */

const readTextField = (entry, field) => (typeof entry[field] === 'string' ? entry[field].trim() : '');

const readAuthIndexField = (entry) => {
  const value = entry.authIndex ?? entry.auth_index ?? entry['auth-index'];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value.trim();
  return '';
};

const normalizeAuthIndex = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
};

const normalizeProviderValue = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'x-ai' || normalized === 'grok') return 'xai';
  if (normalized === 'muse') return 'meta';
  return normalized;
};

const readProvider = (file) => {
  const candidate = [file.provider, file.type, file.typo]
    .map((value) => normalizeString(value))
    .find(Boolean);
  if (candidate) return normalizeProviderValue(candidate);
  return normalizeProviderValue(file.provider ?? file.type ?? file.typo ?? '');
};

const readRuntimeId = (file) => (typeof file.id === 'string' ? file.id.trim() : '');
const readPhysicalName = (file) => String(file.name ?? '').trim();

const readDateField = (entry) => {
  const candidates = [entry.modtime, entry.modified, entry.updated_at, entry.last_refresh];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
};

const isRuntimeOnlyEntry = (entry) => {
  const value = entry.runtime_only ?? entry.runtimeOnly;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
};

const hasMeaningfulValue = (value) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const countMeaningfulFields = (entry) =>
  Object.values(entry).reduce((count, value) => count + (hasMeaningfulValue(value) ? 1 : 0), 0);

const authFilePriorityScore = (entry) => {
  let score = 0;
  if (readTextField(entry, 'source').toLowerCase() === 'file') score += 32;
  if (readTextField(entry, 'path')) score += 16;
  if (!isRuntimeOnlyEntry(entry)) score += 8;
  if (entry.disabled !== true) score += 4;
  if (readDateField(entry) > 0) score += 2;
  return score;
};

const compareAuthFileEntries = (left, right) => {
  const scoreDiff = authFilePriorityScore(right) - authFilePriorityScore(left);
  if (scoreDiff !== 0) return scoreDiff;
  const dateDiff = readDateField(right) - readDateField(left);
  if (dateDiff !== 0) return dateDiff;
  return countMeaningfulFields(right) - countMeaningfulFields(left);
};

const mergeAuthFileEntries = (entries) => {
  const [primary, ...rest] = [...entries].sort(compareAuthFileEntries);
  const merged = { ...primary };
  for (const entry of rest) {
    for (const [field, value] of Object.entries(entry)) {
      if (!hasMeaningfulValue(merged[field]) && hasMeaningfulValue(value)) {
        merged[field] = value;
      }
    }
  }
  return merged;
};

const getAuthFileDedupeKey = (entry) => {
  const name = readTextField(entry, 'name');
  const authIndex = readAuthIndexField(entry);
  const runtimeId = readRuntimeId(entry);
  if (name && authIndex && runtimeId) return `${name}${SELECTION_KEY_SEPARATOR}${authIndex}${SELECTION_KEY_SEPARATOR}${runtimeId}`;
  if (name && authIndex) return `${name}${SELECTION_KEY_SEPARATOR}${authIndex}`;
  return name || JSON.stringify(entry);
};

const dedupeAuthFiles = (files) => {
  const grouped = new Map();
  for (const entry of files) {
    const key = getAuthFileDedupeKey(entry);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry);
    else grouped.set(key, [entry]);
  }
  const merged = Array.from(grouped.values()).map(mergeAuthFileEntries);
  merged.sort((left, right) => {
    const nameDiff = readTextField(left, 'name').localeCompare(readTextField(right, 'name'), undefined, {
      sensitivity: 'accent',
    });
    if (nameDiff !== 0) return nameDiff;
    return readAuthIndexField(left).localeCompare(readAuthIndexField(right), undefined, {
      numeric: true,
      sensitivity: 'accent',
    });
  });
  return merged;
};

/* ------------------------------------------------------------------ */
/* 凭证身份（row_key / 账号 ID）                                        */
/* ------------------------------------------------------------------ */

const readRecord = (value) => (isRecord(value) ? value : null);

const decodeBase64UrlPayload = (segment) => {
  try {
    const text = Buffer.from(segment, 'base64url').toString('utf8');
    return text || null;
  } catch {
    return null;
  }
};

const parseIdTokenPayload = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return Array.isArray(value) ? null : value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return readRecord(JSON.parse(trimmed));
  } catch {
    // 继续按 JWT 处理
  }
  const segments = trimmed.split('.');
  if (segments.length < 2) return null;
  const decoded = decodeBase64UrlPayload(segments[1]);
  if (!decoded) return null;
  try {
    return readRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
};

const ACCOUNT_ID_FIELDS = [
  'account_id',
  'accountId',
  'chatgpt_account_id',
  'chatgptAccountId',
  'project_id',
  'projectId',
  'gemini_virtual_project',
  'geminiVirtualProject',
  'sub',
];

const readAccountIdFromValue = (value, seen = new Set()) => {
  const record = readRecord(value);
  if (!record || seen.has(record)) return '';
  seen.add(record);
  for (const field of ACCOUNT_ID_FIELDS) {
    const normalized = normalizeString(record[field]);
    if (normalized) return normalized;
  }
  for (const field of ['id_token', 'idToken']) {
    const nested = readAccountIdFromValue(record[field], seen);
    if (nested) return nested;
  }
  return '';
};

const readNonCodexAccountId = (file) => {
  const direct = readAccountIdFromValue(file);
  if (direct) return direct;
  for (const field of ['id_token', 'idToken', 'metadata', 'attributes']) {
    const nested = readAccountIdFromValue(file[field]);
    if (nested) return nested;
  }
  return '';
};

const CODEX_ACCOUNT_ID_FIELDS = ['chatgpt_account_id', 'chatgptAccountId', 'account_id', 'accountId'];
const CODEX_NESTED_EVIDENCE_FIELDS = ['id_token', 'idToken', 'metadata', 'attributes'];

const normalizeCodexWorkspaceId = (value) => {
  if (typeof value === 'string') return value.replace(/^ +| +$/g, '') || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const readCodexAccountIdCandidate = (value) => {
  if (value === undefined || value === null) return { value: null, present: false, valid: true };
  if (typeof value === 'string' && value.trim() === '') {
    return { value: null, present: false, valid: true };
  }
  const normalized = normalizeCodexWorkspaceId(value);
  return normalized
    ? { value: normalized, present: true, valid: true }
    : { value: null, present: true, valid: false };
};

const resolveCodexChatgptAccountIdEvidence = (value) => {
  const candidates = new Set();
  let invalid = false;
  const visited = new Set();

  const visit = (input) => {
    const record = readRecord(input);
    if (!record) {
      const payload = parseIdTokenPayload(input);
      if (payload) visit(payload);
      return;
    }
    if (visited.has(record)) return;
    visited.add(record);

    for (const field of CODEX_ACCOUNT_ID_FIELDS) {
      if (!(field in record)) continue;
      const candidate = readCodexAccountIdCandidate(record[field]);
      if (!candidate.present) continue;
      if (!candidate.valid || !candidate.value) invalid = true;
      else candidates.add(candidate.value);
    }

    for (const field of CODEX_NESTED_EVIDENCE_FIELDS) {
      const nested = record[field];
      if (nested === undefined || nested === null) continue;
      visit(nested);
    }
  };

  visit(value);
  if (invalid || candidates.size > 1) return { accountId: null, invalid: true };
  return { accountId: candidates.values().next().value ?? null, invalid: false };
};

const normalizeCodexMemberSnapshot = (value) => {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/^ +| +$/g, '');
  const at = normalized.indexOf('@');
  if (
    !normalized ||
    at <= 0 ||
    at === normalized.length - 1 ||
    normalized.indexOf('@', at + 1) !== -1 ||
    Array.from(normalized).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code >= 0x7f;
    })
  ) {
    return '';
  }
  return normalized.toLowerCase();
};

const resolveCodexMemberSnapshot = (file) => {
  const members = [file.accountSnapshot, file.account_snapshot, file.account, file.email]
    .map(normalizeCodexMemberSnapshot)
    .filter(Boolean);
  const member = members[0] ?? '';
  if (members.some((candidate) => candidate !== member)) return { member: '', invalid: true };
  return { member, invalid: false };
};

const readAccountSnapshot = (file) => {
  for (const value of [file.account, file.email, file.display_account, file.displayAccount]) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
};

const readAuthLabelSnapshot = (file) => {
  for (const value of [file.label, file.note]) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
};

const readProjectId = (file) => {
  for (const value of [
    file.projectId,
    file.project_id,
    file.geminiVirtualProject,
    file.gemini_virtual_project,
  ]) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
};

const readDisplayName = (file, name) => {
  for (const value of [file.email, file.account, file.label, file.note]) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return name;
};

const resolveAuthIndex = (file) => normalizeAuthIndex(file.authIndex ?? file.auth_index ?? file['auth-index']);

const identityKeyOf = (identity) => {
  if (identity.authIndex) return `${identity.name}::${identity.authIndex}`;
  const accountSnapshot =
    identity.provider === 'codex'
      ? normalizeCodexMemberSnapshot(identity.accountSnapshot)
      : identity.accountSnapshot && identity.accountSnapshot !== identity.name
        ? identity.accountSnapshot
        : '';
  const fallbackAccountSnapshot =
    identity.accountId && identity.provider !== 'codex' ? '' : accountSnapshot;
  const stableAccountId = identity.provider === 'codex' && !accountSnapshot ? '' : identity.accountId;
  if (stableAccountId || fallbackAccountSnapshot) {
    return `${identity.name}::-::${JSON.stringify([
      identity.name,
      identity.provider,
      null,
      stableAccountId || null,
      fallbackAccountSnapshot || null,
    ])}`;
  }
  if (identity.runtimeId && identity.runtimeId !== identity.name) {
    return `${identity.name}::-::runtime:${JSON.stringify([identity.provider, identity.runtimeId])}`;
  }
  return `${identity.name}::-`;
};

const buildAccountFromFile = (file) => {
  const name = readPhysicalName(file);
  const provider = readProvider(file);
  const runtimeId = readRuntimeId(file);
  const authIndex = resolveAuthIndex(file);
  const directAccountSnapshot = normalizeString(file.accountSnapshot);
  const directAccountId = normalizeString(file.accountId);
  const isCodex = provider === 'codex';

  const codexEvidence = isCodex ? resolveCodexChatgptAccountIdEvidence(file) : null;
  const codexMember = isCodex ? resolveCodexMemberSnapshot(file) : null;
  const accountSnapshot = isCodex
    ? codexMember.member
    : directAccountSnapshot || readAccountSnapshot(file);
  const accountId =
    isCodex && codexEvidence.invalid
      ? ''
      : directAccountId || (isCodex ? (codexEvidence.accountId ?? '') : readNonCodexAccountId(file));

  const identity = {
    name,
    provider,
    runtimeId,
    authIndex,
    accountId,
    accountSnapshot,
  };
  const rowKey = authIndex
    ? `${name}${SELECTION_KEY_SEPARATOR}${authIndex}`
    : `${name}${SELECTION_KEY_SEPARATOR}-${SELECTION_KEY_SEPARATOR}${identityKeyOf(identity)}`;

  return {
    name,
    displayName: readDisplayName(file, name),
    provider,
    runtimeId,
    authIndex: authIndex ?? '',
    accountSnapshot,
    accountId,
    authLabelSnapshot: normalizeString(file.authLabelSnapshot) || readAuthLabelSnapshot(file),
    authFileSnapshot: name,
    authAccountIdSnapshot: isCodex ? accountId : '',
    authProjectIdSnapshot: isCodex ? '' : readProjectId(file),
    rowKey,
  };
};

const buildIdentityPayload = (account) => {
  const payload = {
    account_snapshot: account.accountSnapshot || undefined,
    auth_label_snapshot: account.authLabelSnapshot || undefined,
    auth_file_snapshot: account.authFileSnapshot || undefined,
    auth_provider_snapshot: account.provider || undefined,
    auth_account_id_snapshot: account.authAccountIdSnapshot || undefined,
    auth_project_id_snapshot: account.authProjectIdSnapshot || undefined,
    auth_index: account.authIndex || undefined,
    source: account.authFileSnapshot || undefined,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return payload;
};

const hasCredentialIdentity = (target) => {
  const authFile = target.auth_file_snapshot?.trim() ?? '';
  const account = target.account_snapshot?.trim() ?? '';
  const label = target.auth_label_snapshot?.trim() ?? '';
  const source = target.source?.trim() ?? '';
  const provider = target.auth_provider_snapshot?.trim() ?? '';
  const effectiveFile = authFile || (source && source !== account && source !== label ? source : '');
  if (effectiveFile) return Boolean(provider);
  if (!provider) return false;
  return Boolean(
    target.auth_index?.trim() ||
      target.auth_account_id_snapshot?.trim() ||
      target.auth_project_id_snapshot?.trim() ||
      account ||
      label
  );
};

const readAuthFiles = async (baseUrl, key) => {
  const data = await requestJson({
    baseUrl,
    route: AUTH_FILES_ROUTE,
    method: 'GET',
    label: '账号清单',
    key,
    parseFailureMessage: '账号清单返回了无法解析的 JSON。',
  });
  if (!isRecord(data) || !Array.isArray(data.files)) {
    throw malformed('账号清单响应格式异常（缺少 files 数组），请确认该地址是 cpa-manager-plus 或 CPA 管理接口。');
  }
  for (const entry of data.files) {
    if (!isRecord(entry)) throw malformed('账号清单响应格式异常（文件条目不是对象）。');
  }
  return dedupeAuthFiles(data.files);
};

const fillAccountIdentity = (target, source) => {
  for (const field of [
    'runtimeId',
    'accountSnapshot',
    'accountId',
    'authLabelSnapshot',
    'authAccountIdSnapshot',
    'authProjectIdSnapshot',
  ]) {
    if (!target[field] && source[field]) target[field] = source[field];
  }
};

const buildAccounts = (files, warnings) => {
  const accounts = [];
  const accountsByRowKey = new Map();
  let missingName = 0;

  for (const file of files) {
    const account = buildAccountFromFile(file);
    if (!account.name) {
      missingName += 1;
      continue;
    }
    if (!account.provider) {
      warnings.push(`账号「${account.name}」缺少提供商信息，已跳过。`);
      continue;
    }
    if (!SUPPORTED_PROVIDERS.has(account.provider)) {
      warnings.push(
        `账号「${account.name}」的提供商「${account.provider}」不受配额快照接口支持，已跳过。`
      );
      continue;
    }
    const target = buildIdentityPayload(account);
    if (!hasCredentialIdentity(target)) {
      warnings.push(`账号「${account.name}」缺少可查询的凭证标识，已跳过。`);
      continue;
    }
    const existing = accountsByRowKey.get(account.rowKey);
    if (existing) {
      fillAccountIdentity(existing, account);
      warnings.push(`账号「${account.name}」存在重复的账号标识，已合并。`);
      continue;
    }
    accountsByRowKey.set(account.rowKey, account);
    accounts.push(account);
  }

  if (missingName > 0) warnings.push(`有 ${missingName} 个账号条目缺少文件名，已跳过。`);
  return accounts;
};

/* ------------------------------------------------------------------ */
/* 模型范围与区间标签                                                   */
/* ------------------------------------------------------------------ */

const normalizeModelIds = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw malformed('配额快照响应格式异常（model_ids 必须是数组）。');
  const seen = new Set();
  const models = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw malformed('配额快照响应格式异常（model_ids 必须全部是字符串）。');
    }
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    models.push(normalized);
  }
  models.sort();
  return models;
};

const normalizeSnapshotModelScope = (window) => {
  if (typeof window.model_scope_kind !== 'string' || !window.model_scope_kind.trim()) {
    throw malformed('配额快照响应格式异常（窗口缺少 model_scope_kind）。');
  }
  const kind = window.model_scope_kind.trim().toLowerCase();
  if (!MODEL_SCOPE_KINDS.has(kind)) {
    throw malformed(`配额快照响应格式异常（未知的 model_scope_kind：${kind}）。`);
  }
  if (window.model_scope_key !== undefined && window.model_scope_key !== null && typeof window.model_scope_key !== 'string') {
    throw malformed('配额快照响应格式异常（model_scope_key 必须是字符串）。');
  }
  const key = typeof window.model_scope_key === 'string' ? window.model_scope_key.trim().toLowerCase() : '';
  const models = normalizeModelIds(window.model_ids);

  if (kind === 'feature' && key === 'scope_unknown' && models.length === 0) {
    return { kind: 'models', key: '', models: [], complete: false };
  }

  const complete =
    kind === 'all' ||
    (kind === 'models' && models.length > 0) ||
    (kind === 'family' && (Boolean(key) || models.length > 0)) ||
    ((kind === 'product' || kind === 'feature') && models.length > 0);

  return { kind, key, models, complete };
};

const isQueryableModelScope = (scope) => {
  if (scope.complete === false) return false;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'models') return scope.models.length > 0;
  return Boolean(scope.key) || scope.models.length > 0;
};

const modelScopeRequestPart = (scope) =>
  JSON.stringify([
    String(scope?.kind ?? 'all').trim().toLowerCase(),
    String(scope?.key ?? '').trim().toLowerCase(),
    scope?.complete !== false,
    ...Array.from(
      new Set((scope?.models ?? []).map((model) => String(model).trim().toLowerCase()).filter(Boolean))
    ).sort(),
  ]);

const buildUsageRequestKey = (rowKey, providerWindowId, period, scope) =>
  `${rowKey}${SELECTION_KEY_SEPARATOR}${providerWindowId}${SELECTION_KEY_SEPARATOR}${modelScopeRequestPart(scope)}${SELECTION_KEY_SEPARATOR}${period}`;

const formatModels = (models) => {
  if (models.length <= 3) return models.join('、');
  return `${models.slice(0, 3).join('、')} 等 ${models.length} 个模型`;
};

const SCOPE_KEY_LABELS = new Map([
  ['codex_main', 'Codex 主额度'],
  ['claude_gpt', 'Claude 与 GPT'],
  ['gemini', 'Gemini'],
  ['code_review', '代码审查'],
]);

const scopeKeyLabel = (key) => SCOPE_KEY_LABELS.get(key) ?? key;

const modelScopeLabelSuffix = (scope) => {
  if (!scope) return '';
  if (scope.complete === false) return '（模型范围未知）';
  if (scope.kind === 'all') return '';
  if (scope.kind === 'family') {
    if (scope.key === 'codex_main') return '';
    const label = scope.key ? scopeKeyLabel(scope.key) : formatModels(scope.models);
    return label ? `（系列：${label}）` : '（系列范围）';
  }
  if (scope.kind === 'models') {
    return scope.models.length ? `（模型：${formatModels(scope.models)}）` : '（模型范围）';
  }
  if (scope.kind === 'product') {
    return scope.key ? `（产品：${scopeKeyLabel(scope.key)}）` : '（产品范围）';
  }
  if (scope.kind === 'feature') {
    const parts = [
      scope.key ? scopeKeyLabel(scope.key) : '',
      scope.models.length ? formatModels(scope.models) : '',
    ].filter(Boolean);
    return parts.length ? `（功能：${parts.join('、')}）` : '（功能范围）';
  }
  return '';
};

const durationLabel = (seconds) => {
  const divisible = (divisor) => Math.abs(seconds % divisor) < 1e-9;
  if (divisible(86400)) return `${seconds / 86400} 天窗口`;
  if (divisible(3600)) return `${seconds / 3600} 小时窗口`;
  if (divisible(60)) return `${seconds / 60} 分钟窗口`;
  return `${seconds} 秒窗口`;
};

const buildWindowLabel = (window) => {
  const durationSeconds =
    isFiniteNumber(window.durationSeconds) && window.durationSeconds > 0
      ? window.durationSeconds
      : null;
  const kindLabel = WINDOW_KIND_LABELS.get(window.windowKind) ?? '';
  const preferKindLabel =
    window.windowMode === 'non_window' ||
    window.windowKind === 'billing' ||
    window.windowKind === 'payg' ||
    window.windowKind === 'product' ||
    window.windowKind === 'summary';
  const durationText = durationSeconds !== null ? durationLabel(durationSeconds) : '';
  let base = preferKindLabel ? kindLabel || durationText : durationText || kindLabel;
  if (!base) base = window.providerWindowId ? `${window.providerWindowId} 窗口` : '额度窗口';
  if (window.windowMode === 'rolling' && !base.startsWith('滚动')) base = `滚动 ${base}`;
  return `${base}${modelScopeLabelSuffix(window.modelScope)}`;
};

/* ------------------------------------------------------------------ */
/* 配额快照查询与窗口归一化                                             */
/* ------------------------------------------------------------------ */

const readOptionalNumber = (object, field, message) => {
  const value = object[field];
  if (value === undefined || value === null) return null;
  if (!isFiniteNumber(value)) throw malformed(message);
  return value;
};

const readRequiredNumber = (object, field, message) => {
  const value = object[field];
  if (!isFiniteNumber(value)) throw malformed(message);
  return value;
};

const readOptionalString = (object, field, message) => {
  const value = object[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw malformed(message);
  return value;
};

const normalizeCycle = (cycle, windowLabel) => {
  if (cycle === undefined || cycle === null) return null;
  if (!isRecord(cycle)) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的周期不是对象）。`);
  }
  const state = readOptionalString(cycle, 'state', `配额快照响应格式异常（${windowLabel}的周期缺少 state）。`);
  if (state === null || !state.trim()) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的周期缺少 state）。`);
  }
  const boundaryAccuracy = readOptionalString(
    cycle,
    'boundary_accuracy',
    `配额快照响应格式异常（${windowLabel}的周期 boundary_accuracy 无效）。`
  );
  if (boundaryAccuracy === null || !BOUNDARY_ACCURACIES.has(boundaryAccuracy)) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的周期 boundary_accuracy 无效）。`);
  }
  if (typeof cycle.forecast_eligible !== 'boolean') {
    throw malformed(`配额快照响应格式异常（${windowLabel}的周期缺少 forecast_eligible）。`);
  }
  return {
    id: readOptionalNumber(cycle, 'id', `配额快照响应格式异常（${windowLabel}的周期 id 无效）。`),
    activationId: readOptionalNumber(
      cycle,
      'activation_id',
      `配额快照响应格式异常（${windowLabel}的周期 activation_id 无效）。`
    ),
    state,
    scheduledStartMs: readOptionalNumber(
      cycle,
      'scheduled_start_ms',
      `配额快照响应格式异常（${windowLabel}的周期 scheduled_start_ms 无效）。`
    ),
    scheduledEndMs: readOptionalNumber(
      cycle,
      'scheduled_end_ms',
      `配额快照响应格式异常（${windowLabel}的周期 scheduled_end_ms 无效）。`
    ),
    actualStartMs: readRequiredNumber(
      cycle,
      'actual_start_ms',
      `配额快照响应格式异常（${windowLabel}的周期缺少 actual_start_ms）。`
    ),
    actualEndMs: readOptionalNumber(
      cycle,
      'actual_end_ms',
      `配额快照响应格式异常（${windowLabel}的周期 actual_end_ms 无效）。`
    ),
    durationSeconds: readOptionalNumber(
      cycle,
      'duration_seconds',
      `配额快照响应格式异常（${windowLabel}的周期 duration_seconds 无效）。`
    ),
    boundaryAccuracy,
    endReason: readOptionalString(
      cycle,
      'end_reason',
      `配额快照响应格式异常（${windowLabel}的周期 end_reason 无效）。`
    ) ?? '',
    parentCycleId: readOptionalNumber(
      cycle,
      'parent_cycle_id',
      `配额快照响应格式异常（${windowLabel}的周期 parent_cycle_id 无效）。`
    ),
    forecastEligible: cycle.forecast_eligible,
  };
};

const readFieldSourceObservedAt = (window, field, windowLabel) => {
  const sources = window.field_sources;
  if (sources === undefined || sources === null) return null;
  if (!isRecord(sources)) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的 field_sources 不是对象）。`);
  }
  const source = sources[field];
  if (source === undefined || source === null) return null;
  if (!isRecord(source)) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的 field_sources.${field} 不是对象）。`);
  }
  const observedAt = source.observed_at_ms;
  if (observedAt === undefined || observedAt === null) return null;
  if (!isFiniteNumber(observedAt)) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的 field_sources.${field}.observed_at_ms 无效）。`);
  }
  return observedAt;
};

const normalizeSnapshotWindow = (raw, account, nowMs) => {
  if (!isRecord(raw)) throw malformed('配额快照响应格式异常（窗口不是对象）。');
  const providerWindowId = typeof raw.provider_window_id === 'string' ? raw.provider_window_id.trim() : '';
  if (!providerWindowId) {
    throw malformed('配额快照响应格式异常（窗口缺少 provider_window_id）。');
  }
  const windowLabel = `窗口 ${providerWindowId}`;
  if (typeof raw.window_kind !== 'string') {
    throw malformed(`配额快照响应格式异常（${windowLabel}缺少 window_kind）。`);
  }
  if (typeof raw.window_mode !== 'string' || !WINDOW_MODES.has(raw.window_mode)) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的 window_mode 无效）。`);
  }
  if (typeof raw.boundary_accuracy !== 'string' || !BOUNDARY_ACCURACIES.has(raw.boundary_accuracy)) {
    throw malformed(`配额快照响应格式异常（${windowLabel}的 boundary_accuracy 无效）。`);
  }
  if (typeof raw.stale !== 'boolean') {
    throw malformed(`配额快照响应格式异常（${windowLabel}缺少 stale）。`);
  }
  const observedAtMs = readRequiredNumber(
    raw,
    'observed_at_ms',
    `配额快照响应格式异常（${windowLabel}缺少 observed_at_ms）。`
  );
  const windowKind = raw.window_kind.trim() || 'unknown';
  const modelScope = normalizeSnapshotModelScope(raw);
  const currentCycle = normalizeCycle(raw.current_cycle, windowLabel);
  const previousCycle = normalizeCycle(raw.previous_cycle, windowLabel);
  const availabilityValue = readOptionalString(
    raw,
    'availability',
    `配额快照响应格式异常（${windowLabel}的 availability 无效）。`
  );
  const availability = availabilityValue === null ? undefined : availabilityValue;

  const usedPercent = readOptionalNumber(
    raw,
    'used_percent',
    `配额快照响应格式异常（${windowLabel}的 used_percent 无效）。`
  );
  const cycleStartMs =
    currentCycle?.actualStartMs ??
    readOptionalNumber(raw, 'cycle_start_ms', `配额快照响应格式异常（${windowLabel}的 cycle_start_ms 无效）。`);
  const cycleEndMs =
    currentCycle?.scheduledEndMs ??
    readOptionalNumber(raw, 'cycle_end_ms', `配额快照响应格式异常（${windowLabel}的 cycle_end_ms 无效）。`);
  const durationSeconds =
    currentCycle?.durationSeconds ??
    readOptionalNumber(raw, 'duration_seconds', `配额快照响应格式异常（${windowLabel}的 duration_seconds 无效）。`);

  const quotaFieldObservedAt = readFieldSourceObservedAt(raw, 'quota', windowLabel);
  const quotaProgressObservedAtMs =
    usedPercent === null
      ? null
      : isPositiveFinite(quotaFieldObservedAt)
        ? quotaFieldObservedAt
        : isPositiveFinite(observedAtMs)
          ? observedAtMs
          : null;

  const hasLifecycle =
    raw.logical_window_id !== undefined ||
    raw.activation_generation !== undefined ||
    raw.availability !== undefined ||
    raw.current_cycle !== undefined ||
    raw.previous_cycle !== undefined;

  const stale =
    raw.stale === true ||
    ((raw.window_mode === 'fixed' || raw.window_mode === 'calendar') &&
      isFiniteNumber(cycleEndMs) &&
      cycleEndMs <= nowMs);

  const definition = {
    account,
    providerWindowId,
    windowKind,
    windowMode: raw.window_mode,
    modelScope,
    observedAtMs: isPositiveFinite(observedAtMs) ? observedAtMs : null,
    quotaProgressObservedAtMs,
    boundaryAccuracy: raw.boundary_accuracy,
    cycleStartMs: isFiniteNumber(cycleStartMs) ? cycleStartMs : null,
    cycleEndMs: isFiniteNumber(cycleEndMs) ? cycleEndMs : null,
    durationSeconds: isFiniteNumber(durationSeconds) ? durationSeconds : null,
    usedPercent,
    stale,
    availability,
    hasLifecycle,
    currentCycle,
    previousCycle,
    planType: normalizeString(raw.plan_type),
    requestable: isQueryableModelScope(modelScope),
  };
  definition.label = buildWindowLabel(definition);
  definition.windowKey = providerWindowId;
  return definition;
};

const snapshotScopeParts = (window) => {
  if (window.modelScope.complete === false) {
    return [window.providerWindowId, 'models', ''];
  }
  return [
    window.providerWindowId,
    window.modelScope.kind,
    window.modelScope.key,
    ...window.modelScope.models,
  ];
};

const snapshotDisplayKey = (window) =>
  [
    window.providerWindowId,
    'scope',
    ...snapshotScopeParts(window)
      .slice(1)
      .map((part) => encodeURIComponent(part || '-')),
  ].join('::');

const windowSortRank = (definition) => {
  if (definition.windowMode === 'non_window' || definition.windowMode === 'unknown') {
    return Number.MAX_SAFE_INTEGER;
  }
  return definition.durationSeconds ?? Number.MAX_SAFE_INTEGER - 1;
};

const compareWindowDefinitions = (left, right) => {
  const rank = windowSortRank(left) - windowSortRank(right);
  if (rank !== 0) return rank;
  const providerDiff = left.providerWindowId.localeCompare(right.providerWindowId);
  if (providerDiff !== 0) return providerDiff;
  return left.windowKey.localeCompare(right.windowKey);
};

const buildAccountWindowDefinitions = (account, rawWindows, nowMs) => {
  const definitions = rawWindows.map((raw) => normalizeSnapshotWindow(raw, account, nowMs));
  const counts = new Map();
  for (const definition of definitions) {
    counts.set(definition.providerWindowId, (counts.get(definition.providerWindowId) ?? 0) + 1);
  }
  const seenWindowKeys = new Set();
  for (const definition of definitions) {
    definition.windowKey =
      (counts.get(definition.providerWindowId) ?? 0) > 1
        ? snapshotDisplayKey(definition)
        : definition.providerWindowId;
    if (seenWindowKeys.has(definition.windowKey)) {
      throw malformed(`配额快照响应格式异常（账号「${account.name}」包含重复的窗口 ${definition.windowKey}）。`);
    }
    seenWindowKeys.add(definition.windowKey);
    definition.id = `${account.rowKey}${SELECTION_KEY_SEPARATOR}${definition.windowKey}`;
    definition.label = buildWindowLabel(definition);
  }
  definitions.sort(compareWindowDefinitions);
  return definitions;
};

const validateSnapshotItems = (data) => {
  if (!isRecord(data)) throw malformed('配额快照响应格式异常（不是 JSON 对象）。');
  if (!Array.isArray(data.items)) throw malformed('配额快照响应格式异常（缺少 items 数组）。');
  const parsed = [];
  for (const item of data.items) {
    if (!isRecord(item)) throw malformed('配额快照响应格式异常（账号条目不是对象）。');
    if (typeof item.row_key !== 'string' || !item.row_key.trim()) {
      throw malformed('配额快照响应格式异常（账号条目缺少 row_key）。');
    }
    let windows;
    if (item.windows === undefined || item.windows === null) windows = [];
    else if (Array.isArray(item.windows)) windows = item.windows;
    else throw malformed('配额快照响应格式异常（账号条目的 windows 不是数组）。');
    parsed.push({ rowKey: item.row_key, windows });
  }
  return parsed;
};

const querySnapshots = async (baseUrl, key, accounts, warnings) => {
  const payloadAccounts = accounts.map((account) => ({
    row_key: account.rowKey,
    provider: account.provider,
    account: buildIdentityPayload(account),
  }));

  const items = [];
  for (let index = 0; index < payloadAccounts.length; index += SNAPSHOT_ACCOUNT_BATCH_SIZE) {
    const batch = payloadAccounts.slice(index, index + SNAPSHOT_ACCOUNT_BATCH_SIZE);
    const data = await requestJson({
      baseUrl,
      route: SNAPSHOT_QUERY_ROUTE,
      method: 'POST',
      label: '配额快照',
      key,
      body: { accounts: batch, include_inactive: true },
      parseFailureMessage: '配额快照返回了无法解析的 JSON。',
    });
    items.push(...validateSnapshotItems(data));
  }

  const byRowKey = new Map();
  const requestedRowKeys = new Set(payloadAccounts.map((account) => account.row_key));
  let unexpected = 0;
  for (const item of items) {
    if (!requestedRowKeys.has(item.rowKey)) {
      unexpected += 1;
      continue;
    }
    if (byRowKey.has(item.rowKey)) {
      throw malformed('配额快照响应格式异常（同一个账号返回了重复的条目）。');
    }
    byRowKey.set(item.rowKey, item);
  }
  if (unexpected > 0) {
    warnings.push(`配额快照响应包含 ${unexpected} 个未请求的账号条目，已忽略。`);
  }
  return byRowKey;
};

/* ------------------------------------------------------------------ */
/* 窗口用量查询                                                         */
/* ------------------------------------------------------------------ */

const toRequestModelScope = (scope) => {
  const request = { kind: scope.kind, complete: scope.complete !== false };
  if (scope.key) request.key = scope.key;
  if (scope.models.length > 0) request.models = scope.models;
  return request;
};

const validateUsageItems = (data) => {
  if (!isRecord(data)) throw malformed('窗口用量响应格式异常（不是 JSON 对象）。');
  if (!Array.isArray(data.items)) throw malformed('窗口用量响应格式异常（缺少 items 数组）。');
  const items = [];
  for (const item of data.items) {
    if (!isRecord(item)) throw malformed('窗口用量响应格式异常（条目不是对象）。');
    if (typeof item.request_key !== 'string' || !item.request_key.trim()) {
      throw malformed('窗口用量响应格式异常（条目缺少 request_key）。');
    }
    if (typeof item.row_key !== 'string' || !item.row_key.trim()) {
      throw malformed('窗口用量响应格式异常（条目缺少 row_key）。');
    }
    if (!isFiniteNumber(item.from_ms) || !isFiniteNumber(item.to_ms)) {
      throw malformed('窗口用量响应格式异常（条目缺少有效的 from_ms/to_ms）。');
    }
    if (typeof item.matched !== 'boolean') {
      throw malformed('窗口用量响应格式异常（条目缺少 matched）。');
    }
    for (const field of ['total_requests', 'total_tokens', 'total_cost']) {
      if (!isFiniteNumber(item[field])) {
        throw malformed(`窗口用量响应格式异常（条目的 ${field} 不是有效数字）。`);
      }
    }
    if (item.last_seen_ms !== null && item.last_seen_ms !== undefined && !isFiniteNumber(item.last_seen_ms)) {
      throw malformed('窗口用量响应格式异常（条目的 last_seen_ms 无效）。');
    }
    const scopeMatchStatus =
      typeof item.scope_match_status === 'string' && item.scope_match_status.trim()
        ? item.scope_match_status.trim()
        : 'complete';
    items.push({
      requestKey: item.request_key,
      rowKey: item.row_key,
      fromMs: item.from_ms,
      toMs: item.to_ms,
      period: typeof item.period === 'string' && item.period.trim() ? item.period.trim() : 'current',
      matched: item.matched,
      requests: item.total_requests,
      tokens: item.total_tokens,
      cost: item.total_cost,
      lastSeenMs: isFiniteNumber(item.last_seen_ms) ? item.last_seen_ms : null,
      scopeMatchStatus,
    });
  }
  return items;
};

const queryWindowUsage = async (baseUrl, key, targets) => {
  const items = [];
  for (let index = 0; index < targets.length; index += WINDOW_USAGE_BATCH_SIZE) {
    const batch = targets.slice(index, index + WINDOW_USAGE_BATCH_SIZE).map((entry) => entry.target);
    const data = await requestJson({
      baseUrl,
      route: WINDOW_USAGE_ROUTE,
      method: 'POST',
      label: '窗口用量',
      key,
      body: { windows: batch },
      parseFailureMessage: '窗口用量返回了无法解析的 JSON。',
    });
    items.push(...validateUsageItems(data));
  }

  const byRequestKey = new Map();
  for (const item of items) {
    if (byRequestKey.has(item.requestKey)) {
      throw malformed('窗口用量响应格式异常（同一个请求标识返回了重复条目）。');
    }
    byRequestKey.set(item.requestKey, item);
  }
  return byRequestKey;
};

const summarizeUsage = (expected, usageByRequestKey) => {
  if (!expected) return null;
  const item = usageByRequestKey.get(expected.requestKey);
  if (!item) return { summary: null, missing: true, mismatch: false };
  if (
    item.rowKey !== expected.target.row_key ||
    item.fromMs !== expected.fromMs ||
    item.toMs !== expected.toMs ||
    item.period !== expected.period
  ) {
    return { summary: null, missing: false, mismatch: true };
  }
  return {
    summary: {
      matched: item.matched === true,
      scopeMatchStatus: item.scopeMatchStatus,
      requests: item.requests,
      tokens: item.tokens,
      cost: item.cost,
      lastSeenMs: isPositiveFinite(item.lastSeenMs) ? item.lastSeenMs : null,
    },
    missing: false,
    mismatch: false,
  };
};

const dedupeWarnings = (warnings) => Array.from(new Set(warnings.filter(Boolean)));

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读取一次只读快照。
 * @param {{ baseUrl: string, key: string }} input
 * @returns {Promise<{ generatedAtMs: number, rows: object[], warnings: string[], sourceLabel: string }>}
 */
export async function fetchSnapshot({ baseUrl, key } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const managementKey = normalizeManagementKey(key);
  const nowMs = Date.now();
  const warnings = [];

  await readManagerInfo(normalized.baseUrl);

  const files = await readAuthFiles(normalized.baseUrl, managementKey);
  const accounts = buildAccounts(files, warnings);

  if (accounts.length === 0) {
    warnings.push(
      files.length === 0
        ? '账号清单为空，未读取配额快照。'
        : '没有可查询的账号（均缺少提供商或凭证标识），未读取配额快照。'
    );
    return {
      generatedAtMs: nowMs,
      rows: [],
      warnings: dedupeWarnings(warnings),
      sourceLabel: normalized.sourceLabel,
    };
  }

  const snapshotsByRowKey = await querySnapshots(normalized.baseUrl, managementKey, accounts, warnings);

  const definitionsByAccount = new Map();
  for (const account of accounts) {
    const item = snapshotsByRowKey.get(account.rowKey);
    if (!item || item.windows.length === 0) {
      warnings.push(`账号「${account.name}」暂无配额快照数据（需由上游面板采集后写入）。`);
      definitionsByAccount.set(account.rowKey, []);
      continue;
    }
    const definitions = buildAccountWindowDefinitions(account, item.windows, nowMs);
    definitionsByAccount.set(account.rowKey, definitions);
  }

  const allDefinitions = [];
  for (const account of accounts) {
    const definitions = definitionsByAccount.get(account.rowKey) ?? [];
    const accountPlan = definitions.find((definition) => definition.planType)?.planType ?? '';
    for (const definition of definitions) {
      definition.accountPlan = accountPlan;
      allDefinitions.push(definition);
    }
  }

  const targetEntries = [];
  const entriesByWindowId = new Map();
  const seenRequestKeys = new Set();
  let incompleteScopeWindows = 0;

  for (const definition of allDefinitions) {
    if (!definition.requestable) {
      incompleteScopeWindows += 1;
      entriesByWindowId.set(definition.id, { current: null, previous: null });
      continue;
    }
    const ranges = buildWindowUsageRanges(definition, nowMs);
    const windowEntries = { current: null, previous: null };
    for (const range of ranges) {
      const requestKey = buildUsageRequestKey(
        definition.account.rowKey,
        definition.providerWindowId,
        range.period,
        definition.modelScope
      );
      if (seenRequestKeys.has(requestKey)) {
        throw new AdapterError('内部错误：窗口用量请求标识重复。');
      }
      seenRequestKeys.add(requestKey);
      const entry = {
        target: {
          request_key: requestKey,
          row_key: definition.account.rowKey,
          window_key: definition.windowKey,
          provider_window_id: definition.providerWindowId,
          period: range.period,
          from_ms: range.fromMs,
          to_ms: range.toMs,
          model_scope: toRequestModelScope(definition.modelScope),
          ...buildIdentityPayload(definition.account),
        },
        period: range.period,
        fromMs: range.fromMs,
        toMs: range.toMs,
        requestKey,
      };
      targetEntries.push(entry);
      if (range.period === 'current') windowEntries.current = entry;
      else windowEntries.previous = entry;
    }
    entriesByWindowId.set(definition.id, windowEntries);
  }

  if (incompleteScopeWindows > 0) {
    warnings.push(`有 ${incompleteScopeWindows} 个窗口的模型范围无法确定，未查询用量。`);
  }

  const usageByRequestKey = targetEntries.length
    ? await queryWindowUsage(normalized.baseUrl, managementKey, targetEntries)
    : new Map();

  let missingUsage = 0;
  let mismatchedUsage = 0;
  let emptyUsage = 0;
  let partialScopeUsage = 0;
  const rows = [];

  for (const definition of allDefinitions) {
    const entries = entriesByWindowId.get(definition.id) ?? { current: null, previous: null };
    const currentResult = summarizeUsage(entries.current, usageByRequestKey);
    const previousResult = summarizeUsage(entries.previous, usageByRequestKey);
    if (currentResult?.missing) missingUsage += 1;
    if (previousResult?.missing) missingUsage += 1;
    if (currentResult?.mismatch) mismatchedUsage += 1;
    if (previousResult?.mismatch) mismatchedUsage += 1;
    if (currentResult?.summary) {
      if (currentResult.summary.matched !== true) emptyUsage += 1;
      else if (currentResult.summary.scopeMatchStatus !== 'complete') partialScopeUsage += 1;
    }

    const resolution = resolveWindowForecast({
      window: definition,
      currentUsage: currentResult?.summary ?? null,
      previousUsage: previousResult?.summary ?? null,
    });

    rows.push({
      id: definition.id,
      accountId: definition.account.rowKey,
      accountName: definition.account.displayName,
      provider: definition.account.provider,
      plan: definition.planType || definition.accountPlan || '',
      windowLabel: definition.label,
      windowMode: definition.windowMode,
      startMs: definition.cycleStartMs,
      endMs: definition.cycleEndMs,
      usedPercent: definition.usedPercent,
      observedAtMs: definition.quotaProgressObservedAtMs ?? definition.observedAtMs,
      stale: definition.stale,
      current: resolution.current,
      previous: resolution.previous,
      forecast: resolution.forecast,
      unavailableReason: resolution.reason,
    });
  }

  if (missingUsage > 0) warnings.push(`有 ${missingUsage} 个窗口用量请求未返回结果。`);
  if (mismatchedUsage > 0) {
    warnings.push(`有 ${mismatchedUsage} 个窗口返回的用量区间与请求不一致，已忽略。`);
  }
  if (emptyUsage > 0) warnings.push(`有 ${emptyUsage} 个窗口没有匹配到监控用量。`);
  if (partialScopeUsage > 0) {
    warnings.push(`有 ${partialScopeUsage} 个窗口的用量仅部分匹配模型范围。`);
  }
  if (rows.length === 0) warnings.push('未读取到任何配额窗口。');

  return {
    generatedAtMs: nowMs,
    rows,
    warnings: dedupeWarnings(warnings),
    sourceLabel: normalized.sourceLabel,
  };
}

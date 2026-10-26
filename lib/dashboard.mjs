/**
 * HTTP 公开数据投影（仅服务端使用，绝不进入前端 bundle）。
 *
 * GET /api/snapshot 的唯一出口：显式白名单 DTO，只挑选公开字段并逐层重建对象，
 * 绝不展开内部领域对象。账号标识、诊断信息、上游原始元数据与原始错误文本
 * 都不会出现在响应中。
 *
 * 公开契约：
 *   Snapshot  = { generatedAtMs, rows: WindowRow[] }
 *   WindowRow = { windowLabel, windowMode, startMs, endMs, usedPercent, observedAtMs,
 *                 stale, current, previous, forecast, unavailableReason }
 *   Usage     = { requests, tokens, cost, lastSeenMs }
 *   Forecast  = { requests, tokens, cost, basis: 'quota' | 'previous' }
 */

const WINDOW_MODES = new Set(['fixed', 'calendar', 'rolling', 'non_window', 'unknown']);
const FORECAST_BASES = new Set(['quota', 'previous']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** 只挑选 Usage 的四个公开字段；结构不完整时整体置为 null，绝不用 0 伪造。 */
const toUsage = (value) => {
  if (!isRecord(value)) return null;
  const requests = finiteOrNull(value.requests);
  const tokens = finiteOrNull(value.tokens);
  const cost = finiteOrNull(value.cost);
  if (requests === null || tokens === null || cost === null) return null;
  return { requests, tokens, cost, lastSeenMs: finiteOrNull(value.lastSeenMs) };
};

/** 只挑选 Forecast 的四个公开字段，basis 必须是固定枚举。 */
const toForecast = (value) => {
  if (!isRecord(value)) return null;
  const requests = finiteOrNull(value.requests);
  const tokens = finiteOrNull(value.tokens);
  const cost = finiteOrNull(value.cost);
  const basis = typeof value.basis === 'string' && FORECAST_BASES.has(value.basis) ? value.basis : null;
  if (requests === null || tokens === null || cost === null || basis === null) return null;
  return { requests, tokens, cost, basis };
};

const toWindowRow = (value) => {
  if (!isRecord(value)) throw new TypeError('Invalid window data.');
  const row = value;
  return {
    windowLabel: typeof row.windowLabel === 'string' && row.windowLabel.trim() ? row.windowLabel : '额度窗口',
    windowMode: typeof row.windowMode === 'string' && WINDOW_MODES.has(row.windowMode) ? row.windowMode : 'unknown',
    startMs: finiteOrNull(row.startMs),
    endMs: finiteOrNull(row.endMs),
    usedPercent: finiteOrNull(row.usedPercent),
    observedAtMs: finiteOrNull(row.observedAtMs),
    stale: row.stale === true,
    current: toUsage(row.current),
    previous: toUsage(row.previous),
    forecast: toForecast(row.forecast),
    unavailableReason: typeof row.unavailableReason === 'string' ? row.unavailableReason : '',
  };
};

/**
 * 把内部适配器结果投影为公开快照。
 * @param {{ generatedAtMs?: unknown, rows?: unknown }} [snapshot]
 * @returns {{ generatedAtMs: number, rows: ReturnType<typeof toWindowRow>[] }}
 */
export function toDashboardSnapshot(snapshot) {
  const generatedAtMs = finiteOrNull(snapshot?.generatedAtMs);
  if (generatedAtMs === null || !Array.isArray(snapshot?.rows)) {
    throw new TypeError('Invalid snapshot data.');
  }
  return {
    generatedAtMs,
    rows: snapshot.rows.map(toWindowRow),
  };
}

/**
 * 把适配器异常折叠为固定安全文案，绝不转发 error.message 或上游响应体。
 * 仅依据 AdapterError.status 分类；其余情况返回通用文案。
 */
export function toPublicFailureMessage(error) {
  const status = finiteOrNull(error?.status);
  if (status === 401 || status === 403) return '上游管理接口拒绝访问（认证失败），请检查服务端配置后重试。';
  if (status === 404) return '上游管理接口不存在，请确认实例地址与版本。';
  if (status === 429) return '上游请求过于频繁，已被限流，请稍后重试。';
  if (status !== null && status >= 500 && status <= 599) return '上游服务暂时不可用，读取实例失败。';
  return '读取实例失败。';
}

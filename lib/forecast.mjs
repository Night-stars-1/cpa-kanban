/**
 * 当前窗口预测（纯函数）。
 *
 * 语义移植自 cpa-manager-plus (MIT, Copyright (c) 2026 Seakee)：
 * - apps/web/src/features/accounts/model/estimateWindowUsage.ts
 * - apps/web/src/features/accounts/model/accountQuotaWindowUsagePresentation.ts
 * - apps/web/src/features/accounts/model/accountQuotaWindowDefinitions.ts
 *
 * 这里只做纯计算：不访问网络、不读写文件、不做缓存。
 */

export const FORECAST_COST_EPSILON = 1e-9;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isNonNegativeFinite = (value) => isFiniteNumber(value) && value >= 0;
const isPositiveFinite = (value) => isFiniteNumber(value) && value > 0;

export const isReliableBoundary = (accuracy) => accuracy === 'exact' || accuracy === 'derived';

export const isUsableMetrics = (metrics) =>
  metrics !== null &&
  metrics !== undefined &&
  isNonNegativeFinite(metrics.requests) &&
  isNonNegativeFinite(metrics.tokens) &&
  isNonNegativeFinite(metrics.cost);

const hasUsage = (metrics) => metrics.requests > 0 || metrics.tokens > 0 || metrics.cost > 0;

const roundForecastCost = (value) => {
  const scaled = value * 100;
  return Number.isFinite(scaled) ? Math.round(scaled) / 100 : value;
};

/**
 * 上游 estimateWindowUsage 的逐行移植。
 * 返回 { requests, tokens, cost, basis } 或 null。
 */
export const estimateWindowUsage = (input) => {
  const current = input?.current ?? null;
  const previous = input?.previous ?? null;
  const usedPercent = input?.usedPercent ?? null;
  const hasCurrentUsage = isUsableMetrics(current) && hasUsage(current);
  const hasQuotaProgress = isFiniteNumber(usedPercent) && usedPercent > 0 && usedPercent <= 100;
  if (hasCurrentUsage && hasQuotaProgress) {
    const multiplier = 100 / usedPercent;
    const forecast = {
      requests: Math.max(current.requests, Math.round(current.requests * multiplier)),
      tokens: Math.max(current.tokens, Math.round(current.tokens * multiplier)),
      cost: Math.max(current.cost, roundForecastCost(current.cost * multiplier)),
      basis: 'quota',
    };
    if (
      Number.isFinite(multiplier) &&
      Number.isFinite(forecast.requests) &&
      Number.isFinite(forecast.tokens) &&
      Number.isFinite(forecast.cost)
    ) {
      return forecast;
    }
  }
  if (isUsableMetrics(previous)) {
    return { ...previous, basis: 'previous' };
  }
  return null;
};

export const hasLifecycleEvidence = (window) =>
  window?.availability !== undefined ||
  window?.currentCycle !== undefined ||
  window?.previousCycle !== undefined;

const isValidUsageRange = (range) =>
  isFiniteNumber(range.fromMs) &&
  isFiniteNumber(range.toMs) &&
  range.fromMs > 0 &&
  range.fromMs < range.toMs;

/**
 * 上游 buildAccountQuotaUsageRanges 的移植。
 *
 * window 为适配器归一化后的窗口定义：
 * { windowMode, durationSeconds, stale, availability, boundaryAccuracy,
 *   cycleStartMs, cycleEndMs, currentCycle, previousCycle, hasLifecycle }
 * 周期对象使用 camelCase（actualStartMs/actualEndMs/scheduledEndMs/...）。
 */
export const buildWindowUsageRanges = (window, nowMs = Date.now()) => {
  const durationSeconds = isFiniteNumber(window?.durationSeconds) ? window.durationSeconds : 0;
  const durationMs = durationSeconds * 1000;
  if (
    !isFiniteNumber(durationSeconds) ||
    !isFiniteNumber(durationMs) ||
    !isFiniteNumber(durationMs * 2) ||
    durationMs <= 0
  ) {
    return [];
  }

  if (window.windowMode === 'rolling') {
    return [
      { period: 'current', fromMs: nowMs - durationMs, toMs: nowMs },
      { period: 'previous_equal_range', fromMs: nowMs - 2 * durationMs, toMs: nowMs - durationMs },
    ].filter(isValidUsageRange);
  }

  if (window.windowMode !== 'fixed' && window.windowMode !== 'calendar') {
    return [];
  }

  if (window.hasLifecycle === true) {
    const ranges = [];
    const currentCycle = window.currentCycle ?? null;
    const currentEndMs =
      currentCycle?.scheduledEndMs ??
      (isReliableBoundary(window.boundaryAccuracy) ? window.cycleEndMs : null);
    if (
      currentCycle &&
      window.stale !== true &&
      (window.availability === undefined || window.availability === 'active') &&
      currentCycle.state === 'active' &&
      currentCycle.actualEndMs === null &&
      isReliableBoundary(currentCycle.boundaryAccuracy) &&
      isFiniteNumber(currentCycle.actualStartMs) &&
      isFiniteNumber(currentEndMs)
    ) {
      ranges.push({
        period: 'current',
        fromMs: currentCycle.actualStartMs,
        toMs: Math.min(nowMs, currentEndMs),
      });
    }

    const previousCycle = window.previousCycle ?? null;
    if (
      previousCycle &&
      isReliableBoundary(previousCycle.boundaryAccuracy) &&
      isFiniteNumber(previousCycle.actualStartMs) &&
      isFiniteNumber(previousCycle.actualEndMs) &&
      previousCycle.actualStartMs < previousCycle.actualEndMs
    ) {
      ranges.push({
        period: 'previous',
        fromMs: previousCycle.actualStartMs,
        toMs: previousCycle.actualEndMs,
      });
    }

    return ranges.filter(isValidUsageRange);
  }

  if (
    !isReliableBoundary(window.boundaryAccuracy) ||
    window.stale === true ||
    !isFiniteNumber(window.cycleStartMs) ||
    !isFiniteNumber(window.cycleEndMs)
  ) {
    return [];
  }

  const currentEnd = Math.min(nowMs, window.cycleEndMs);
  const ranges = [];
  if (window.cycleStartMs < currentEnd) {
    ranges.push({ period: 'current', fromMs: window.cycleStartMs, toMs: currentEnd });
  }
  ranges.push({
    period: 'previous',
    fromMs: window.cycleStartMs - durationMs,
    toMs: window.cycleStartMs,
  });
  return ranges.filter(isValidUsageRange);
};

const metricsTriple = (usage) => ({
  requests: usage.requests,
  tokens: usage.tokens,
  cost: usage.cost,
});

const trustedUsage = (usage) =>
  usage && usage.matched === true && usage.scopeMatchStatus === 'complete' && isUsableMetrics(usage)
    ? {
        requests: usage.requests,
        tokens: usage.tokens,
        cost: usage.cost,
        lastSeenMs: isPositiveFinite(usage.lastSeenMs) ? usage.lastSeenMs : null,
      }
    : null;

/**
 * 上游 resolveAccountQuotaWindowUsageAndForecast 的移植（单窗口）。
 *
 * usage: { matched, scopeMatchStatus, requests, tokens, cost, lastSeenMs }
 * 返回：
 * - forecast: 列表可见的预测（上游列表要求存在可信当前实际用量）
 * - detailForecast: 未加“列表可见”限制的预测（详情语义）
 * - current / previous: 可展示的可信用量（不可信时为 null，绝不用 0 伪造）
 * - hasTrustedCurrentActual
 * - reason: 当 forecast 为 null 时的中文原因，否则 ''
 * - reasons: 全部诊断原因
 */
export const resolveWindowForecast = ({ window, currentUsage = null, previousUsage = null }) => {
  const hasLifecycle = window?.hasLifecycle === true;
  const modelScope = window?.modelScope ?? null;
  const scopeAllowsUsage = modelScope?.complete !== false;
  const lifecycleActive = window?.availability === undefined || window?.availability === 'active';
  const currentEligible = window?.currentCycle ? window.currentCycle.forecastEligible === true : !hasLifecycle;
  const previousEligible = window?.previousCycle
    ? window.previousCycle.forecastEligible === true
    : !hasLifecycle;
  const canForecastCurrentWindow =
    !hasLifecycle || (currentEligible && window?.stale !== true);
  const boundaryReliable = window?.currentCycle
    ? isReliableBoundary(window.currentCycle.boundaryAccuracy)
    : isReliableBoundary(window?.boundaryAccuracy);
  const previousBoundaryReliable = window?.previousCycle
    ? isReliableBoundary(window.previousCycle.boundaryAccuracy)
    : isReliableBoundary(window?.boundaryAccuracy);

  const quotaProgressObservedAtMs = isPositiveFinite(window?.quotaProgressObservedAtMs)
    ? window.quotaProgressObservedAtMs
    : null;
  const usedPercent = isFiniteNumber(window?.usedPercent) ? window.usedPercent : null;
  const hasReliableQuotaProgress = usedPercent !== null && quotaProgressObservedAtMs !== null;

  const hasReliableCurrentUsage =
    currentUsage?.matched === true &&
    currentUsage.scopeMatchStatus === 'complete' &&
    currentEligible;
  const currentUsageAheadOfQuotaProgressObservation =
    hasReliableCurrentUsage &&
    hasReliableQuotaProgress &&
    currentUsage.lastSeenMs !== null &&
    currentUsage.lastSeenMs > quotaProgressObservedAtMs;
  const currentForecastUsage =
    hasReliableCurrentUsage &&
    hasReliableQuotaProgress &&
    currentUsage.lastSeenMs !== null &&
    currentUsage.lastSeenMs <= quotaProgressObservedAtMs
      ? metricsTriple(currentUsage)
      : null;

  const forecastModeAllowed = window?.windowMode === 'fixed' || window?.windowMode === 'calendar';
  const cycleBoundsKnown =
    isFiniteNumber(window?.cycleStartMs) && isFiniteNumber(window?.cycleEndMs);

  const forecast =
    scopeAllowsUsage &&
    lifecycleActive &&
    canForecastCurrentWindow &&
    window?.stale !== true &&
    boundaryReliable &&
    forecastModeAllowed &&
    cycleBoundsKnown
      ? estimateWindowUsage({
          usedPercent,
          current: currentForecastUsage,
          previous:
            !currentUsageAheadOfQuotaProgressObservation &&
            previousEligible &&
            previousBoundaryReliable &&
            previousUsage?.matched === true &&
            previousUsage.scopeMatchStatus === 'complete' &&
            isUsableMetrics(previousUsage)
              ? metricsTriple(previousUsage)
              : null,
        })
      : null;

  const trustedCurrentActual = trustedUsage(currentUsage);
  const trustedPreviousActual = trustedUsage(previousUsage);
  const forecastIsConsistentWithCurrentActual =
    forecast === null ||
    trustedCurrentActual === null ||
    (forecast.requests >= trustedCurrentActual.requests &&
      forecast.tokens >= trustedCurrentActual.tokens &&
      forecast.cost + FORECAST_COST_EPSILON >= trustedCurrentActual.cost);

  const detailForecast = forecastIsConsistentWithCurrentActual ? forecast : null;
  const hasTrustedCurrentActual = trustedCurrentActual !== null;
  // 上游列表（AccountsPage）只在存在可信当前实际用量时展示预测值。
  const listForecast = hasTrustedCurrentActual ? detailForecast : null;

  const reasons = [];
  if (!scopeAllowsUsage) {
    reasons.push('模型范围无法确定，未查询用量与预测。');
  }
  if (!lifecycleActive) {
    reasons.push(
      window.availability === 'pending_absent'
        ? 'Provider 尚未确认该窗口，暂不可用。'
        : window.availability === 'inactive'
          ? '该窗口已停用。'
          : `该窗口当前不可用（${String(window.availability)}）。`
    );
  }
  if (window?.stale === true) {
    reasons.push('额度快照已过期，请刷新后再参考。');
  }
  if (!forecastModeAllowed) {
    reasons.push('仅固定或日历周期窗口支持预测。');
  }
  if (!boundaryReliable) {
    reasons.push('周期边界无法可靠确定，未生成预测。');
  }
  if (hasLifecycle && !currentEligible) {
    reasons.push('当前周期不满足预测条件（缺少可靠结束时间或非正常到期）。');
  }
  if (hasLifecycle && window?.currentCycle && window.currentCycle.state !== 'active') {
    reasons.push('当前周期不在进行中。');
  }
  if (!cycleBoundsKnown) {
    reasons.push('缺少当前周期的起止时间，未生成预测。');
  }
  if (!hasReliableQuotaProgress) {
    reasons.push('缺少已用比例或额度观测时间，无法按额度比例预测。');
  }
  if (currentUsageAheadOfQuotaProgressObservation) {
    reasons.push('当前用量晚于额度观测时间，无法按额度比例预测。');
  }
  if (currentUsage === null) {
    reasons.push('当前窗口没有可查询的用量区间。');
  } else if (currentUsage.matched !== true) {
    reasons.push('当前窗口没有匹配到监控用量。');
  } else if (currentUsage.scopeMatchStatus !== 'complete') {
    reasons.push('当前窗口用量仅部分匹配模型范围。');
  }

  let reason = '';
  if (listForecast === null) {
    if (forecast !== null && detailForecast === null) {
      reason = '预测结果小于当前实际用量，已丢弃。';
    } else if (detailForecast !== null && !hasTrustedCurrentActual) {
      reason = '当前窗口缺少可信实际用量，预测不在列表展示。';
    } else {
      reason = reasons[0] ?? '缺少可信的当前窗口实际用量，预测不展示。';
    }
  }

  return {
    forecast: listForecast,
    detailForecast,
    current: trustedCurrentActual,
    previous: trustedPreviousActual,
    hasTrustedCurrentActual,
    reason,
    reasons,
  };
};

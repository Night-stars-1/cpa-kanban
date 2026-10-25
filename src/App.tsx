import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Coins,
  Database,
  Download,
  Gauge,
  HelpCircle,
  Info,
  ListFilter,
  RefreshCw,
  ShieldAlert,
  Target,
  TrendingUp,
  X,
} from 'lucide-react';
import type { Forecast, Snapshot, Usage, WindowRow } from './contracts';
import { Select } from './components/Select';

type ModalKind = 'methodology' | null;
type MetricKey = 'requests' | 'tokens' | 'cost';
type AutoRefreshValue = 'off' | '30' | '60';

const PAGE_SIZE = 7;
const AUTO_REFRESH_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: '30', label: '30 秒' },
  { value: '60', label: '60 秒' },
];
const EMPTY_SNAPSHOT: Snapshot = {
  generatedAtMs: 0,
  rows: [],
  warnings: [],
  sourceLabel: '',
};

const CHART_METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: 'requests', label: '请求' },
  { key: 'tokens', label: 'Token' },
  { key: 'cost', label: '成本' },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isFiniteNumber(value) ? value : undefined;
}

function parseUsage(value: unknown, path: string): Usage | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} 不是有效的用量对象。`);
  }

  const candidate = value as Partial<Usage>;
  if (
    !isFiniteNumber(candidate.requests) ||
    !isFiniteNumber(candidate.tokens) ||
    !isFiniteNumber(candidate.cost) ||
    (candidate.lastSeenMs !== null && !isFiniteNumber(candidate.lastSeenMs))
  ) {
    throw new Error(`${path} 缺少有效的 requests / tokens / cost。`);
  }

  return {
    requests: candidate.requests,
    tokens: candidate.tokens,
    cost: candidate.cost,
    lastSeenMs: candidate.lastSeenMs ?? null,
  };
}

function parseForecast(value: unknown, path: string): Forecast | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} 不是有效的预测对象。`);
  }

  const candidate = value as Partial<Forecast>;
  const basis = candidate.basis;
  if (
    !isFiniteNumber(candidate.requests) ||
    !isFiniteNumber(candidate.tokens) ||
    !isFiniteNumber(candidate.cost) ||
    (basis !== 'quota' && basis !== 'previous')
  ) {
    throw new Error(`${path} 缺少有效的预测值或 basis。`);
  }

  return {
    requests: candidate.requests,
    tokens: candidate.tokens,
    cost: candidate.cost,
    basis,
  };
}

function parseWindowRow(value: unknown, index: number): WindowRow {
  const path = `rows[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`实例返回的 ${path} 不是有效对象。`);
  }

  const candidate = value as Partial<WindowRow>;
  const {
    id,
    accountId,
    accountName,
    provider,
    plan,
    windowLabel,
    windowMode,
    startMs,
    endMs,
    usedPercent,
    observedAtMs,
    stale,
    unavailableReason,
  } = candidate;

  if (
    typeof id !== 'string' ||
    typeof accountId !== 'string' ||
    typeof accountName !== 'string' ||
    typeof provider !== 'string' ||
    typeof plan !== 'string' ||
    typeof windowLabel !== 'string' ||
    typeof windowMode !== 'string' ||
    typeof stale !== 'boolean' ||
    typeof unavailableReason !== 'string'
  ) {
    throw new Error(`实例返回的 ${path} 缺少必需的字符串或布尔字段。`);
  }

  const normalizedStartMs = nullableNumber(startMs);
  const normalizedEndMs = nullableNumber(endMs);
  const normalizedUsedPercent = nullableNumber(usedPercent);
  const normalizedObservedAtMs = nullableNumber(observedAtMs);

  if (
    normalizedStartMs === undefined ||
    normalizedEndMs === undefined ||
    normalizedUsedPercent === undefined ||
    normalizedObservedAtMs === undefined
  ) {
    throw new Error(`实例返回的 ${path} 含无效的时间或额度字段。`);
  }

  return {
    id,
    accountId,
    accountName,
    provider,
    plan,
    windowLabel,
    windowMode,
    startMs: normalizedStartMs,
    endMs: normalizedEndMs,
    usedPercent: normalizedUsedPercent,
    observedAtMs: normalizedObservedAtMs,
    stale,
    current: parseUsage(candidate.current, `${path}.current`),
    previous: parseUsage(candidate.previous, `${path}.previous`),
    forecast: parseForecast(candidate.forecast, `${path}.forecast`),
    unavailableReason,
  };
}

function parseSnapshot(payload: unknown): Snapshot {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error('服务端返回的数据不是 Snapshot 对象。');
  }

  const raw = payload as Partial<Snapshot>;
  if (!isFiniteNumber(raw.generatedAtMs)) {
    throw new Error('服务端返回的数据缺少 generatedAtMs。');
  }
  if (!Array.isArray(raw.rows)) {
    throw new Error('服务端返回的数据缺少 rows 数组。');
  }
  if (
    !Array.isArray(raw.warnings) ||
    !raw.warnings.every((item) => typeof item === 'string')
  ) {
    throw new Error('服务端返回的数据缺少 warnings 字符串数组。');
  }
  if (typeof raw.sourceLabel !== 'string') {
    throw new Error('服务端返回的数据缺少 sourceLabel。');
  }

  const rows = raw.rows.map((row, index) => parseWindowRow(row, index));
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (seenIds.has(row.id)) {
      throw new Error(`服务端返回了重复的窗口 id：${row.id}。`);
    }
    seenIds.add(row.id);
  }

  return {
    generatedAtMs: raw.generatedAtMs,
    rows,
    warnings: raw.warnings,
    sourceLabel: raw.sourceLabel,
  };
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') {
    const text = payload.trim();
    return text ? text.slice(0, 400) : fallback;
  }
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const { error } = payload as { error?: unknown };
    if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 400);
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return error.name === 'AbortError';
  }
  return false;
}

const MISSING_CONFIG_HINT = '请在项目根目录 .env 中配置服务端环境变量后重启看板服务。';

async function fetchSnapshot(signal: AbortSignal): Promise<Snapshot> {
  let response: Response;

  try {
    response = await fetch('/api/snapshot', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const detail = error instanceof Error ? error.message : '网络错误';
    throw new Error(`无法访问看板接口 /api/snapshot：${detail}`);
  }

  const raw = await response.text();
  let payload: unknown = raw;

  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      payload = raw;
    }
  }

  if (!response.ok) {
    const message =
      response.status === 503
        ? extractErrorMessage(
            payload,
            `服务端缺少 CPA Manager Plus 配置（HTTP 503）。${MISSING_CONFIG_HINT}`,
          )
        : extractErrorMessage(payload, `读取快照失败（HTTP ${response.status}）。`);
    throw new Error(
      response.status === 503 &&
        !(message.includes('.env') && message.includes('重启'))
        ? `${message} ${MISSING_CONFIG_HINT}`
        : message,
    );
  }

  if (payload === null || typeof payload === 'string') {
    throw new Error('服务端返回了无法解析的响应，未找到 Snapshot JSON。');
  }

  return parseSnapshot(payload);
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('zh-CN');
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString('zh-CN');
}

function formatCost(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
}

function formatDateTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const now = new Date();
  const pad = (input: number) => String(input).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${monthDay} ${time}`;
  }
  return `${date.getFullYear()}-${monthDay} ${time}`;
}

function windowModeLabel(mode: string): string {
  if (mode === 'fixed') return '固定窗口';
  if (mode === 'rolling') return '滚动窗口';
  return mode || '未知模式';
}

function basisLabel(basis: Forecast['basis']): string {
  return basis === 'previous' ? '上一窗口回退' : '额度比例外推';
}

function numericMetricValue(
  usage: Pick<Usage, 'requests' | 'tokens' | 'cost'> | null,
  metric: MetricKey,
): number | null {
  if (!usage) return null;
  if (metric === 'requests') return usage.requests;
  if (metric === 'tokens') return usage.tokens;
  return usage.cost;
}

function fullMetricValue(metric: MetricKey, value: number): string {
  if (metric === 'cost') return formatCost(value);
  if (metric === 'tokens') return `${formatInteger(value)} Token`;
  return `${formatInteger(value)} 次请求`;
}

function axisMetricValue(metric: MetricKey, value: number): string {
  if (metric === 'cost') {
    if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
    if (value >= 10) return `$${value.toFixed(0)}`;
    return `$${value.toFixed(2)}`;
  }
  return formatCompact(value);
}

function niceMax(value: number): number {
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * base;
}

function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvNumber(value: number | null, digits?: number): string {
  if (value === null || !Number.isFinite(value)) return '';
  return digits === undefined ? String(value) : value.toFixed(digits);
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const applySize = (width: number, height: number) => {
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };

    applySize(node.clientWidth, node.clientHeight);

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => applySize(node.clientWidth, node.clientHeight);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applySize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

function MetricCard({
  label,
  icon,
  tone,
  value,
  unit,
  foot,
  title,
}: {
  label: string;
  icon: ReactNode;
  tone?: 'green' | 'orange' | 'purple';
  value: string | null;
  unit?: string;
  foot: ReactNode;
  title?: string;
}) {
  return (
    <article className="metric" title={title}>
      <div className="metric-label">
        <span>{label}</span>
        <span className={`metric-icon${tone ? ` ${tone}` : ''}`}>{icon}</span>
      </div>
      <div className="metric-value">
        {value ?? '—'}
        {value !== null && unit ? <small>{unit}</small> : null}
      </div>
      <div className="metric-foot">{foot}</div>
    </article>
  );
}

function QuotaRing({ usedPercent }: { usedPercent: number | null }) {
  const safePercent =
    usedPercent !== null && Number.isFinite(usedPercent) ? usedPercent : null;
  const hasValue = safePercent !== null;
  const clamped = safePercent === null ? 0 : Math.max(0, Math.min(100, safePercent));
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const dash = (circumference * clamped) / 100;
  const stroke =
    safePercent === null
      ? '#cbd5e1'
      : safePercent >= 100
        ? '#e16a6a'
        : safePercent >= 80
          ? '#e79d38'
          : '#2563eb';

  return (
    <svg
      viewBox="0 0 163 163"
      role="img"
      aria-label={hasValue ? `已用额度 ${formatPercent(safePercent)}` : '额度数据不可用'}
    >
      <circle cx="81.5" cy="81.5" r={radius} fill="none" stroke="#edf1f7" strokeWidth="10" />
      {clamped > 0 ? (
        <circle
          cx="81.5"
          cy="81.5"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
        />
      ) : null}
    </svg>
  );
}

interface UsageBar {
  key: 'previous' | 'current' | 'forecast';
  caption: string;
  missing: string;
  value: number | null;
  fill: string;
  dashed?: boolean;
}

function usageBars(row: WindowRow | null, metric: MetricKey): UsageBar[] {
  const previousCaption = row?.windowMode === 'rolling' ? '前一等长区间' : '上个窗口';

  return [
    {
      key: 'previous',
      caption: `${previousCaption}实际`,
      missing: '无数据',
      value: numericMetricValue(row?.previous ?? null, metric),
      fill: '#b9c7da',
    },
    {
      key: 'current',
      caption: '当前窗口已用',
      missing: '无数据',
      value: numericMetricValue(row?.current ?? null, metric),
      fill: '#3d7bf3',
    },
    {
      key: 'forecast',
      caption: '当前窗口预测',
      missing: '预测不可用',
      value: numericMetricValue(row?.forecast ?? null, metric),
      fill: '#dbe7ff',
      dashed: true,
    },
  ];
}

function WindowUsageComparison({
  row,
  metric,
}: {
  row: WindowRow | null;
  metric: MetricKey;
}) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const width = size.width > 0 ? size.width : 620;
  const height = size.height > 0 ? size.height : 235;

  const metricLabel = CHART_METRICS.find((item) => item.key === metric)?.label ?? '用量';
  const bars = usageBars(row, metric);
  const previousLabel = row?.windowMode === 'rolling' ? '前一等长区间' : '上个窗口';
  const values = bars
    .map((bar) => bar.value)
    .filter(
      (value): value is number => value !== null && Number.isFinite(value) && value >= 0,
    );

  if (!row || values.length === 0) {
    return (
      <div className="chart-wrap" ref={wrapRef}>
        <div className="chart-empty">
          <Database aria-hidden="true" />
          <strong>{row ? '本窗口缺少可比较的用量' : '尚未选择窗口'}</strong>
          <span>
            {row
              ? `「${row.windowLabel}」窗口没有返回${previousLabel}实际、当前窗口已用或预测值；缺失值不会显示为 0。`
              : '选择一个窗口后，这里会对比上个窗口实际、当前窗口已用与当前窗口预测。'}
          </span>
        </div>
      </div>
    );
  }

  const rawMax = Math.max(...values);
  const maxValue = rawMax > 0 ? niceMax(rawMax) : 1;
  const padLeft = 50;
  const padRight = 12;
  const padTop = 22;
  const padBottom = 36;
  const plotWidth = Math.max(60, width - padLeft - padRight);
  const plotHeight = Math.max(60, height - padTop - padBottom);
  const baseline = padTop + plotHeight;
  const groupWidth = plotWidth / bars.length;
  const barWidth = Math.min(72, Math.max(20, groupWidth * 0.5));
  const ticks =
    rawMax > 0 ? Array.from({ length: 5 }, (_, index) => (maxValue * index) / 4) : [];
  const yFor = (value: number) =>
    padTop + plotHeight - (Math.max(0, value) / maxValue) * plotHeight;

  const description = `${row.accountName} · ${row.windowLabel}，按${metricLabel}比较。${bars
    .map(
      (bar) =>
        `${bar.caption}：${bar.value === null ? bar.missing : fullMetricValue(metric, bar.value)}`,
    )
    .join('；')}。缺失值不按 0 绘制，本图不包含时间趋势。`;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-labelledby="usage-chart-title usage-chart-desc"
      >
        <title id="usage-chart-title">
          {`${row.windowLabel} · ${metricLabel}：${previousLabel}实际、当前窗口已用与当前窗口预测`}
        </title>
        <desc id="usage-chart-desc">{description}</desc>

        {ticks.map((tick, index) => {
          const y = yFor(tick);
          return (
            <g key={index}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#eef2f7"
                strokeWidth="1"
              />
              <text x={padLeft - 8} y={y + 3} textAnchor="end" className="chart-unit">
                {axisMetricValue(metric, tick)}
              </text>
            </g>
          );
        })}

        <line
          x1={padLeft}
          y1={baseline}
          x2={width - padRight}
          y2={baseline}
          stroke="#dfe6ef"
          strokeWidth="1"
        />

        {bars.map((bar, index) => {
          const center = padLeft + groupWidth * (index + 0.5);
          const value = bar.value;
          const barTop =
            value === null ? baseline - 30 : value === 0 ? baseline - 2 : yFor(value);
          const barHeight =
            value === null ? 30 : value === 0 ? 2 : Math.max(2, baseline - yFor(value));
          const valueText = value === null ? bar.missing : axisMetricValue(metric, value);
          const labelY =
            value === null
              ? baseline - 38
              : value === 0
                ? baseline - 10
                : Math.max(12, yFor(value) - 6);

          return (
            <g key={bar.key}>
              <rect
                x={center - barWidth / 2}
                y={barTop}
                width={barWidth}
                height={barHeight}
                rx="3"
                fill={value === null ? '#f8fafc' : bar.fill}
                stroke={value === null ? '#d5deea' : bar.dashed ? '#8aabec' : undefined}
                strokeWidth={value === null || bar.dashed ? 1 : undefined}
                strokeDasharray={value === null ? '4 3' : bar.dashed ? '3 2' : undefined}
              >
                <title>
                  {`${bar.caption}：${value === null ? bar.missing : fullMetricValue(metric, value)}`}
                </title>
              </rect>

              <text
                x={center}
                y={labelY}
                textAnchor="middle"
                className="chart-unit"
                style={{ fontSize: 8 }}
              >
                {valueText}
              </text>
              <text x={center} y={height - 12} textAnchor="middle" className="chart-unit">
                {bar.caption}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [selectedId, setSelectedId] = useState('');
  const [modal, setModal] = useState<ModalKind>(null);
  const [dataError, setDataError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [windowFilter, setWindowFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [metric, setMetric] = useState<MetricKey>('requests');
  const [autoRefresh, setAutoRefresh] = useState<AutoRefreshValue>('off');

  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      requestSeqRef.current += 1;
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      inFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    setSelectedId((current) =>
      current && snapshot.rows.some((row) => row.id === current)
        ? current
        : (snapshot.rows[0]?.id ?? ''),
    );
  }, [snapshot.rows]);

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (inFlightRef.current) return;

      inFlightRef.current = true;
      setRefreshing(true);
      setDataError('');

      const requestId = ++requestSeqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const next = await fetchSnapshot(controller.signal);
        if (requestSeqRef.current !== requestId) return;
        setSnapshot(next);
        setLoaded(true);
        if (!options?.silent) {
          showToast(
            next.rows.length > 0
              ? `已同步 ${next.rows.length} 个窗口快照。`
              : '已同步快照，服务端暂未返回窗口。',
          );
        }
      } catch (error) {
        if (isAbortError(error) || requestSeqRef.current !== requestId) return;
        const message = error instanceof Error ? error.message : '刷新失败。';
        setDataError(message);
        if (!options?.silent) showToast('刷新失败，请查看页面提示。');
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          inFlightRef.current = false;
          setRefreshing(false);
        }
      }
    },
    [showToast],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (autoRefresh === 'off') return;
    const intervalMs = autoRefresh === '30' ? 30_000 : 60_000;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refresh({ silent: true });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh]);

  useEffect(() => {
    if (!modal) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [modal]);

  const rows = snapshot.rows;

  const accountOptions = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; provider: string; plan: string }
    >();
    for (const row of rows) {
      if (!map.has(row.accountId)) {
        map.set(row.accountId, {
          id: row.accountId,
          name: row.accountName,
          provider: row.provider,
          plan: row.plan,
        });
      }
    }
    return Array.from(map.values());
  }, [rows]);

  const singleAccount = accountOptions.length === 1 ? accountOptions[0] : null;

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  const selectedAccountId = selectedRow?.accountId ?? '';

  const selectedAccountWindows = useMemo(() => {
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const row of rows) {
      if (row.accountId !== selectedAccountId || seen.has(row.windowLabel)) continue;
      seen.add(row.windowLabel);
      labels.push(row.windowLabel);
    }
    return labels.sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [rows, selectedAccountId]);

  useEffect(() => {
    setWindowFilter((current) =>
      current === 'all' || selectedAccountWindows.includes(current) ? current : 'all',
    );
  }, [selectedAccountWindows]);

  const accountRows = useMemo(
    () => rows.filter((row) => row.accountId === selectedAccountId),
    [rows, selectedAccountId],
  );

  const activeWindowFilter =
    windowFilter === 'all' || selectedAccountWindows.includes(windowFilter)
      ? windowFilter
      : 'all';

  const filteredRows = useMemo(
    () =>
      activeWindowFilter === 'all'
        ? accountRows
        : accountRows.filter((row) => row.windowLabel === activeWindowFilter),
    [accountRows, activeWindowFilter],
  );

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const rangeStart = filteredRows.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(pageSafe * PAGE_SIZE, filteredRows.length);

  const current = selectedRow?.current ?? null;
  const forecast = selectedRow?.forecast ?? null;
  const forecastReason =
    selectedRow?.unavailableReason.trim() || '上游未提供足够数据以生成预测。';
  const forecastBasisText = forecast
    ? `${basisLabel(forecast.basis)} · 估算`
    : '预测不可用';

  const actualFoot = !selectedRow ? (
    <>
      <Info aria-hidden="true" /> 尚未选择窗口
    </>
  ) : current ? (
    <>
      <Clock aria-hidden="true" />
      {selectedRow.stale
        ? '所选窗口观测已过期'
        : `最后观测 ${formatDateTime(selectedRow.observedAtMs)}`}
    </>
  ) : (
    <>
      <AlertTriangle aria-hidden="true" /> 当前窗口无实际用量
    </>
  );

  const forecastFoot = forecast ? (
    <>
      <Info aria-hidden="true" /> {forecastBasisText}
    </>
  ) : (
    <>
      <AlertTriangle aria-hidden="true" /> 预测不可用
    </>
  );

  const handleAccountChange = (accountId: string) => {
    const candidates = rows.filter((row) => row.accountId === accountId);
    const next =
      candidates.find((row) => row.windowLabel === selectedRow?.windowLabel) ?? candidates[0];
    if (!next) return;
    setSelectedId(next.id);
    setPage(1);
  };

  const handleWindowChange = (windowLabel: string) => {
    const next = accountRows.find((row) => row.windowLabel === windowLabel);
    if (next) setSelectedId(next.id);
  };

  const handleExport = () => {
    if (filteredRows.length === 0) return;

    const headers = [
      '账号',
      '服务商',
      '套餐',
      '窗口',
      '窗口模式',
      '已用额度(%)',
      '实际请求',
      '实际Token',
      '实际成本(USD)',
      '预测请求',
      '预测Token',
      '预测成本(USD)',
      '预测依据',
      '不可用原因',
      '重置时间',
      '最后观测',
    ];

    const lines = [headers.map((header) => csvText(header)).join(',')];

    for (const row of filteredRows) {
      const actual = row.current;
      const projection = row.forecast;
      lines.push(
        [
          csvText(row.accountName),
          csvText(row.provider),
          csvText(row.plan),
          csvText(row.windowLabel),
          csvText(windowModeLabel(row.windowMode)),
          csvNumber(row.usedPercent),
          csvNumber(actual?.requests ?? null),
          csvNumber(actual?.tokens ?? null),
          csvNumber(actual?.cost ?? null, 2),
          csvNumber(projection?.requests ?? null),
          csvNumber(projection?.tokens ?? null),
          csvNumber(projection?.cost ?? null, 2),
          csvText(projection ? basisLabel(projection.basis) : '不可预测'),
          csvText(row.unavailableReason),
          csvText(
            row.endMs === null
              ? row.windowMode === 'rolling'
                ? '滚动窗口'
                : ''
              : formatDateTime(row.endMs),
          ),
          csvText(formatDateTime(row.observedAtMs)),
        ].join(','),
      );
    }

    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cpa-insight-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${filteredRows.length} 行筛选结果。`);
  };

  return (
    <div className="app-shell">
        <main className="content">
          <section className="page-heading" aria-labelledby="page-title">
            <div>
              <p className="eyebrow">CPA INSIGHT / WINDOW FORECAST</p>
              <h1 id="page-title">当前窗口预测</h1>
              <p>
                按当前窗口的已用额度比例，外推整个窗口的请求、Token 与成本。预测为估算，不预测额度何时耗尽，也不代表额度保证。
              </p>
            </div>
            <div className="actions" style={{ flexWrap: 'wrap' }}>
              <label className="legend" style={{ gap: 6 }}>
                自动刷新
                <Select
                  label="自动刷新间隔"
                  value={autoRefresh}
                  onValueChange={(value) => setAutoRefresh(value as AutoRefreshValue)}
                  options={AUTO_REFRESH_OPTIONS}
                />
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                <RefreshCw className={refreshing ? 'spin' : undefined} aria-hidden="true" />
                {refreshing ? '刷新中' : '刷新'}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setModal('methodology')}
              >
                <HelpCircle aria-hidden="true" />
                预测说明
              </button>
            </div>
          </section>

          {dataError ? (
            <div
              className="error-box"
              role="alert"
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 22 }}
            >
              <AlertTriangle aria-hidden="true" style={{ marginTop: 2, width: 15, height: 15 }} />
              <div style={{ flex: 1 }}>
                <strong>
                  {loaded ? '刷新失败，已保留上次数据。' : '读取快照失败。'}
                </strong>
                <div>{dataError}</div>
              </div>
              <button
                type="button"
                className="btn compact"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                重试
              </button>
            </div>
          ) : null}

          {snapshot.warnings.length > 0 ? (
            <section
              className="panel"
              aria-labelledby="warning-title"
              style={{ marginBottom: 22 }}
            >
              <div className="info-panel">
                <span
                  className="info-icon"
                  style={{ background: '#fff7ec', color: '#c68b36' }}
                  aria-hidden="true"
                >
                  <AlertTriangle />
                </span>
                <div>
                  <h3 id="warning-title">数据提示</h3>
                  {snapshot.warnings.map((warning, index) => (
                    <p key={`${index}-${warning}`} style={{ marginTop: index === 0 ? 0 : 4 }}>
                      {warning}
                    </p>
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          <section className="panel" aria-label="当前账号" style={{ marginBottom: 22 }}>
            <div
              className="panel-header"
              style={{ paddingBottom: 18, flexWrap: 'wrap', gap: 14, alignItems: 'center' }}
            >
              <div>
                <div className="panel-title">
                  <Target aria-hidden="true" />
                  <h2>当前账号</h2>
                </div>
                <p className="panel-subtitle">
                  {accountOptions.length > 1
                    ? '窗口切换只作用于所选账号；不做跨账号用量比较。'
                    : '窗口切换只作用于当前账号；图表按窗口对比实际与预测，不同窗口不会相加。'}
                </p>
                {accountOptions.length <= 1 ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      marginTop: 10,
                    }}
                  >
                    {singleAccount ? (
                      <>
                        <strong style={{ fontSize: 13, color: '#33455f' }}>
                          {singleAccount.name}
                        </strong>
                        <span className="badge blue">{singleAccount.provider}</span>
                        <span className="badge gray">{singleAccount.plan}</span>
                      </>
                    ) : (
                      <span className="badge gray">暂无账号</span>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="actions selection-controls">
                {accountOptions.length > 1 ? (
                  <label className="legend" style={{ gap: 6 }}>
                    当前账号
                    <Select
                      label="当前账号"
                      value={selectedAccountId}
                      onValueChange={handleAccountChange}
                      options={accountOptions.map((account) => ({
                        value: account.id,
                        label: account.name,
                      }))}
                    />
                  </label>
                ) : null}
                <label className="legend" style={{ gap: 6 }}>
                  窗口
                  <Select
                    label="窗口"
                    value={selectedRow?.windowLabel ?? ''}
                    onValueChange={handleWindowChange}
                    disabled={!selectedRow || selectedAccountWindows.length === 0}
                    placeholder="暂无窗口"
                    options={selectedAccountWindows.map((label) => ({ value: label, label }))}
                  />
                </label>
              </div>
            </div>
          </section>

          <div className="metrics">
            <MetricCard
              label="实际请求"
              icon={<Activity />}
              value={current ? formatInteger(current.requests) : null}
              unit="次"
              foot={actualFoot}
              title="所选窗口的实际请求数"
            />
            <MetricCard
              label="预测请求"
              icon={<TrendingUp />}
              tone="green"
              value={forecast ? formatInteger(forecast.requests) : null}
              unit="次"
              foot={forecastFoot}
              title={forecast ? '按额度比例外推的整窗请求估算' : forecastReason}
            />
            <MetricCard
              label="预测 Token"
              icon={<Coins />}
              tone="orange"
              value={forecast ? formatCompact(forecast.tokens) : null}
              unit="Token"
              foot={forecastFoot}
              title={forecast ? '按额度比例外推的整窗 Token 估算' : forecastReason}
            />
            <MetricCard
              label="预测成本"
              icon={<CircleDollarSign />}
              tone="purple"
              value={forecast ? formatCost(forecast.cost) : null}
              unit="USD"
              foot={forecastFoot}
              title={forecast ? '按额度比例外推的整窗成本估算，非账单保证' : forecastReason}
            />
          </div>

          <div className="chart-grid">
            <section className="panel" aria-labelledby="usage-title">
              <div className="panel-header">
                <div>
                  <div className="panel-title">
                    <BarChart3 aria-hidden="true" />
                    <h2 id="usage-title">窗口用量对比</h2>
                    {selectedRow ? (
                      <span className="badge blue">{selectedRow.windowLabel}</span>
                    ) : null}
                  </div>
                  <p className="panel-subtitle">
                    用上一区间、当前已用与预测三项对比同一窗口，不做跨窗口或跨账号汇总。
                  </p>
                </div>
                <div
                  className="chart-toolbar"
                  style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}
                >
                  <span className="legend">
                    <i aria-hidden="true" style={{ background: '#b9c7da' }} />
                    {selectedRow?.windowMode === 'rolling' ? '前一等长区间' : '上个窗口'}
                  </span>
                  <span className="legend">
                    <i aria-hidden="true" />
                    当前已用
                  </span>
                  <span className="legend pred">
                    <i aria-hidden="true" />
                    预测
                  </span>
                  <div className="segmented" role="group" aria-label="图表指标">
                    {CHART_METRICS.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={metric === item.key ? 'selected' : undefined}
                        aria-pressed={metric === item.key}
                        onClick={() => setMetric(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <WindowUsageComparison row={selectedRow} metric={metric} />

              <div className="chart-footer">
                <Info aria-hidden="true" />
                <span>
                  {selectedRow
                    ? `仅比较「${selectedRow.windowLabel}」窗口的三项用量；缺失值明确标注，不按 0 绘制，也不绘制时间趋势。`
                    : '选择一个窗口后展示上个窗口实际、当前窗口已用与当前窗口预测。'}
                </span>
              </div>
            </section>

            <aside
              id="account-quota"
              className="panel forecast-panel"
              aria-labelledby="quota-title"
              tabIndex={-1}
            >
              <div className="panel-header">
                <div>
                  <div className="panel-title">
                    <Gauge aria-hidden="true" />
                    <h2 id="quota-title">账号额度</h2>
                  </div>
                  <p className="panel-subtitle">
                    {selectedRow
                      ? `${selectedRow.accountName} · ${selectedRow.windowLabel}`
                      : '尚未选择窗口'}
                  </p>
                </div>
                {selectedRow?.stale ? <span className="badge orange">数据过期</span> : null}
              </div>

              <div className="ring-wrap">
                <QuotaRing usedPercent={selectedRow?.usedPercent ?? null} />
                <div className="ring-center">
                  <strong>
                    {selectedRow && selectedRow.usedPercent !== null
                      ? formatPercent(selectedRow.usedPercent)
                      : '—'}
                  </strong>
                  <span>
                    {selectedRow?.usedPercent === null || selectedRow === null
                      ? '额度未知'
                      : '已用额度'}
                  </span>
                </div>
              </div>

              <div className="forecast-stats">
                <div className="forecast-stat">
                  最后观测
                  <strong>{formatDateTime(selectedRow?.observedAtMs ?? null)}</strong>
                </div>
                <div className="forecast-stat">
                  窗口重置
                  <strong>
                    {selectedRow === null
                      ? '—'
                      : selectedRow.endMs === null
                        ? selectedRow.windowMode === 'rolling'
                          ? '滚动窗口'
                          : '—'
                        : formatDateTime(selectedRow.endMs)}
                  </strong>
                </div>
                <div className="forecast-stat">
                  预测依据
                  <strong>{forecast ? basisLabel(forecast.basis) : '不可预测'}</strong>
                </div>
                <div className="forecast-stat">
                  窗口模式
                  <strong>
                    {selectedRow ? windowModeLabel(selectedRow.windowMode) : '—'}
                  </strong>
                </div>
              </div>

              {forecast ? (
                <div className="forecast-note">
                  <Info aria-hidden="true" />
                  <span>
                    {forecast.basis === 'previous'
                      ? '当前窗口额度比例缺失，采用可信的上一窗口实际用量回退。'
                      : '按已用额度比例外推至窗口结束，并与当前实际用量取较大值。'}{' '}
                    <strong>预测为估算，不是保证。</strong>
                  </span>
                </div>
              ) : (
                <div className="forecast-note">
                  <AlertTriangle
                    aria-hidden="true"
                    style={{ color: '#d5a35b' }}
                  />
                  <span>
                    <strong>无法预测：</strong>
                    {selectedRow
                      ? forecastReason
                      : rows.length === 0
                        ? '尚未读取到窗口快照，页面不会生成占位数据。'
                        : '选择窗口后显示额度状态与预测依据。'}
                  </span>
                </div>
              )}
            </aside>
          </div>

          <section className="panel" aria-labelledby="table-title">
            <div className="table-header">
              <div className="table-header-top">
                <div>
                  <div className="panel-title">
                    <ListFilter aria-hidden="true" />
                    <h2 id="table-title">窗口明细</h2>
                    <span className="count">{filteredRows.length}</span>
                  </div>
                  <p className="panel-subtitle">
                    {selectedRow
                      ? `仅显示「${selectedRow.accountName}」的窗口；点击一行切换当前窗口，不同窗口不可相加。`
                      : '仅显示当前账号的窗口；不同窗口不可相加。'}
                  </p>
                </div>
                <div className="table-controls">
                  <Select
                    label="按窗口筛选"
                    value={activeWindowFilter}
                    onValueChange={(value) => {
                      setWindowFilter(value);
                      setPage(1);
                    }}
                    options={[
                      { value: 'all', label: '全部窗口' },
                      ...selectedAccountWindows.map((label) => ({ value: label, label })),
                    ]}
                  />
                  <button
                    type="button"
                    className="btn compact"
                    onClick={handleExport}
                    disabled={filteredRows.length === 0}
                  >
                    <Download aria-hidden="true" />
                    导出 CSV
                  </button>
                </div>
              </div>
            </div>

            <div className="table-scroll">
              <table style={{ minWidth: 760 }} aria-label="窗口预测明细">
                <thead>
                  <tr>
                    <th scope="col">窗口</th>
                    <th scope="col">额度进度</th>
                    <th scope="col">实际用量</th>
                    <th scope="col">预测用量</th>
                    <th scope="col">重置 / 依据</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="table-empty">
                        <div className="empty-content">
                          <Database aria-hidden="true" />
                          <strong>
                            {rows.length === 0
                              ? refreshing && !loaded
                                ? '正在读取实例快照'
                                : '暂无窗口快照'
                              : accountRows.length === 0
                                ? '当前账号暂无窗口'
                                : '没有匹配的窗口'}
                          </strong>
                          <small>
                            {rows.length === 0
                              ? dataError && !loaded
                                ? '快照读取失败，请先处理上方错误提示。'
                                : refreshing && !loaded
                                  ? '看板通过 /api/snapshot 读取服务端 .env 中配置的 CPA Manager Plus。'
                                  : '服务端未返回任何窗口记录；请确认 CPA Manager Plus 已生成历史窗口快照。'
                              : accountRows.length === 0
                                ? '所选账号暂未返回窗口快照，页面不会生成占位数据。'
                                : '调整窗口筛选后重试。'}
                          </small>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    pageRows.map((row) => {
                      const isSelected = row.id === selectedRow?.id;
                      const used = row.usedPercent;
                      const progress = used === null ? 0 : Math.max(0, Math.min(100, used));
                      const riskClass =
                        used !== null && used >= 100
                          ? ' exhausted'
                          : used !== null && used >= 80
                            ? ' risk'
                            : '';

                      return (
                        <tr
                          key={row.id}
                          tabIndex={0}
                          aria-selected={isSelected}
                          onClick={() => setSelectedId(row.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedId(row.id);
                            }
                          }}
                          onFocus={(event) => {
                            event.currentTarget.style.outline = '2px solid #9ebcff';
                            event.currentTarget.style.outlineOffset = '-2px';
                          }}
                          onBlur={(event) => {
                            event.currentTarget.style.outline = '';
                            event.currentTarget.style.outlineOffset = '';
                          }}
                          style={{
                            cursor: 'pointer',
                            background: isSelected ? '#f5f9ff' : undefined,
                          }}
                        >
                          <td>
                            <div style={{ color: '#4a5b75', fontWeight: 500 }}>
                              {row.windowLabel}
                            </div>
                            <span
                              className={`badge ${
                                row.windowMode === 'rolling' ? 'gray' : 'blue'
                              }`}
                              style={{ marginTop: 5 }}
                            >
                              {windowModeLabel(row.windowMode)}
                            </span>
                          </td>
                          <td>
                            <div className="progress-cell">
                              <div className="progress-caption">
                                <span>{formatPercent(used)}</span>
                                <span>
                                  {row.stale
                                    ? '观测过期'
                                    : used === null
                                      ? '额度未知'
                                      : '已用额度'}
                                </span>
                              </div>
                              <div
                                className="progress-track"
                                role="progressbar"
                                aria-label={`${row.accountName} ${row.windowLabel} 已用额度`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={
                                  used === null
                                    ? undefined
                                    : Math.max(0, Math.min(100, Math.round(used)))
                                }
                                aria-valuetext={
                                  used === null ? '额度未知' : formatPercent(used)
                                }
                              >
                                <div
                                  className={`progress-fill${riskClass}`}
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            {row.current ? (
                              <>
                                <div style={{ color: '#4f5f78', fontWeight: 500 }}>
                                  {formatInteger(row.current.requests)}{' '}
                                  <span style={{ color: '#9aa5b4', fontWeight: 400 }}>
                                    请求
                                  </span>
                                </div>
                                <small
                                  style={{
                                    display: 'block',
                                    fontSize: 9,
                                    color: '#a2adbc',
                                    marginTop: 4,
                                  }}
                                >
                                  {formatCompact(row.current.tokens)} Token ·{' '}
                                  {formatCost(row.current.cost)}
                                </small>
                              </>
                            ) : (
                              <span className="badge gray">无数据</span>
                            )}
                          </td>
                          <td>
                            {row.forecast ? (
                              <>
                                <div style={{ color: '#4f5f78', fontWeight: 500 }}>
                                  {formatInteger(row.forecast.requests)}{' '}
                                  <span style={{ color: '#9aa5b4', fontWeight: 400 }}>
                                    请求
                                  </span>
                                </div>
                                <small
                                  style={{
                                    display: 'block',
                                    fontSize: 9,
                                    color: '#a2adbc',
                                    marginTop: 4,
                                  }}
                                >
                                  {formatCompact(row.forecast.tokens)} Token ·{' '}
                                  {formatCost(row.forecast.cost)}
                                </small>
                              </>
                            ) : (
                              <span
                                className="badge red"
                                title={row.unavailableReason || '上游未提供预测数据'}
                              >
                                不可用
                              </span>
                            )}
                          </td>
                          <td>
                            <div>
                              {row.endMs === null
                                ? row.windowMode === 'rolling'
                                  ? '滚动窗口'
                                  : '—'
                                : formatDateTime(row.endMs)}
                            </div>
                            <span
                              className={`badge ${
                                row.forecast
                                  ? row.forecast.basis === 'previous'
                                    ? 'orange'
                                    : 'blue'
                                  : 'gray'
                              }`}
                              style={{ marginTop: 5 }}
                              title={row.unavailableReason || undefined}
                            >
                              {row.forecast
                                ? basisLabel(row.forecast.basis)
                                : '未生成预测'}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="table-footer" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span>
                {filteredRows.length === 0
                  ? `暂无匹配记录${accountRows.length > 0 ? `（全部 ${accountRows.length} 条）` : ''}`
                  : `显示 ${rangeStart}–${rangeEnd} / 共 ${filteredRows.length} 条${
                      filteredRows.length !== accountRows.length
                        ? `（全部 ${accountRows.length} 条）`
                        : ''
                    }`}
              </span>
              {totalPages > 1 ? (
                <div className="actions">
                  <span>
                    第 {pageSafe} / {totalPages} 页
                  </span>
                  <button
                    type="button"
                    className="btn compact"
                    aria-label="上一页"
                    onClick={() => setPage(Math.max(1, pageSafe - 1))}
                    disabled={pageSafe <= 1}
                  >
                    <ChevronLeft aria-hidden="true" />
                    上一页
                  </button>
                  <button
                    type="button"
                    className="btn compact"
                    aria-label="下一页"
                    onClick={() => setPage(Math.min(totalPages, pageSafe + 1))}
                    disabled={pageSafe >= totalPages}
                  >
                    下一页
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        </main>

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}

      {modal === 'methodology' ? (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setModal(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="methodology-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h2 id="methodology-title">预测说明</h2>
              <button
                type="button"
                className="btn compact"
                aria-label="关闭预测说明"
                onClick={() => setModal(null)}
                autoFocus
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <p>
              预测只回答“按当前进度，本窗口总量大约是多少”，不预测额度何时耗尽，也不预测请求成功率。
            </p>

            <div className="notice-box" style={{ marginBottom: 16 }}>
              <strong style={{ display: 'block', marginBottom: 8, color: '#62728c' }}>
                计算口径
              </strong>
              <div
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11,
                  lineHeight: 2,
                }}
              >
                <div>外推系数 = 100 ÷ 已用额度百分比</div>
                <div>预测值 = max(当前值, round(当前值 × 外推系数))</div>
              </div>
              <div style={{ marginTop: 8 }}>
                请求与 Token 四舍五入为整数，成本保留两位小数；预测值不会低于当前实际值。
              </div>
            </div>

            <p style={{ marginBottom: 14 }}>
              <strong>上一窗口回退：</strong>
              当前额度比例或用量不足以外推时，仅在上游提供可信、正常结束的上一完整周期且通过一致性校验时，使用上一窗口实际值。不会以其他账号的数据补位。
            </p>
            <p style={{ marginBottom: 14 }}>
              <strong>不做预测的情况：</strong>
              滚动窗口、观测过期、数据不完整或当前窗口没有实际用量时，不生成预测，也不会填零。额度卡片和明细表会显示具体不可用原因。
            </p>
            <p style={{ marginBottom: 16 }}>
              <strong>只读与范围：</strong>
              看板只读取 CPA Manager Plus Full Mode 已存在的额度快照，不主动探测 Provider，也不写配额。没有快照的窗口不会虚构数据。
            </p>

            <div className="forecast-note" style={{ margin: '0 0 16px' }}>
              <ShieldAlert aria-hidden="true" style={{ color: '#7598d3' }} />
              <span>
                <strong>预测是估算，不是保证。</strong>
                实际额度、成本和上游策略可能变化；请以服务商与 CPA Manager Plus 的数据为准。
              </span>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn primary" onClick={() => setModal(null)}>
                <Info aria-hidden="true" />
                知道了
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

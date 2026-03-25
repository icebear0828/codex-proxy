/**
 * Pure SVG line chart for token usage trends.
 * No external chart library — renders <polyline> with axis labels.
 */

import { useMemo } from "preact/hooks";
import type { UsageDataPoint } from "../../../shared/hooks/use-usage-stats";

interface UsageChartProps {
  data: UsageDataPoint[];
  height?: number;
}

const PADDING = { top: 20, right: 20, bottom: 40, left: 65 };

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function UsageChart({ data, height = 260 }: UsageChartProps) {
  const width = 720; // SVG viewBox width, responsive via CSS

  const reqHeight = Math.round(height * 0.6);

  const { inputPoints, outputPoints, requestPoints, xLabels, yTokenLabels, yReqLabels } = useMemo(() => {
    if (data.length === 0) {
      return { inputPoints: "", outputPoints: "", requestPoints: "", xLabels: [], yTokenLabels: [], yReqLabels: [] };
    }

    const chartW = width - PADDING.left - PADDING.right;
    const chartH = height - PADDING.top - PADDING.bottom;
    const reqChartH = reqHeight - PADDING.top - PADDING.bottom;

    const maxInput = Math.max(...data.map((d) => d.input_tokens));
    const maxOutput = Math.max(...data.map((d) => d.output_tokens));
    const yMaxT = Math.max(maxInput, maxOutput, 1);
    const yMaxR = Math.max(...data.map((d) => d.request_count), 1);

    const toX = (i: number) => PADDING.left + (i / Math.max(data.length - 1, 1)) * chartW;
    const toYTokens = (v: number) => PADDING.top + chartH - (v / yMaxT) * chartH;
    const toYReqs = (v: number) => PADDING.top + reqChartH - (v / yMaxR) * reqChartH;

    const inp = data.map((d, i) => `${toX(i)},${toYTokens(d.input_tokens)}`).join(" ");
    const out = data.map((d, i) => `${toX(i)},${toYTokens(d.output_tokens)}`).join(" ");
    const req = data.map((d, i) => `${toX(i)},${toYReqs(d.request_count)}`).join(" ");

    // X axis labels (up to 6)
    const step = Math.max(1, Math.floor(data.length / 5));
    const xl = [];
    for (let i = 0; i < data.length; i += step) {
      xl.push({ x: toX(i), label: formatTime(data[i].timestamp) });
    }

    // Y axis labels (5 ticks)
    const yTL = [];
    const yRL = [];
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      yTL.push({ y: PADDING.top + chartH - frac * chartH, label: formatNumber(Math.round(yMaxT * frac)) });
      yRL.push({ y: PADDING.top + reqChartH - frac * reqChartH, label: formatNumber(Math.round(yMaxR * frac)) });
    }

    return { inputPoints: inp, outputPoints: out, requestPoints: req, xLabels: xl, yTokenLabels: yTL, yReqLabels: yRL };
  }, [data, height, reqHeight]);

  if (data.length === 0) {
    return (
      <div class="text-center py-12 text-slate-400 dark:text-text-dim text-sm">
        No usage data yet
      </div>
    );
  }

  return (
    <div class="space-y-6">
      {/* Token chart */}
      <div>
        <div class="flex items-center gap-4 mb-2 text-xs text-slate-500 dark:text-text-dim">
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-blue-500 rounded" /> Input Tokens
          </span>
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-emerald-500 rounded" /> Output Tokens
          </span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          class="w-full"
          style={{ maxHeight: `${height}px` }}
        >
          {/* Grid lines */}
          {yTokenLabels.map((tick) => (
            <line
              key={`grid-${tick.y}`}
              x1={PADDING.left}
              y1={tick.y}
              x2={width - PADDING.right}
              y2={tick.y}
              stroke="currentColor"
              class="text-gray-200 dark:text-border-dark"
              stroke-width="0.5"
            />
          ))}

          {/* Y axis labels */}
          {yTokenLabels.map((tick) => (
            <text
              key={`yl-${tick.y}`}
              x={PADDING.left - 8}
              y={tick.y + 3}
              text-anchor="end"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="10"
            >
              {tick.label}
            </text>
          ))}

          {/* X axis labels */}
          {xLabels.map((tick) => (
            <text
              key={`xl-${tick.x}`}
              x={tick.x}
              y={height - 8}
              text-anchor="middle"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="9"
            >
              {tick.label}
            </text>
          ))}

          {/* Lines */}
          <polyline
            points={inputPoints}
            fill="none"
            stroke="var(--chart-blue)"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <polyline
            points={outputPoints}
            fill="none"
            stroke="var(--chart-green)"
            stroke-width="2"
            stroke-linejoin="round"
          />
        </svg>
      </div>

      {/* Request count chart */}
      <div>
        <div class="flex items-center gap-4 mb-2 text-xs text-slate-500 dark:text-text-dim">
          <span class="flex items-center gap-1">
            <span class="inline-block w-3 h-0.5 bg-amber-500 rounded" /> Requests
          </span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${reqHeight}`}
          class="w-full"
          style={{ maxHeight: `${reqHeight}px` }}
        >
          {/* Grid lines */}
          {yReqLabels.map((tick) => (
            <line
              key={`rgrid-${tick.y}`}
              x1={PADDING.left}
              y1={tick.y}
              x2={width - PADDING.right}
              y2={tick.y}
              stroke="currentColor"
              class="text-gray-200 dark:text-border-dark"
              stroke-width="0.5"
            />
          ))}

          {yReqLabels.map((tick) => (
            <text
              key={`ryl-${tick.y}`}
              x={PADDING.left - 8}
              y={tick.y + 3}
              text-anchor="end"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="10"
            >
              {tick.label}
            </text>
          ))}

          {xLabels.map((tick) => (
            <text
              key={`rxl-${tick.x}`}
              x={tick.x}
              y={reqHeight - 8}
              text-anchor="middle"
              class="fill-slate-400 dark:fill-text-dim"
              font-size="9"
            >
              {tick.label}
            </text>
          ))}

          <polyline
            points={requestPoints}
            fill="none"
            stroke="var(--chart-amber)"
            stroke-width="2"
            stroke-linejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}

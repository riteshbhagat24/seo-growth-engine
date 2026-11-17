"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export type ValueFormat = "int" | "pct" | "pos" | "dec";

const fmt = (v: number | null, f: ValueFormat) => {
  if (v === null || Number.isNaN(v)) return "–";
  if (f === "pct") return `${(v * 100).toFixed(v < 0.1 ? 2 : 1)}%`;
  if (f === "pos" || f === "dec") return v.toFixed(1);
  return Math.round(v).toLocaleString("en-IN");
};
const axisFmt = (v: number, f: ValueFormat) => {
  if (f === "pct") return `${(v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0)}%`;
  if (f === "pos" || f === "dec") return v.toFixed(v < 10 ? 1 : 0);
  return v >= 10_000 ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v) : Math.round(v).toLocaleString("en-IN");
};
const dateLabel = (iso: string, long = false) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(long ? { year: "numeric" } : {}), timeZone: "UTC" });

/** "Nice" axis maximum and step for ~3–4 gridlines. */
function niceScale(min: number, max: number) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

export interface Point {
  x: string;
  y: number | null;
}

/**
 * One measure over time. Single series (no legend; the title names it),
 * 2px line, soft area, recessive grid, crosshair + tooltip on hover/focus,
 * arrow keys to step through points, and a data table for screen readers.
 */
export function TimeSeriesChart({
  data,
  label,
  format = "int",
  invert = false,
  height = 180,
  area = true,
  zeroBased = true
}: {
  data: Point[];
  label: string;
  format?: ValueFormat;
  /** For "average position": smaller is better, so the axis runs top = 1. */
  invert?: boolean;
  height?: number;
  area?: boolean;
  zeroBased?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [idx, setIdx] = useState<number | null>(null);
  const tableId = useId();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { top: 12, right: 12, bottom: 24, left: 44 };
  const geo = useMemo(() => {
    const ys = data.map((d) => d.y).filter((v): v is number => v !== null);
    const min = ys.length ? Math.min(...ys) : 0;
    const max = ys.length ? Math.max(...ys) : 1;
    const s = niceScale(zeroBased && !invert ? Math.min(0, min) : invert ? Math.max(1, Math.floor(min)) : min, max);
    const lo = invert ? Math.max(1, Math.min(s.lo, min)) : s.lo;
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const x = (i: number) => pad.left + (data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w);
    const y = (v: number) => {
      const t = (v - lo) / (s.hi - lo || 1);
      return pad.top + (invert ? t : 1 - t) * h;
    };
    let d = "";
    let started = false;
    data.forEach((p, i) => {
      if (p.y === null) {
        started = false;
        return;
      }
      d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`;
      started = true;
    });
    const firstI = data.findIndex((p) => p.y !== null);
    const lastI = data.length - 1 - [...data].reverse().findIndex((p) => p.y !== null);
    const base = invert ? pad.top + h : y(lo);
    const areaD = firstI >= 0 && !data.some((p) => p.y === null) ? `${d}L${x(lastI).toFixed(1)},${base}L${x(firstI).toFixed(1)},${base}Z` : "";
    const ticks = s.ticks.filter((t) => t >= lo && t <= s.hi);
    return { x, y, d, areaD, ticks, w, h };
  }, [data, width, height, invert, zeroBased, pad.left, pad.right, pad.top, pad.bottom]);

  if (data.length === 0) return <div className="grid h-32 place-items-center text-sm text-subtle">No data for this period.</div>;

  const xLabels = data.length > 2 ? [0, Math.floor((data.length - 1) / 2), data.length - 1] : data.map((_, i) => i);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - pad.left) / Math.max(1, geo.w)) * (data.length - 1));
    setIdx(Math.max(0, Math.min(data.length - 1, i)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setIdx((cur) => Math.max(0, Math.min(data.length - 1, (cur ?? data.length - 1) + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Escape") setIdx(null);
  };
  const active = idx !== null ? data[idx] : null;
  const tipLeft = idx !== null ? (geo.x(idx) / width) * 100 : 0;

  return (
    <div className="relative" ref={wrap}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}: ${data.length} points from ${dateLabel(data[0]!.x, true)} to ${dateLabel(data.at(-1)!.x, true)}. Use arrow keys to read values.`}
        aria-describedby={tableId}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setIdx(null)}
        onKeyDown={onKey}
        onBlur={() => setIdx(null)}
        className="touch-pan-y select-none outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={geo.y(t)} y2={geo.y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.left - 8} y={geo.y(t)} textAnchor="end" dominantBaseline="middle" className="fill-subtle text-[11px] tabular-nums">
              {axisFmt(t, format)}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text
            key={i}
            x={geo.x(i)}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
            className="fill-subtle text-[11px]"
          >
            {dateLabel(data[i]!.x)}
          </text>
        ))}
        {area && geo.areaD && <path d={geo.areaD} fill="var(--series-1)" opacity={0.08} />}
        <path d={geo.d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {active && active.y !== null && idx !== null && (
          <g pointerEvents="none">
            <line x1={geo.x(idx)} x2={geo.x(idx)} y1={pad.top} y2={pad.top + geo.h} stroke="var(--border-strong)" strokeWidth={1} />
            <circle cx={geo.x(idx)} cy={geo.y(active.y)} r={4.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {active && idx !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-pop"
          style={{ left: `${tipLeft}%`, transform: `translateX(${tipLeft > 70 ? "-105%" : "8px"})` }}
          role="status"
        >
          <div className="text-sm font-semibold tabular-nums">{fmt(active.y, format)}</div>
          <div className="text-muted">
            {label} · {dateLabel(active.x, true)}
          </div>
        </div>
      )}
      <details className="mt-1 text-xs text-muted" id={tableId}>
        <summary className="cursor-pointer select-none hover:text-foreground">Data table</summary>
        <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                <th className="px-3 py-1.5 font-medium">Date</th>
                <th className="px-3 py-1.5 text-right font-medium">{label}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((p) => (
                <tr key={p.x}>
                  <td className="px-3 py-1">{dateLabel(p.x, true)}</td>
                  <td className="px-3 py-1 text-right tabular-nums text-foreground">{fmt(p.y, format)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

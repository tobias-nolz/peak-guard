import { useEffect, useRef } from 'react';
import { BarChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DataZoomComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

/** Chart palette (ECharts needs sRGB colours, not the CSS oklch tokens). */
export function chartColors(dark: boolean) {
  return {
    text: dark ? '#cbd5e1' : '#475569',
    axis: dark ? '#334155' : '#e2e8f0',
    grid: dark ? '#94a3b8' : '#64748b',
    pv: '#eab308',
    battery: '#22c55e',
    house: '#3b82f6',
    safe: dark ? '#4ade80' : '#16a34a',
    warning: dark ? '#fbbf24' : '#d97706',
    over: dark ? '#f87171' : '#dc2626',
    limit: '#f59e0b',
    peak: dark ? '#f472b6' : '#db2777',
  };
}

export type EChartEventHandlers = Record<string, (params: unknown) => void>;

export function EChart({
  option,
  className,
  onEvents,
  live = false,
}: {
  option: EChartsCoreOption;
  className?: string;
  onEvents?: EChartEventHandlers;
  /**
   * Frequently updated chart: merge new options instead of rebuilding, so an open
   * tooltip survives the update (the structure must stay the same between updates).
   */
  live?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  // Latest handlers, read at event time so re-renders don't need to rebind.
  const handlers = useRef<EChartEventHandlers | undefined>(onEvents);
  useEffect(() => {
    handlers.current = onEvents;
  });
  const { dark } = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, dark ? 'dark' : undefined, { renderer: 'canvas' });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    for (const name of Object.keys(handlers.current ?? {})) {
      c.on(name, (params: unknown) => handlers.current?.[name]?.(params));
    }
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, [dark]);

  useEffect(() => {
    chart.current?.setOption(
      { backgroundColor: 'transparent', ...option },
      live ? { replaceMerge: ['series'] } : { notMerge: true },
    );
  }, [option, dark, live]);

  return <div ref={ref} className={cn('h-64 w-full', className)} />;
}

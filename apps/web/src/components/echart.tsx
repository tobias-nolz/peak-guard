import { useEffect, useRef } from 'react';
import { BarChart, LineChart, HeatmapChart } from 'echarts/charts';
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

export function EChart({ option, className }: { option: EChartsCoreOption; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { dark } = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, dark ? 'dark' : undefined, { renderer: 'canvas' });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, [dark]);

  useEffect(() => {
    chart.current?.setOption({ backgroundColor: 'transparent', ...option }, { notMerge: true });
  }, [option, dark]);

  return <div ref={ref} className={cn('h-64 w-full', className)} />;
}

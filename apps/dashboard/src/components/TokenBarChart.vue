<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as d3 from 'd3';
import { formatCompact, formatInteger } from '@/lib/format';
import type { ChartRow, ChartSeries } from '@/lib/chart';

const props = defineProps<{ rows: ChartRow[]; series: ChartSeries[] }>();

const container = ref<HTMLDivElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);
const tooltip = ref<HTMLDivElement | null>(null);

const ROW_H = 30;
const GAP = 2; // 2px-Lücke zwischen gestapelten Segmenten (dataviz-Mark-Spec).
const MARGIN = { top: 4, right: 66, bottom: 22, left: 132 };

function rowTotal(row: ChartRow): number {
  return props.series.reduce((sum, s) => sum + (row.segments[s.key] ?? 0), 0);
}

function render(): void {
  const svgEl = svgRef.value;
  const el = container.value;
  if (!svgEl || !el) return;

  const width = el.clientWidth;
  const innerW = Math.max(80, width - MARGIN.left - MARGIN.right);
  const innerH = props.rows.length * ROW_H;
  const height = innerH + MARGIN.top + MARGIN.bottom;

  const svg = d3.select(svgEl).attr('width', width).attr('height', height);
  svg.selectAll('*').remove();
  if (props.rows.length === 0) return;

  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  const maxTotal = d3.max(props.rows, rowTotal) ?? 0;
  const x = d3
    .scaleLinear()
    .domain([0, maxTotal || 1])
    .range([0, innerW])
    .nice();
  const y = d3
    .scaleBand<string>()
    .domain(props.rows.map((r) => r.id))
    .range([0, innerH])
    .padding(0.28);
  const bandH = y.bandwidth();

  // Recessive vertikale Gitterlinien + Achsenbeschriftung.
  const ticks = x.ticks(4);
  const grid = g.append('g');
  grid
    .selectAll('line')
    .data(ticks)
    .join('line')
    .attr('x1', (d) => x(d))
    .attr('x2', (d) => x(d))
    .attr('y1', 0)
    .attr('y2', innerH)
    .style('stroke', 'var(--border)')
    .style('stroke-opacity', 0.5);
  grid
    .selectAll('text')
    .data(ticks)
    .join('text')
    .attr('x', (d) => x(d))
    .attr('y', innerH + 15)
    .attr('text-anchor', 'middle')
    .style('fill', 'var(--text-faint)')
    .style('font-size', '10px')
    .text((d) => formatCompact(d));

  const rows = g
    .selectAll('g.row')
    .data(props.rows, (d) => (d as ChartRow).id)
    .join('g')
    .attr('class', 'row')
    .attr('transform', (d) => `translate(0,${y(d.id) ?? 0})`);

  // Zeilenbeschriftung (Ticket-Kennung), rechtsbündig im linken Rand.
  rows
    .append('text')
    .attr('x', -10)
    .attr('y', bandH / 2)
    .attr('dy', '0.32em')
    .attr('text-anchor', 'end')
    .style('fill', 'var(--text-dim)')
    .style('font-size', '11px')
    .style('font-family', 'var(--mono)')
    .text((d) => d.label);

  // Gestapelte Segmente pro Serie, in fester Reihenfolge.
  rows.each(function (row) {
    const rowG = d3.select(this);
    let cursor = 0;
    for (const s of props.series) {
      const value = row.segments[s.key] ?? 0;
      if (value <= 0) continue;
      const x0 = x(cursor);
      const x1 = x(cursor + value);
      cursor += value;
      const w = Math.max(0, x1 - x0 - GAP);
      rowG
        .append('rect')
        .attr('x', x0)
        .attr('y', 0)
        .attr('width', w)
        .attr('height', bandH)
        .attr('rx', 3)
        .style('fill', s.color)
        .on('mouseenter', (event: MouseEvent) => showTip(event, row, s, value))
        .on('mousemove', (event: MouseEvent) => moveTip(event))
        .on('mouseleave', hideTip);
    }
    // Gesamtwert als direkte Beschriftung am Balkenende.
    rowG
      .append('text')
      .attr('x', x(rowTotal(row)) + 6)
      .attr('y', bandH / 2)
      .attr('dy', '0.32em')
      .attr('text-anchor', 'start')
      .style('fill', 'var(--text-dim)')
      .style('font-size', '10.5px')
      .text(formatCompact(rowTotal(row)));
  });
}

function showTip(event: MouseEvent, row: ChartRow, s: ChartSeries, value: number): void {
  const tip = tooltip.value;
  if (!tip) return;
  const title = row.sublabel ? `${row.label} · ${row.sublabel}` : row.label;
  tip.innerHTML = `<div class="tt-title">${escapeHtml(title)}</div><div class="tt-row"><span class="tt-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}<span class="tt-val">${formatInteger(value)}</span></div>`;
  tip.style.opacity = '1';
  moveTip(event);
}
function moveTip(event: MouseEvent): void {
  const tip = tooltip.value;
  const el = container.value;
  if (!tip || !el) return;
  const rect = el.getBoundingClientRect();
  tip.style.left = `${event.clientX - rect.left + 12}px`;
  tip.style.top = `${event.clientY - rect.top + 12}px`;
}
function hideTip(): void {
  if (tooltip.value) tooltip.value.style.opacity = '0';
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  render();
  observer = new ResizeObserver(() => render());
  if (container.value) observer.observe(container.value);
});
onBeforeUnmount(() => observer?.disconnect());
watch(() => [props.rows, props.series], render, { deep: true });
</script>

<template>
  <div ref="container" class="chart">
    <svg ref="svgRef" role="img" />
    <div ref="tooltip" class="tooltip" />
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
}
svg {
  display: block;
  overflow: visible;
}
.tooltip {
  position: absolute;
  pointer-events: none;
  opacity: 0;
  z-index: 10;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 7px 9px;
  font-size: 12px;
  max-width: 280px;
  transition: opacity 0.1s ease;
}
.tooltip :deep(.tt-title) {
  color: var(--text);
  font-weight: 600;
  margin-bottom: 4px;
}
.tooltip :deep(.tt-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}
.tooltip :deep(.tt-dot) {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex-shrink: 0;
}
.tooltip :deep(.tt-val) {
  margin-left: auto;
  color: var(--text);
  font-family: var(--mono);
  padding-left: 12px;
}
</style>

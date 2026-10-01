import type { DagStructure } from './cache.ts';
import { chinese, type Translator } from '../shared/i18n.ts';

export interface DagBox { id: number; left: number; top: number; width: number }
export interface DagRoute { from: number; to: number; points: readonly [number, number][] }
export interface DagLayout { width: number; lines: readonly string[]; boxes: readonly DagBox[]; routes: readonly DagRoute[]; crossings: number }
export type DagLayoutResult = { layout: DagLayout; reason?: never } | { layout?: never; reason: string };
interface Vertex { key: string; id?: number; edge?: number; center: number; top: number; inX: number; outX: number }
interface Cell { mask: number; edges: Set<number> }
const U = 1, D = 2, L = 4, R = 8;
const glyphs: Record<number, string> = { 0: ' ', 1: '│', 2: '│', 3: '│', 4: '─', 8: '─', 12: '─', 5: '┘', 9: '└', 6: '┐', 10: '┌', 7: '┤', 11: '├', 13: '┴', 14: '┬', 15: '┼' };
const layouts = new WeakMap<DagStructure, Map<number, DagLayoutResult>>();

/** Stable top-down orthogonal routing; long edges get unlabelled transit slots, not duplicate Todos. */
export function dagLayout(structure: DagStructure, available: number, msg: Translator = chinese): DagLayoutResult {
  const width = Math.max(0, Math.floor(available));
  let entries = layouts.get(structure);
  if (!entries) { entries = new Map(); layouts.set(structure, entries); }
  const existing = entries.get(width);
  if (existing) return localizedResult(existing, msg);
  // Cache geometry and canonical message keys, never a caller's translated reason.
  const result = build(structure, width, chinese);
  entries.set(width, result);
  if (entries.size > 4) entries.delete(entries.keys().next().value!);
  return localizedResult(result, msg);
}
function localizedResult(result: DagLayoutResult, msg: Translator): DagLayoutResult {
  if (result.layout) return result;
  const reason = msg(result.reason);
  return reason === result.reason ? result : { reason };
}
function build(structure: DagStructure, width: number, msg: Translator): DagLayoutResult {
  if (!structure.layers.length) return { layout: { width: 0, lines: [], boxes: [], routes: [], crossings: 0 } };
  if (width < 24) return { reason: msg('宽度不足') };
  if (structure.layers.length > 2000 || structure.edges.length > 4096) return { reason: msg('图过长／连线过多') };
  const layerOf = new Map(structure.layers.flatMap((ids, index) => ids.map((id) => [id, index] as const)));
  const layers: Vertex[][] = structure.layers.map((ids) => ids.map((id) => ({ key: `n${id}`, id, center: 0, top: 0, inX: 0, outX: 0 })));
  const vertices = new Map(layers.flat().map((vertex) => [vertex.key, vertex]));
  const segments: { edge: number; from: Vertex; to: Vertex; gap: number }[][] = layers.slice(1).map(() => []);
  const maxSlots = Math.floor(width / 24);
  for (const [index, edge] of structure.edges.entries()) {
    const first = layerOf.get(edge.from)!; const last = layerOf.get(edge.to)!;
    let previous = vertices.get(`n${edge.from}`)!;
    for (let layer = first + 1; layer <= last; layer++) {
      let target: Vertex;
      if (layer === last) target = vertices.get(`n${edge.to}`)!;
      else {
        target = { key: `e${index}:${layer}`, edge: index, center: 0, top: 0, inX: 0, outX: 0 };
        layers[layer]!.push(target);
        if (layers[layer]!.length > maxSlots) return { reason: msg('并行节点或跨层连线超出宽度') };
      }
      segments[layer - 1]!.push({ edge: index, from: previous, to: target, gap: layer - 1 });
      previous = target;
    }
  }
  const slots = Math.max(...layers.map((layer) => layer.length));
  if (slots > maxSlots) return { reason: msg('并行节点超出宽度') };
  // Multiples of 12 keep source and target rails in distinct x lanes even on aligned layers.
  const span = Math.min(36, Math.floor(width / slots / 12) * 12);
  const canvasWidth = span * slots;
  const boxWidth = span - 3;
  const sourceDegrees = segments.map((items) => { const counts = new Map<string, number>(); for (const item of items) counts.set(item.from.key, (counts.get(item.from.key) ?? 0) + 1); return counts; });
  const groupKey = (gap: number, from: Vertex, to: Vertex) => sourceDegrees[gap]!.get(from.key)! > 1 ? `from:${from.key}` : `to:${to.key}`;
  const gapGroups = segments.map((items, gap) => [...new Set(items.map((item) => groupKey(gap, item.from, item.to)))]);
  let top = 0;
  for (const [index, layer] of layers.entries()) {
    const start = (canvasWidth - layer.length * span) / 2;
    for (const [slot, vertex] of layer.entries()) {
      vertex.center = start + span / 2 + slot * span;
      vertex.top = top; vertex.inX = vertex.center + 1; vertex.outX = vertex.center - 1;
    }
    top += 5 + (gapGroups[index]?.length ?? 0) + (index < layers.length - 1 ? 2 : 0);
  }
  if (top * canvasWidth > 200000) return { reason: msg('图过长，改用紧凑列表') };
  const grid: Map<number, Cell>[] = Array.from({ length: top }, () => new Map());
  const boxes: DagBox[] = [];
  const routes: DagRoute[] = structure.edges.map((edge) => ({ ...edge, points: [] }));
  const cell = (x: number, y: number, mask: number, edge?: number) => {
    const current = grid[y]!.get(x) ?? { mask: 0, edges: new Set<number>() };
    current.mask |= mask; if (edge !== undefined) current.edges.add(edge);
    grid[y]!.set(x, current);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, edge?: number) => {
    const dx = Math.sign(x2 - x1); const dy = Math.sign(y2 - y1);
    let x = x1, y = y1;
    if (edge !== undefined) (routes[edge]!.points as [number, number][]).push([x, y]);
    while (x !== x2 || y !== y2) {
      const out = dx > 0 ? R : dx < 0 ? L : dy > 0 ? D : U;
      const incoming = dx > 0 ? L : dx < 0 ? R : dy > 0 ? U : D;
      cell(x, y, out, edge); x += dx; y += dy; cell(x, y, incoming, edge);
      if (edge !== undefined) (routes[edge]!.points as [number, number][]).push([x, y]);
    }
  };
  for (const layer of layers) for (const vertex of layer) {
    if (vertex.id !== undefined) {
      const left = vertex.center - Math.floor(boxWidth / 2);
      boxes.push({ id: vertex.id, left, top: vertex.top, width: boxWidth });
      line(left, vertex.top, left + boxWidth - 1, vertex.top);
      line(left, vertex.top + 4, left + boxWidth - 1, vertex.top + 4);
      line(left, vertex.top, left, vertex.top + 4);
      line(left + boxWidth - 1, vertex.top, left + boxWidth - 1, vertex.top + 4);
    } else {
      line(vertex.inX, vertex.top, vertex.inX, vertex.top + 2, vertex.edge);
      line(vertex.inX, vertex.top + 2, vertex.outX, vertex.top + 2, vertex.edge);
      line(vertex.outX, vertex.top + 2, vertex.outX, vertex.top + 4, vertex.edge);
    }
  }
  for (const [gap, items] of segments.entries()) {
    const groups = gapGroups[gap]!;
    for (const item of items) {
      const y = item.from.top + 5 + groups.indexOf(groupKey(gap, item.from, item.to));
      line(item.from.outX, item.from.top + 4, item.from.outX, y, item.edge);
      line(item.from.outX, y, item.to.inX, y, item.edge);
      line(item.to.inX, y, item.to.inX, item.to.top, item.edge);
    }
  }
  let crossings = 0;
  const lines = grid.map((row) => Array.from({ length: canvasWidth }, (_, x) => {
    const current = row.get(x);
    if (!current) return ' ';
    if (current.edges.size > 1) {
      const edges = [...current.edges].map((index) => structure.edges[index]!);
      const sameFrom = edges.every((edge) => edge.from === edges[0]!.from);
      const sameTo = edges.every((edge) => edge.to === edges[0]!.to);
      if (!sameFrom && !sameTo) { crossings++; return '╳'; }
    }
    return glyphs[current.mask] ?? ' ';
  }).join(''));
  return { layout: { width: canvasWidth, lines, boxes, routes, crossings } };
}

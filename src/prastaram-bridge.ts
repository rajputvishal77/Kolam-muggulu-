import {
  Grid,
  Pattern,
  enumerate,
  dotsFromRows,
  symmetryClassesFor,
  type Family,
  type Point,
  type Stroke,
  type SymClass,
} from '@muggula-prastaram/core';

export interface KolamPoint {
  x: number;
  y: number;
}

export interface KolamStroke {
  points: KolamPoint[];
  smooth: boolean;
  closed: boolean;
  color: string;
  width: number;
  fill: string | null;
}

export interface KolamGridConfig {
  type: 'square' | 'staggered' | 'diamond' | 'formula' | 'custom';
  formula?: string;
  size?: number;
  cols?: number;
  rows?: number;
  rotation?: number;
  spacing?: number;
  dotSize?: number;
  shape?: string;
  color?: string;
  visible?: boolean;
  deletedIds?: string[];
  ringOverrides?: Record<string, boolean>;
  addedDots?: Array<{ id: string; gx: number; gy: number; ringed?: boolean }>;
}

export interface RenderConversionOptions {
  curvature?: number; // 0 (kambi) to 1 (flowing sikku)
  colorMode?: 'white' | 'festival' | 'custom';
  customColor?: string;
  strokeWidth?: number;
}

export interface SerializedPattern {
  ok: true;
  pattern: Pattern;
  indexStr: string;
  formattedIndex: string;
  strokeCount: number;
  symmetryName: string;
  symmetryElements: readonly string[];
  gates: boolean[];
  strokes: KolamStroke[];
}

export interface GridMeta {
  ok: true;
  grid: Grid;
  label: string;
  sites: number;
  dotCount: number;
  countStr: string;
  formattedCount: string;
  symmetryClasses: readonly SymClass[];
  dotsSignature: string;
  offset: KolamPoint;
  siteCoords: Array<{ index: number; x: number; y: number }>;
  kolamGridConfig: KolamGridConfig;
}

export type GridSpec =
  | { kind: 'diamond'; p: number }
  | { kind: 'square'; m: number; n: number }
  | { kind: 'rows'; rows: number[]; label?: string }
  | { kind: 'custom'; dots: Array<[number, number]>; label?: string };

const FESTIVAL_PALETTE = [
  '#FFFFFF',
  '#FACC15',
  '#F472B6',
  '#38BDF8',
  '#22C55E',
  '#F97316',
];

export function formatBigIntCount(val: bigint): string {
  const str = val.toString();
  if (str.length <= 18) {
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  const lead = str.slice(0, 3);
  const exp = str.length - 1;
  return `${lead[0]}.${lead.slice(1)} × 10^${exp}`;
}

export function parseBigIntIndex(raw: string | number | bigint, maxCount: bigint): bigint {
  if (typeof raw === 'bigint') {
    if (raw < 1n) return 1n;
    return raw > maxCount ? maxCount : raw;
  }
  const cleaned = String(raw ?? '').replace(/[,\s_]/g, '');
  if (!/^\d+$/.test(cleaned)) {
    throw new RangeError('Pattern index must be a positive whole number.');
  }
  let idx = BigInt(cleaned);
  if (idx < 1n) idx = 1n;
  if (idx > maxCount) idx = maxCount;
  return idx;
}

const gridOffsetMap = new WeakMap<Grid, KolamPoint>();

function toUnitPoint(pt: Point, grid: Grid, offset?: KolamPoint): KolamPoint {
  const cx = grid.extent[0] / 2;
  const cy = grid.extent[1] / 2;
  const off = offset ?? gridOffsetMap.get(grid) ?? { x: 0, y: 0 };
  return {
    x: Number(((pt[0] - cx) / 2 + off.x).toFixed(4)),
    y: Number(((cy - pt[1]) / 2 + off.y).toFixed(4)),
  };
}

/**
 * Converts a closed mirror-curve polyline from @muggula-prastaram/core into
 * Kolam Studio canvas points using the exact quadratic Bezier corner model
 * from @muggula-prastaram/render (f = clamp(curvature, 0, 1) / 2).
 */
export function sampleMirrorCurveStroke(
  stroke: Stroke,
  grid: Grid,
  curvature = 0.85,
  offset?: KolamPoint
): KolamPoint[] {
  const f = Math.min(Math.max(curvature, 0), 1) / 2;
  const L = stroke.length;
  if (L < 2) return stroke.map((p) => toUnitPoint(p, grid, offset));

  const ptAt = (idx: number): Point => stroke[((idx % L) + L) % L]!;
  const points: KolamPoint[] = [];

  const pushUnique = (u: KolamPoint) => {
    const prev = points[points.length - 1];
    if (!prev || Math.hypot(u.x - prev.x, u.y - prev.y) > 1e-4) {
      points.push(u);
    }
  };

  if (f <= 1e-6) {
    for (let i = 0; i < L; i++) {
      pushUnique(toUnitPoint(ptAt(i), grid, offset));
    }
    return points;
  }

  const stepsPerCorner = 7;
  for (let i = 0; i < L; i++) {
    const prev = ptAt(i - 1);
    const curr = ptAt(i);
    const next = ptAt(i + 1);

    const ax = curr[0] + (prev[0] - curr[0]) * f;
    const ay = curr[1] + (prev[1] - curr[1]) * f;
    const bx = curr[0] + (next[0] - curr[0]) * f;
    const by = curr[1] + (next[1] - curr[1]) * f;

    for (let s = 0; s <= stepsPerCorner; s++) {
      const t = s / stepsPerCorner;
      const omt = 1 - t;
      const px = omt * omt * ax + 2 * omt * t * curr[0] + t * t * bx;
      const py = omt * omt * ay + 2 * omt * t * curr[1] + t * t * by;
      pushUnique(toUnitPoint([px, py], grid, offset));
    }
  }

  // Avoid repeating start vertex when closed
  if (points.length > 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-3) {
      points.pop();
    }
  }

  return points;
}

export function serializePattern(
  pattern: Pattern,
  opts: RenderConversionOptions = {}
): SerializedPattern {
  const curvature = opts.curvature ?? 0.85;
  const colorMode = opts.colorMode ?? 'festival';
  const customColor = opts.customColor ?? '#FFFFFF';
  const strokeWidth = opts.strokeWidth ?? 3.5;

  const traced = pattern.trace();
  const sym = pattern.symmetry();
  const indexBig = pattern.encode();
  const indexStr = indexBig.toString();

  const strokes: KolamStroke[] = traced.map((poly, idx) => {
    let color = '#FFFFFF';
    if (colorMode === 'custom') {
      color = customColor;
    } else if (colorMode === 'festival' && traced.length > 1) {
      color = FESTIVAL_PALETTE[idx % FESTIVAL_PALETTE.length]!;
    }
    return {
      points: sampleMirrorCurveStroke(poly, pattern.grid, curvature),
      smooth: false,
      closed: true,
      color,
      width: strokeWidth,
      fill: null,
    };
  });

  const gates: boolean[] = [];
  for (let k = 0; k < pattern.grid.sites; k++) {
    gates.push(pattern.gate(k));
  }

  return {
    ok: true,
    pattern,
    indexStr,
    formattedIndex: formatBigIntCount(indexBig),
    strokeCount: traced.length,
    symmetryName: sym.name,
    symmetryElements: sym.elements,
    gates,
    strokes,
  };
}

export function gridToKolamConfig(
  grid: Grid,
  baseConfig?: Partial<KolamGridConfig>,
  rowHint?: number[]
): KolamGridConfig {
  const common: Partial<KolamGridConfig> = {
    spacing: baseConfig?.spacing ?? 44,
    dotSize: baseConfig?.dotSize ?? 3,
    shape: baseConfig?.shape ?? 'circle',
    color: baseConfig?.color ?? '#D0D3DC',
    visible: baseConfig?.visible !== false,
    rotation: baseConfig?.rotation ?? 0,
    deletedIds: [],
    ringOverrides: {},
    addedDots: [],
  };

  if (grid.family.kind === 'diamond') {
    const mid = 2 * grid.family.p - 1;
    return {
      ...common,
      type: 'diamond',
      formula: `1-${mid}-1`,
      size: mid,
    };
  }

  if (grid.family.kind === 'square') {
    const { m, n } = grid.family;
    return {
      ...common,
      type: 'square',
      formula: `${m}x${n}`,
      size: m === n ? m : Math.max(m, n),
      cols: m,
      rows: n,
    };
  }

  if (rowHint && rowHint.length > 0) {
    return {
      ...common,
      type: 'formula',
      formula: rowHint.join('-'),
      size: Math.max(...rowHint),
    };
  }

  const addedDots = grid.dots.map((pt, idx) => {
    const u = toUnitPoint(pt, grid);
    return {
      id: `custom_mp_${idx}`,
      gx: u.x,
      gy: u.y,
      ringed: Math.abs(u.x) < 0.01 && Math.abs(u.y) < 0.01,
    };
  });

  return {
    ...common,
    type: 'custom',
    formula: `custom-${addedDots.length}`,
    size: 5,
    addedDots,
  };
}

function describeGrid(
  grid: Grid,
  customLabel?: string,
  rowHint?: number[],
  offset: KolamPoint = { x: 0, y: 0 }
): GridMeta {
  gridOffsetMap.set(grid, offset);
  const count = grid.count();
  let label = customLabel ?? '';
  if (!label) {
    if (grid.family.kind === 'diamond') {
      label = `1-${2 * grid.family.p - 1}-1 Diamond`;
    } else if (grid.family.kind === 'square') {
      label = `${grid.family.m}×${grid.family.n} Square`;
    } else if (rowHint && rowHint.length > 0) {
      label = `${rowHint.join('-')} Sequence`;
    } else {
      label = `Custom (${grid.dots.length} dots)`;
    }
  }

  const siteCoords = grid.sitePositions.map((pt, index) => {
    const u = toUnitPoint(pt, grid, offset);
    return { index, x: u.x, y: u.y };
  });

  const dotsSignature = grid.dots
    .map((pt) => {
      const u = toUnitPoint(pt, grid, offset);
      return `${u.x},${u.y}`;
    })
    .join(';');

  return {
    ok: true,
    grid,
    label,
    sites: grid.sites,
    dotCount: grid.dots.length,
    countStr: count.toString(),
    formattedCount: formatBigIntCount(count),
    symmetryClasses: symmetryClassesFor(grid),
    dotsSignature,
    offset,
    siteCoords,
    kolamGridConfig: gridToKolamConfig(grid, undefined, rowHint),
  };
}

export function createGrid(
  spec: GridSpec
): GridMeta | { ok: false; error: string } {
  try {
    let family: Family;
    let rowHint: number[] | undefined;
    if (spec.kind === 'diamond') {
      family = { kind: 'diamond', p: Math.max(1, Math.min(26, Math.round(spec.p))) };
    } else if (spec.kind === 'square') {
      family = {
        kind: 'square',
        m: Math.max(1, Math.min(30, Math.round(spec.m))),
        n: Math.max(1, Math.min(30, Math.round(spec.n))),
      };
    } else if (spec.kind === 'rows') {
      rowHint = spec.rows;
      family = { kind: 'custom', dots: dotsFromRows(spec.rows) };
    } else {
      family = { kind: 'custom', dots: spec.dots };
    }
    const grid = Grid.of(family);
    return describeGrid(grid, spec.kind === 'rows' || spec.kind === 'custom' ? spec.label : undefined, rowHint);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to construct Muggula Prastāram grid.',
    };
  }
}

export function gridFromKolamConfig(
  gridConfig: KolamGridConfig,
  effectiveDots: Array<{ gx: number; gy: number }>
): GridMeta | { ok: false; error: string } {
  try {
    const hasEdits =
      (gridConfig.deletedIds && gridConfig.deletedIds.length > 0) ||
      (gridConfig.addedDots && gridConfig.addedDots.length > 0);

    if (!hasEdits) {
      if (gridConfig.type === 'square') {
        const m = Math.max(2, Math.min(30, Number(gridConfig.cols ?? gridConfig.size) || 5));
        const n = Math.max(2, Math.min(30, Number(gridConfig.rows ?? gridConfig.size) || 5));
        const meta = createGrid({ kind: 'square', m, n });
        if (meta.ok) meta.kolamGridConfig = gridToKolamConfig(meta.grid, gridConfig);
        return meta;
      }

      if (gridConfig.type === 'diamond') {
        const parts = String(gridConfig.formula || '1-7-1')
          .split(/[^0-9]+/)
          .map((x) => parseInt(x, 10))
          .filter((x) => !Number.isNaN(x) && x >= 1);
        const maxWidth = parts.length >= 2 ? Math.max(...parts) : 7;
        const p = Math.max(2, Math.min(26, Math.round((maxWidth + 1) / 2)));
        const meta = createGrid({ kind: 'diamond', p });
        if (meta.ok) meta.kolamGridConfig = gridToKolamConfig(meta.grid, gridConfig);
        return meta;
      }

      if (gridConfig.type === 'formula') {
        const rows = String(gridConfig.formula || '1-3-3-1')
          .split(/[^0-9]+/)
          .map((x) => parseInt(x, 10))
          .filter((x) => !Number.isNaN(x) && x >= 1 && x <= 51);
        if (rows.length > 0) {
          const meta = createGrid({ kind: 'rows', rows });
          if (meta.ok) meta.kolamGridConfig = gridToKolamConfig(meta.grid, gridConfig, rows);
          return meta;
        }
        return { ok: false, error: 'Enter a valid row sequence such as 1-3-3-1 or 7-5-3-1.' };
      }
    }

    if (gridConfig.type === 'staggered' && !hasEdits) {
      return {
        ok: false,
        error: 'Staggered triangular grids use half-row offsets; select Square, Diamond, or parity-aligned Sequence for Muggula Prastāram.',
      };
    }

    if (!effectiveDots || effectiveDots.length === 0) {
      return { ok: false, error: 'Place at least 1 Pulli dot on the canvas to generate Prastāram gates.' };
    }

    // Snap custom dots to integer lattice coordinates (flipping Y back to y-up)
    const minGx = Math.min(...effectiveDots.map((d) => d.gx));
    const maxGx = Math.max(...effectiveDots.map((d) => d.gx));
    const minGy = Math.min(...effectiveDots.map((d) => d.gy));
    const maxGy = Math.max(...effectiveDots.map((d) => d.gy));
    const offset: KolamPoint = {
      x: Number(((minGx + maxGx) / 2).toFixed(4)),
      y: Number(((minGy + maxGy) / 2).toFixed(4)),
    };

    const intDots: Array<[number, number]> = [];
    for (const d of effectiveDots) {
      const ix = d.gx - minGx;
      const iy = maxGy - d.gy;
      if (Math.abs(ix - Math.round(ix)) > 0.08 || Math.abs(iy - Math.round(iy)) > 0.08) {
        return {
          ok: false,
          error: 'Custom dots must sit on an orthogonal integer Pulli lattice for Prastāram.',
        };
      }
      intDots.push([Math.round(ix), Math.round(iy)]);
    }

    const customGrid = Grid.of({ kind: 'custom', dots: intDots });
    const meta = describeGrid(customGrid, undefined, undefined, offset);
    meta.kolamGridConfig = {
      ...gridConfig,
      deletedIds: [...(gridConfig.deletedIds || [])],
      ringOverrides: { ...(gridConfig.ringOverrides || {}) },
      addedDots: [...(gridConfig.addedDots || [])],
    };
    return meta;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Incompatible dot layout for Prastāram.',
    };
  }
}

export function decodePattern(
  grid: Grid,
  indexInput: string | number | bigint,
  renderOpts: RenderConversionOptions = {}
): SerializedPattern | { ok: false; error: string } {
  try {
    const idx = parseBigIntIndex(indexInput, grid.count());
    const pat = Pattern.decode(grid, idx);
    return serializePattern(pat, renderOpts);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid Prastāra index.',
    };
  }
}

export function searchPattern(
  grid: Grid,
  opts: { strokes?: number; symmetry?: SymClass; seed: string; maxIterations?: number },
  renderOpts: RenderConversionOptions = {}
): (SerializedPattern & { achieved: number; target: number }) | { ok: false; error: string } {
  try {
    const target = opts.strokes && opts.strokes >= 1 ? Math.round(opts.strokes) : 1;
    const avail = symmetryClassesFor(grid);
    const symmetry: SymClass =
      opts.symmetry && avail.includes(opts.symmetry) ? opts.symmetry : 'none';
    const { pattern, achieved } = Pattern.search(grid, {
      strokes: target,
      symmetry,
      seed: opts.seed || 'kolam',
      maxIterations: opts.maxIterations ?? 640,
    });
    const serialized = serializePattern(pattern, renderOpts);
    return {
      ...serialized,
      achieved,
      target,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Pattern search failed.',
    };
  }
}

export function randomPattern(
  grid: Grid,
  opts: { symmetry?: SymClass; seed: string },
  renderOpts: RenderConversionOptions = {}
): SerializedPattern | { ok: false; error: string } {
  try {
    const avail = symmetryClassesFor(grid);
    const symmetry: SymClass =
      opts.symmetry && avail.includes(opts.symmetry) ? opts.symmetry : 'none';
    const pat = Pattern.random(grid, {
      symmetry,
      seed: opts.seed || String(Date.now()),
    });
    return serializePattern(pat, renderOpts);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Random pattern generation failed.',
    };
  }
}

export type DrawSymmetryMode = '1x' | 'hori' | 'vert' | '4x' | '8x';

export function findSymmetricSiteIndices(
  siteCoords: Array<{ index: number; x: number; y: number }>,
  targetIndex: number,
  symMode: DrawSymmetryMode = '1x'
): number[] {
  const origin = siteCoords.find((s) => s.index === targetIndex);
  if (!origin) return [];
  if (symMode === '1x') return [origin.index];

  const { x, y } = origin;
  const targets: Array<[number, number]> = [[x, y]];
  if (symMode === 'hori') {
    targets.push([-x, y]);
  } else if (symMode === 'vert') {
    targets.push([x, -y]);
  } else if (symMode === '4x') {
    targets.push([-x, y], [x, -y], [-x, -y]);
  } else if (symMode === '8x') {
    targets.push(
      [-x, y],
      [x, -y],
      [-x, -y],
      [y, x],
      [-y, x],
      [y, -x],
      [-y, -x]
    );
  }

  const matched = new Set<number>([origin.index]);
  for (const [tx, ty] of targets) {
    let bestIdx = -1;
    let bestDist = 0.08;
    for (const sc of siteCoords) {
      const d = Math.hypot(sc.x - tx, sc.y - ty);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = sc.index;
      }
    }
    if (bestIdx >= 0) matched.add(bestIdx);
  }
  return Array.from(matched);
}

export function togglePatternGate(
  pattern: Pattern,
  siteIndex: number,
  renderOpts: RenderConversionOptions = {}
): SerializedPattern | { ok: false; error: string } {
  try {
    const next = pattern.toggle(siteIndex);
    return serializePattern(next, renderOpts);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not toggle gate site.',
    };
  }
}

export function togglePatternGates(
  pattern: Pattern,
  siteIndices: number[],
  renderOpts: RenderConversionOptions = {},
  desiredValue?: boolean
): SerializedPattern | { ok: false; error: string } {
  try {
    const unique = Array.from(
      new Set(
        siteIndices.filter(
          (idx) => Number.isInteger(idx) && idx >= 0 && idx < pattern.grid.sites
        )
      )
    );
    if (unique.length === 0) {
      return { ok: false, error: 'No valid gate site selected.' };
    }
    let next = pattern;
    for (const idx of unique) {
      if (desiredValue === undefined || next.gate(idx) !== desiredValue) {
        next = next.toggle(idx);
      }
    }
    return serializePattern(next, renderOpts);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not toggle gate sites.',
    };
  }
}

export function enumeratePreviewBatch(
  grid: Grid,
  opts: { strokes?: number; symmetry?: SymClass; maxResults?: number; maxVisited?: number } = {},
  renderOpts: RenderConversionOptions = {}
): { ok: true; items: SerializedPattern[]; visited: number; exhausted: boolean } | { ok: false; error: string } {
  try {
    const maxResults = opts.maxResults ?? 12;
    const maxVisited = opts.maxVisited ?? 4000;
    const targetStrokes = opts.strokes && opts.strokes >= 1 ? Math.round(opts.strokes) : undefined;
    const avail = symmetryClassesFor(grid);
    const symmetry: SymClass =
      opts.symmetry && avail.includes(opts.symmetry) ? opts.symmetry : 'none';
    const items: SerializedPattern[] = [];
    let visited = 0;
    let exhausted = true;

    const gen = enumerate(grid, { symmetry });

    for (const pat of gen) {
      visited++;
      if (targetStrokes === undefined || pat.strokeCount() === targetStrokes) {
        items.push(serializePattern(pat, renderOpts));
        if (items.length >= maxResults) {
          exhausted = false;
          break;
        }
      }
      if (visited >= maxVisited) {
        exhausted = false;
        break;
      }
    }

    return { ok: true, items, visited, exhausted };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Enumeration failed.',
    };
  }
}

export const MuggulaPrastaramBridge = {
  Grid,
  Pattern,
  dotsFromRows,
  symmetryClassesFor,
  createGrid,
  gridFromKolamConfig,
  gridToKolamConfig,
  decodePattern,
  searchPattern,
  randomPattern,
  togglePatternGate,
  togglePatternGates,
  findSymmetricSiteIndices,
  enumeratePreviewBatch,
  serializePattern,
  sampleMirrorCurveStroke,
  formatBigIntCount,
  parseBigIntIndex,
};

declare global {
  interface Window {
    MuggulaPrastaram?: typeof MuggulaPrastaramBridge;
  }
}

window.MuggulaPrastaram = MuggulaPrastaramBridge;
window.dispatchEvent(new CustomEvent('muggula-prastaram-ready', { detail: MuggulaPrastaramBridge }));

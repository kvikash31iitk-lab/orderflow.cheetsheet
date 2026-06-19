// Pure series-math helpers exposed to indicator scripts. All return a NEW array of
// the SAME length as the input, padded with NaN during the warm-up window so a
// script can safely `points[i]` against the candle at index i. No host access.

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function sma(values: number[], length: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const len = Math.max(1, Math.floor(length));
  for (let i = 0; i < n; i++) {
    if (i < len - 1) continue;
    let s = 0;
    let c = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const v = toNum(values[j]);
      if (Number.isFinite(v)) {
        s += v;
        c++;
      }
    }
    out[i] = c > 0 ? s / c : NaN;
  }
  return out;
}

export function ema(values: number[], length: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const len = Math.max(1, Math.floor(length));
  const alpha = 2 / (len + 1);
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = toNum(values[i]);
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    prev = Number.isFinite(prev) ? alpha * v + (1 - alpha) * prev : v;
    out[i] = prev;
  }
  return out;
}

export function highest(values: number[], length: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const len = Math.max(1, Math.floor(length));
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    let c = 0;
    for (let j = Math.max(0, i - len + 1); j <= i; j++) {
      const v = toNum(values[j]);
      if (Number.isFinite(v)) {
        if (v > m) m = v;
        c++;
      }
    }
    out[i] = c > 0 ? m : NaN;
  }
  return out;
}

export function lowest(values: number[], length: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const len = Math.max(1, Math.floor(length));
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    let c = 0;
    for (let j = Math.max(0, i - len + 1); j <= i; j++) {
      const v = toNum(values[j]);
      if (Number.isFinite(v)) {
        if (v < m) m = v;
        c++;
      }
    }
    out[i] = c > 0 ? m : NaN;
  }
  return out;
}

export function sum(values: number[], length: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const len = Math.max(1, Math.floor(length));
  for (let i = 0; i < n; i++) {
    if (i < len - 1) continue;
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const v = toNum(values[j]);
      if (Number.isFinite(v)) s += v;
    }
    out[i] = s;
  }
  return out;
}

export function change(values: number[]): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const a = toNum(values[i]);
    const b = toNum(values[i - 1]);
    out[i] = Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
  }
  return out;
}

// crossOver: true at index i where series a crosses from <= b to > b.
// b may be an array (per-bar) or a scalar threshold.
export function crossOver(a: number[], b: number[] | number): boolean[] {
  const n = a.length;
  const out = new Array<boolean>(n).fill(false);
  const bAt = (i: number) => (Array.isArray(b) ? toNum(b[i]) : toNum(b));
  for (let i = 1; i < n; i++) {
    const a0 = toNum(a[i - 1]);
    const a1 = toNum(a[i]);
    const b0 = bAt(i - 1);
    const b1 = bAt(i);
    if (Number.isFinite(a0) && Number.isFinite(a1) && Number.isFinite(b0) && Number.isFinite(b1)) {
      out[i] = a0 <= b0 && a1 > b1;
    }
  }
  return out;
}

export function crossUnder(a: number[], b: number[] | number): boolean[] {
  const n = a.length;
  const out = new Array<boolean>(n).fill(false);
  const bAt = (i: number) => (Array.isArray(b) ? toNum(b[i]) : toNum(b));
  for (let i = 1; i < n; i++) {
    const a0 = toNum(a[i - 1]);
    const a1 = toNum(a[i]);
    const b0 = bAt(i - 1);
    const b1 = bAt(i);
    if (Number.isFinite(a0) && Number.isFinite(a1) && Number.isFinite(b0) && Number.isFinite(b1)) {
      out[i] = a0 >= b0 && a1 < b1;
    }
  }
  return out;
}

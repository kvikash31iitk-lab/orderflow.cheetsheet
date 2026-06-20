import { api } from "../api/rest";
import type { FootprintCandle } from "../types/orderflow";
import type { IndicatorDataContext, IndicatorDataStatus, IndicatorInstance } from "./types";

const TF_MINUTES: Record<string, number> = {
  tick: 0,
  "1m": 1,
  "2m": 2,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1D": 1440,
};

const MAX_PREFETCH_LIMIT = 25000;
const CACHE_TTL_MS = 2500;

interface CacheEntry {
  expiresAt: number;
  promise: Promise<FootprintCandle[]>;
}

interface Requirements {
  footprints: Set<string>;
  securities: Set<string>;
}

const cache = new Map<string, CacheEntry>();

function normalizeTimeframe(tf: unknown): string | null {
  const value = String(tf ?? "").trim();
  if (!value) return null;
  return TF_MINUTES[value] !== undefined ? value : null;
}

function estimateLimit(parentTf: string, childTf: string, parentCount: number): number {
  const parentMinutes = TF_MINUTES[parentTf];
  const childMinutes = TF_MINUTES[childTf];
  if (parentCount <= 0) return 1000;
  if (parentMinutes === undefined || childMinutes === undefined) return Math.min(MAX_PREFETCH_LIMIT, parentCount + 500);
  if (childMinutes <= 0 || parentMinutes <= 0) return Math.min(MAX_PREFETCH_LIMIT, Math.max(5000, parentCount * 5));
  const ratio = Math.max(1, Math.ceil(parentMinutes / childMinutes));
  const raw = parentCount * ratio + 500;
  return Math.min(MAX_PREFETCH_LIMIT, Math.max(parentCount, Math.ceil(raw / 500) * 500));
}

function extractCalls(script: string, fnName: "requestFootprint" | "requestSecurity"): string[] {
  const out: string[] = [];
  const re = new RegExp(`${fnName}\\s*\\(\\s*(["'])([^"']+)\\1`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(script))) {
    const tf = normalizeTimeframe(m[2]);
    if (tf) out.push(tf);
  }
  return out;
}

export function indicatorDataRequirements(indicators: IndicatorInstance[]): Requirements {
  const req: Requirements = { footprints: new Set(), securities: new Set() };
  for (const ind of indicators) {
    if (!ind.enabled || typeof ind.script !== "string") continue;
    for (const tf of extractCalls(ind.script, "requestFootprint")) req.footprints.add(tf);
    for (const tf of extractCalls(ind.script, "requestSecurity")) req.securities.add(tf);
  }
  return req;
}

function cachedFootprints(symbol: string, timeframe: string, limit: number, cells: boolean): Promise<FootprintCandle[]> {
  const roundedLimit = Math.min(MAX_PREFETCH_LIMIT, Math.max(1, Math.ceil(limit / 500) * 500));
  const key = `${symbol}:${timeframe}:${roundedLimit}:${cells ? "cells" : "bars"}`;
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = api
    .footprints(symbol, timeframe, undefined, roundedLimit, cells)
    .then((r) => r.candles || [])
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, promise });
  return promise;
}

export async function loadIndicatorDataContext(
  indicators: IndicatorInstance[],
  candles: FootprintCandle[],
  symbol: string,
  timeframe: string,
): Promise<IndicatorDataContext> {
  const req = indicatorDataRequirements(indicators);
  const footprints: Record<string, FootprintCandle[]> = {};
  const securities: Record<string, FootprintCandle[]> = {};
  const status: Record<string, IndicatorDataStatus> = {};

  const tasks: Promise<void>[] = [];

  for (const tf of req.footprints) {
    if (tf === timeframe && candles.some((c) => Array.isArray(c.cells) && c.cells.length > 0)) {
      footprints[tf] = candles;
      status[`footprint:${tf}`] = { ok: true, candles: candles.length };
      continue;
    }
    const limit = estimateLimit(timeframe, tf, candles.length);
    tasks.push(
      cachedFootprints(symbol, tf, limit, true)
        .then((rows) => {
          footprints[tf] = rows;
          status[`footprint:${tf}`] = { ok: true, candles: rows.length };
        })
        .catch((err) => {
          footprints[tf] = [];
          status[`footprint:${tf}`] = { ok: false, candles: 0, error: err instanceof Error ? err.message : String(err) };
        }),
    );
  }

  for (const tf of req.securities) {
    if (tf === timeframe) {
      securities[tf] = candles;
      status[`security:${tf}`] = { ok: true, candles: candles.length };
      continue;
    }
    const limit = estimateLimit(timeframe, tf, candles.length);
    tasks.push(
      cachedFootprints(symbol, tf, limit, false)
        .then((rows) => {
          securities[tf] = rows;
          status[`security:${tf}`] = { ok: true, candles: rows.length };
        })
        .catch((err) => {
          securities[tf] = [];
          status[`security:${tf}`] = { ok: false, candles: 0, error: err instanceof Error ? err.message : String(err) };
        }),
    );
  }

  await Promise.all(tasks);
  return { footprints, securities, status };
}

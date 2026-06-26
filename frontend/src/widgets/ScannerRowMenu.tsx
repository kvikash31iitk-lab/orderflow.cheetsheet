// Right-click menu for a scanner row. Left-click already opens the symbol/timeframe in the chart;
// this adds copy helpers without changing that behaviour.
import { Copy, LineChart, Tag } from "lucide-react";
import { useStore } from "../store/useStore";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";
import type { ScannerRow } from "../types/orderflow";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

export default function ScannerRowMenu({ x, y, row, onClose }: { x: number; y: number; row: ScannerRow; onClose: () => void }) {
  const selectChartContext = useStore((s) => s.selectChartContext);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const summary =
    `${row.symbol} (${row.timeframe})  Δ ${Math.round(row.delta)}  CumΔ ${Math.round(row.cumDelta)}  ${row.trend ?? "—"}` +
    (row.signals.length ? `  [${row.signals.join(", ")}]` : "");

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      <MenuItem icon={<LineChart size={13} />} label="Open in chart" onClick={act(() => selectChartContext(row.symbol, row.timeframe))} />
      <MenuSeparator />
      <MenuItem icon={<Tag size={13} />} label="Copy symbol" onClick={act(() => copyText(row.symbol))} />
      <MenuItem icon={<Copy size={13} />} label="Copy row summary" onClick={act(() => copyText(summary))} />
      {row.signals.length > 0 && (
        <MenuItem icon={<Copy size={13} />} label="Copy signal names" onClick={act(() => copyText(row.signals.join(", ")))} />
      )}
    </TerminalMenu>
  );
}

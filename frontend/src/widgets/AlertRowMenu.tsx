// Right-click menu for an alert row — open the alert's symbol/timeframe in the chart and copy helpers.
import { Clock, Copy, LineChart, MessageSquare } from "lucide-react";
import { useStore } from "../store/useStore";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";
import { formatIstDateTime } from "../lib/time";
import type { AlertMsg } from "../types/orderflow";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

export default function AlertRowMenu({ x, y, alert, onClose }: { x: number; y: number; alert: AlertMsg; onClose: () => void }) {
  const selectChartContext = useStore((s) => s.selectChartContext);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const timeStr = `${formatIstDateTime(alert.ts)} IST`;
  const summary = `${alert.type} — ${alert.symbol} ${alert.timeframe}: ${alert.message}  (${timeStr})`;

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      <MenuItem icon={<LineChart size={13} />} label="Open in chart" onClick={act(() => selectChartContext(alert.symbol, alert.timeframe))} />
      <MenuSeparator />
      <MenuItem icon={<Copy size={13} />} label="Copy alert summary" onClick={act(() => copyText(summary))} />
      <MenuItem icon={<MessageSquare size={13} />} label="Copy alert message" onClick={act(() => copyText(alert.message))} />
      <MenuItem icon={<Clock size={13} />} label="Copy alert time" onClick={act(() => copyText(timeStr))} />
    </TerminalMenu>
  );
}

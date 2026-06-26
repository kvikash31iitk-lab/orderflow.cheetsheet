// Right-click menu for the Bar Statistics pane. The host pane resolves the metric + time under the
// cursor (when it can) and passes them in; store actions are read here directly.
import { Clock, Copy, EyeOff, RotateCcw, Settings } from "lucide-react";
import { useStore } from "../store/useStore";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";
import { formatIstDateTime } from "../lib/time";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

export default function BarStatsContextMenu({
  x,
  y,
  time,
  metricShort,
  valueStr,
  onClose,
}: {
  x: number;
  y: number;
  time: number | null; // epoch ms of the bar under the cursor
  metricShort: string | null; // short label of the metric row under the cursor
  valueStr: string | null; // formatted value under the cursor
  onClose: () => void;
}) {
  const setBarStatsSettingsOpen = useStore((s) => s.setBarStatsSettingsOpen);
  const setShowBarStats = useStore((s) => s.setShowBarStats);
  const resetBarStatsSettings = useStore((s) => s.resetBarStatsSettings);
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const timeStr = time != null ? `${formatIstDateTime(time)} IST` : "";

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      <MenuItem icon={<Settings size={13} />} label="Bar Statistics Settings…" onClick={act(() => setBarStatsSettingsOpen(true))} />
      <MenuItem icon={<EyeOff size={13} />} label="Hide Bar Statistics" onClick={act(() => setShowBarStats(false))} />
      {(valueStr || time != null) && <MenuSeparator />}
      {valueStr && metricShort && (
        <MenuItem icon={<Copy size={13} />} label={`Copy ${metricShort}  ${valueStr}`} onClick={act(() => copyText(valueStr))} />
      )}
      {time != null && <MenuItem icon={<Clock size={13} />} label={`Copy time  ${timeStr}`} onClick={act(() => copyText(timeStr))} />}
      <MenuSeparator />
      <MenuItem icon={<RotateCcw size={13} />} label="Reset Bar Statistics defaults" danger onClick={act(() => resetBarStatsSettings())} />
    </TerminalMenu>
  );
}

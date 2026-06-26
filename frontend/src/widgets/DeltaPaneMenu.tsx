// Right-click menu shared by the Cumulative Delta and Delta Histogram sub-panes. The host pane
// resolves the bar under the cursor (value + time) and passes it in; this just renders the actions.
import { Clock, Copy, EyeOff, Maximize2 } from "lucide-react";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";
import { formatIstDateTime } from "../lib/time";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

export default function DeltaPaneMenu({
  x,
  y,
  time,
  value,
  valueLabel,
  onResetScale,
  onHide,
  hideLabel,
  onClose,
}: {
  x: number;
  y: number;
  time: number | null; // epoch ms of the bar under the cursor
  value: number | null;
  valueLabel: string; // "Cum Δ" / "Δ"
  onResetScale: () => void;
  onHide?: () => void;
  hideLabel: string;
  onClose: () => void;
}) {
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const timeStr = time != null ? `${formatIstDateTime(time)} IST` : "";
  const valStr = value != null ? (Number.isInteger(value) ? String(value) : value.toFixed(2)) : "";
  const hasReadout = value != null || time != null;

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      {value != null && <MenuItem icon={<Copy size={13} />} label={`Copy ${valueLabel}  ${valStr}`} onClick={act(() => copyText(valStr))} />}
      {time != null && <MenuItem icon={<Clock size={13} />} label={`Copy time  ${timeStr}`} onClick={act(() => copyText(timeStr))} />}
      {value != null && time != null && (
        <MenuItem icon={<Copy size={13} />} label="Copy value + time" onClick={act(() => copyText(`${valStr}  ${timeStr}`))} />
      )}
      {hasReadout && <MenuSeparator />}
      <MenuItem icon={<Maximize2 size={13} />} label="Reset pane scale" onClick={act(onResetScale)} />
      {onHide && <MenuItem icon={<EyeOff size={13} />} label={hideLabel} onClick={act(onHide)} />}
    </TerminalMenu>
  );
}

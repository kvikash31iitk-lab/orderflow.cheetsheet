// Right-click menu for an Anchored VWAP hit on the chart canvas. The chart resolves the anchor
// time/price + the AVWAP value nearest the cursor and a center-on-anchor callback; store actions
// are read here. Does NOT change AVWAP math or plotting — menu affordances only.
import { Anchor, Clock, Copy, Crosshair, Eye, EyeOff, Settings, Trash2 } from "lucide-react";
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

export default function AvwapObjectMenu({
  indicatorId,
  anchorTime,
  anchorPrice,
  valueHere,
  x,
  y,
  onCenter,
  onClose,
}: {
  indicatorId: string;
  anchorTime: number | null;
  anchorPrice: number | null;
  valueHere: number | null; // AVWAP value nearest the cursor
  x: number;
  y: number;
  onCenter: () => void;
  onClose: () => void;
}) {
  const ind = useStore((s) => s.indicators.find((i) => i.id === indicatorId));
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const setSettingsIndicatorId = useStore((s) => s.setSettingsIndicatorId);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const beginAnchorPick = useStore((s) => s.beginIndicatorAnchorPick);
  if (!ind) return null;

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const timeStr = anchorTime != null ? `${formatIstDateTime(anchorTime)} IST` : "";
  const priceStr = anchorPrice != null ? anchorPrice.toFixed(2) : "";
  const valStr = valueHere != null ? valueHere.toFixed(2) : "";
  const summary =
    `${ind.name}` + (anchorTime != null ? `  ·  anchor ${timeStr}` : "") + (valueHere != null ? `  ·  value ${valStr}` : "");

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      <MenuItem
        icon={ind.enabled ? <EyeOff size={13} /> : <Eye size={13} />}
        label={ind.enabled ? "Hide" : "Show"}
        onClick={act(() => toggleIndicator(indicatorId))}
      />
      <MenuItem icon={<Settings size={13} />} label="Settings…" onClick={act(() => setSettingsIndicatorId(indicatorId))} />
      <MenuItem icon={<Anchor size={13} />} label="Re-anchor — then click a candle" onClick={act(() => beginAnchorPick(indicatorId))} />
      <MenuSeparator />
      {anchorTime != null && <MenuItem icon={<Clock size={13} />} label={`Copy anchor time  ${timeStr}`} onClick={act(() => copyText(timeStr))} />}
      {anchorPrice != null && <MenuItem icon={<Copy size={13} />} label={`Copy anchor price  ${priceStr}`} onClick={act(() => copyText(priceStr))} />}
      {valueHere != null && <MenuItem icon={<Copy size={13} />} label={`Copy value here  ${valStr}`} onClick={act(() => copyText(valStr))} />}
      <MenuItem icon={<Copy size={13} />} label="Copy summary" onClick={act(() => copyText(summary))} />
      <MenuSeparator />
      <MenuItem icon={<Crosshair size={13} />} label="Center on anchor" onClick={act(onCenter)} />
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={13} />} label="Delete" danger onClick={act(() => removeIndicator(indicatorId))} />
    </TerminalMenu>
  );
}

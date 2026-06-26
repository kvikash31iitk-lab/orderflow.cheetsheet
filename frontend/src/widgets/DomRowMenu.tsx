// Right-click menu for a DOM Ladder price row. Inspection / charting only — NO live order actions
// (Buy/Sell/Flatten stay on their dedicated buttons). The host resolves recenter + H-line creation.
import { Copy, Crosshair, Minus, Tag } from "lucide-react";
import { MenuItem, MenuSeparator, TerminalMenu } from "../components/TerminalContextMenu";

function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)?.catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

export default function DomRowMenu({
  x,
  y,
  row,
  dp,
  symbol,
  onRecenter,
  onAddHLine,
  onClose,
}: {
  x: number;
  y: number;
  row: { price: number; bidSize: number; askSize: number };
  dp: number;
  symbol: string;
  onRecenter: () => void;
  onAddHLine: (price: number) => void;
  onClose: () => void;
}) {
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const priceStr = row.price.toFixed(dp);
  const summary = `${symbol}  ${priceStr}   bid ${row.bidSize}   ask ${row.askSize}`;

  return (
    <TerminalMenu x={x} y={y} onClose={onClose}>
      <MenuItem icon={<Tag size={13} />} label={`Copy price  ${priceStr}`} onClick={act(() => copyText(priceStr))} />
      {row.bidSize > 0 && (
        <MenuItem icon={<Copy size={13} />} label={`Copy bid depth  ${row.bidSize}`} onClick={act(() => copyText(String(row.bidSize)))} />
      )}
      {row.askSize > 0 && (
        <MenuItem icon={<Copy size={13} />} label={`Copy ask depth  ${row.askSize}`} onClick={act(() => copyText(String(row.askSize)))} />
      )}
      <MenuItem icon={<Copy size={13} />} label="Copy row summary" onClick={act(() => copyText(summary))} />
      <MenuSeparator />
      <MenuItem icon={<Minus size={13} />} label="Add horizontal line here" onClick={act(() => onAddHLine(row.price))} />
      <MenuItem icon={<Crosshair size={13} />} label="Recenter ladder" onClick={act(onRecenter)} />
    </TerminalMenu>
  );
}

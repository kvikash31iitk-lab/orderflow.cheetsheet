// Footprint setting presets. Each preset sets a coherent group of options (not one field)
// so switching gives a complete, recognisable look. `mode` (optional) also sets the
// single-column text format via the existing footprintMode selector.
import type { FootprintMode, FootprintSettings } from "../types/orderflow";

export interface FootprintPreset {
  name: string;
  hint: string;
  mode?: FootprintMode;
  settings: Partial<FootprintSettings>;
}

export const FOOTPRINT_PRESETS: FootprintPreset[] = [
  {
    name: "Clean",
    hint: "Single column, delta-hued cells, POC + imbalances",
    mode: "bidAsk",
    settings: {
      showCluster: true,
      clusterColumns: "single",
      colorMatrix: "default",
      autoFontSize: true,
      showProfile: false,
      showImbalances: true,
      showPoc: true,
      showPocMarker: false,
      extendPoc: false,
      leftBackground: false,
      rightBackground: false,
      showVwap: false,
      showSdBands: false,
      showBadges: false,
      showThinCandle: true,
    },
  },
  {
    name: "GoCharting-like",
    hint: "Double column sell × buy, POC marker + extend",
    settings: {
      showCluster: true,
      clusterColumns: "double",
      colorMatrix: "default",
      autoFontSize: true,
      showProfile: false,
      leftFormat: "sellVolume",
      rightFormat: "buyVolume",
      showImbalances: true,
      showPoc: true,
      showPocMarker: true,
      extendPoc: true,
      showThinCandle: true,
      showBadges: false,
    },
  },
  {
    name: "Delta-heavy",
    hint: "Delta-magnitude colour matrix, single column",
    mode: "delta",
    settings: {
      showCluster: true,
      clusterColumns: "single",
      colorMatrix: "delta",
      autoFontSize: true,
      showProfile: false,
      showImbalances: true,
      showPoc: true,
      showThinCandle: true,
    },
  },
  {
    name: "Volume-heavy",
    hint: "Volume colour matrix + profile bars + POC extend",
    mode: "volume",
    settings: {
      showCluster: true,
      clusterColumns: "single",
      colorMatrix: "volume",
      autoFontSize: true,
      showProfile: true,
      showImbalances: false,
      showPoc: true,
      showPocMarker: true,
      extendPoc: true,
      showThinCandle: true,
    },
  },
  {
    name: "Minimal",
    hint: "Just the cells — no POC, imbalances or overlays",
    mode: "volume",
    settings: {
      showCluster: true,
      clusterColumns: "single",
      colorMatrix: "default",
      autoFontSize: true,
      showProfile: false,
      showImbalances: false,
      showPoc: false,
      showPocMarker: false,
      extendPoc: false,
      showVwap: false,
      showSdBands: false,
      showBadges: false,
      showThinCandle: false,
      leftBackground: false,
      rightBackground: false,
    },
  },
  {
    name: "Scalping",
    hint: "Tight double column, fixed 9px, looser imbalance ratio",
    settings: {
      showCluster: true,
      clusterColumns: "double",
      colorMatrix: "delta",
      autoFontSize: false,
      fixedFontSize: 9,
      showProfile: false,
      leftFormat: "sellVolume",
      rightFormat: "buyVolume",
      showImbalances: true,
      imbalanceRatio: 2.0,
      showPoc: true,
      showPocMarker: true,
      extendPoc: false,
      showThinCandle: true,
      showBadges: false,
    },
  },
];

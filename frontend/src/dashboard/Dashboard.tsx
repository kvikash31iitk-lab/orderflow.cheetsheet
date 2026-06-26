import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { RotateCcw, Settings, X } from "lucide-react";
import { useStore, LAYOUT_BOUNDS } from "../store/useStore";
import FootprintChart from "../charts/FootprintChart";
import BarStatisticsPane from "../widgets/BarStatisticsPane";
import BarStatsSettingsModal from "./BarStatsSettingsModal";
import BlockSizeModal from "./BlockSizeModal";
import Header from "./Header";
import AlertsPanel from "../widgets/AlertsPanel";
import CumDelta from "../widgets/CumDelta";
import DeltaHistogram from "../widgets/DeltaHistogram";
import DomLadder from "../widgets/DomLadder";
import ReplayControls from "../widgets/ReplayControls";
import ResearchPanel from "../widgets/ResearchPanel";
import Sc1ResearchView from "../widgets/Sc1ResearchView";
import Scanner from "../widgets/Scanner";
import DrawingToolbar from "./DrawingToolbar";
import ObjectTreePanel from "../widgets/ObjectTreePanel";
import IndicatorSettingsDialog from "../widgets/IndicatorSettingsDialog";
import IndicatorSourceDialog from "../widgets/IndicatorSourceDialog";
import Splitter from "../components/Splitter";
import { MenuItem, TerminalMenu, useContextMenu } from "../components/TerminalContextMenu";

type View = "terminal" | "research" | "sc1lab";

// min-w-0 lets grid items shrink below their content's min-content width (Task 4). Right-clicking the
// header strip opens an app menu (rather than Chrome's native one) with a universal layout action.
function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  const resetAllLayout = useStore((s) => s.resetAllLayout);
  const { menu, open, close } = useContextMenu();
  return (
    <div className="panel flex min-h-0 min-w-0 flex-col rounded-none shadow-none">
      <div className="flex items-center justify-between border-b border-terminal-border" onContextMenu={(e) => open(e, {})}>
        <div className="panel-title border-b-0 rounded-t-none">{title}</div>
        {extra && <div className="px-2">{extra}</div>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      {menu && (
        <TerminalMenu x={menu.x} y={menu.y} onClose={close}>
          <MenuItem
            icon={<RotateCcw size={13} />}
            label="Reset panel layout"
            onClick={() => {
              resetAllLayout();
              close();
            }}
          />
        </TerminalMenu>
      )}
    </div>
  );
}

function Tabs({ view, setView }: { view: View; setView: (v: View) => void }) {
  const tabs: { id: View; label: string }[] = [
    { id: "terminal", label: "Terminal View" },
    { id: "research", label: "Research Suite" },
    { id: "sc1lab", label: "SC1 Research Lab" },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-terminal-border bg-terminal-panel px-3 py-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setView(t.id)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            view === t.id ? "bg-accent text-white" : "text-terminal-muted hover:bg-terminal-border/60 hover:text-terminal-text"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function PanelToggle({ label, on, set }: { label: string; on: boolean; set: Dispatch<SetStateAction<boolean>> }) {
  return (
    <button
      onClick={() => set((v) => !v)}
      title={`${on ? "Hide" : "Show"} ${label}`}
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
        on ? "bg-accent text-white" : "bg-terminal-border/60 text-terminal-muted hover:text-terminal-text"
      }`}
    >
      {label}
    </button>
  );
}

export default function Dashboard() {
  const [view, setView] = useState<View>("terminal");
  // DOM ladder + Delta Histogram default hidden (dashboard default); the rest visible.
  const [showDom, setShowDom] = useState(false);
  const [showHist, setShowHist] = useState(false);
  const [showCum, setShowCum] = useState(true);
  const [showScanner, setShowScanner] = useState(true);
  const [objectsOpen, setObjectsOpen] = useState(false);
  const setBlockSizeModalOpen = useStore((s) => s.setBlockSizeModalOpen);
  const showBarStats = useStore((s) => s.showBarStats);
  const setShowBarStats = useStore((s) => s.setShowBarStats);
  const setBarStatsSettingsOpen = useStore((s) => s.setBarStatsSettingsOpen);
  const barStatRowInfo = useStore((s) => s.barStatRowInfo);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const resetLayout = useStore((s) => s.resetLayout);
  const resetAllLayout = useStore((s) => s.resetAllLayout);

  // global ";" shortcut -> open the block-size modal, unless an editable field is focused
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ";") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      const editing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
      if (editing) return;
      e.preventDefault();
      setBlockSizeModalOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBlockSizeModalOpen]);

  // left column rows: chart always 1fr, then a splitter + the resizable panel for each
  // visible delta pane (sizes come from the persisted layout).
  const leftRows = ["1fr"];
  if (showBarStats) leftRows.push("8px", `${layout.barStatsHeight}px`);
  if (showHist) leftRows.push("8px", `${layout.histHeight}px`);
  if (showCum) leftRows.push("8px", `${layout.cumDeltaHeight}px`);

  // main columns: chart area (minmax so it can shrink) + optional DOM + optional
  // splitter + right column. Scanner & DOM both hidden -> left spans full width.
  const cols = ["minmax(0,1fr)"];
  if (showDom) cols.push(`${layout.domColumnWidth}px`);
  if (showScanner) cols.push("8px", `${layout.rightColumnWidth}px`);

  return (
    <div className="flex h-full flex-col bg-terminal-bg">
      <BlockSizeModal />
      <BarStatsSettingsModal />
      <ObjectTreePanel open={objectsOpen} onClose={() => setObjectsOpen(false)} />
      <IndicatorSettingsDialog />
      <IndicatorSourceDialog />
      <Header />
      <Tabs view={view} setView={setView} />

      {view === "research" ? (
        <div className="min-h-0 flex-1">
          <ResearchPanel />
        </div>
      ) : view === "sc1lab" ? (
        <div className="min-h-0 flex-1">
          <Sc1ResearchView />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <DrawingToolbar onOpenObjects={() => setObjectsOpen(true)} />
          <div className="grid min-h-0 flex-1 gap-0 p-0" style={{ gridTemplateColumns: cols.join(" ") }}>
          {/* left column: footprint + delta panels (each delta pane is drag-resizable) */}
          <div className="grid min-h-0 min-w-0 gap-0" style={{ gridTemplateRows: leftRows.join(" ") }}>
            <Panel
              title="Footprint Chart"
              extra={
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <PanelToggle label="DOM" on={showDom} set={setShowDom} />
                    <PanelToggle label="Hist" on={showHist} set={setShowHist} />
                    <PanelToggle label="Cum" on={showCum} set={setShowCum} />
                    <PanelToggle label="Scan" on={showScanner} set={setShowScanner} />
                    <button
                      onClick={() => setShowBarStats(!showBarStats)}
                      title={`${showBarStats ? "Hide" : "Show"} Bar Statistics`}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                        showBarStats ? "bg-accent text-white" : "bg-terminal-border/60 text-terminal-muted hover:text-terminal-text"
                      }`}
                    >
                      Stats
                    </button>
                    <button
                      onClick={resetAllLayout}
                      title="Reset panel layout to defaults"
                      className="rounded p-1 text-terminal-muted transition-colors hover:bg-terminal-border/60 hover:text-terminal-text"
                    >
                      <RotateCcw size={12} />
                    </button>
                  </div>
                  <ReplayControls />
                </div>
              }
            >
              <FootprintChart />
            </Panel>
            {showBarStats && (
              <Splitter
                axis="y"
                invert
                value={layout.barStatsHeight}
                min={LAYOUT_BOUNDS.barStatsHeight[0]}
                max={LAYOUT_BOUNDS.barStatsHeight[1]}
                onChange={(v) => setLayout({ barStatsHeight: v })}
                onReset={() => resetLayout("barStatsHeight")}
              />
            )}
            {showBarStats && (
              <Panel
                title="Bar Statistics"
                extra={
                  <div className="flex items-center gap-2">
                    {barStatRowInfo.total - barStatRowInfo.shown > 0 && (
                      <span
                        title="Some enabled metrics are unavailable for the current visible bars/timeframe"
                        className={`text-[10px] font-medium tabular-nums ${
                          barStatRowInfo.shown === 0 ? "text-amber-500/80" : "text-terminal-muted"
                        }`}
                      >
                        {barStatRowInfo.shown}/{barStatRowInfo.total} shown
                      </span>
                    )}
                    <div className="flex items-center gap-1">
                    <button
                      onClick={() => setBarStatsSettingsOpen(true)}
                      title="Bar statistics settings"
                      className="rounded p-1 text-terminal-muted transition-colors hover:bg-terminal-border/60 hover:text-terminal-text"
                    >
                      <Settings size={12} />
                    </button>
                    <button
                      onClick={() => setShowBarStats(false)}
                      title="Hide bar statistics"
                      className="rounded p-1 text-terminal-muted transition-colors hover:bg-terminal-border/60 hover:text-terminal-text"
                    >
                      <X size={12} />
                    </button>
                    </div>
                  </div>
                }
              >
                <BarStatisticsPane />
              </Panel>
            )}
            {showHist && (
              <Splitter
                axis="y"
                invert
                value={layout.histHeight}
                min={LAYOUT_BOUNDS.histHeight[0]}
                max={LAYOUT_BOUNDS.histHeight[1]}
                onChange={(v) => setLayout({ histHeight: v })}
                onReset={() => resetLayout("histHeight")}
              />
            )}
            {showHist && (
              <Panel title="Delta Histogram">
                <DeltaHistogram onHide={() => setShowHist(false)} />
              </Panel>
            )}
            {showCum && (
              <Splitter
                axis="y"
                invert
                value={layout.cumDeltaHeight}
                min={LAYOUT_BOUNDS.cumDeltaHeight[0]}
                max={LAYOUT_BOUNDS.cumDeltaHeight[1]}
                onChange={(v) => setLayout({ cumDeltaHeight: v })}
                onReset={() => resetLayout("cumDeltaHeight")}
              />
            )}
            {showCum && (
              <Panel title="Cumulative Delta">
                <CumDelta onHide={() => setShowCum(false)} />
              </Panel>
            )}
          </div>

          {/* DOM ladder drawer (collapsible) */}
          {showDom && (
            <Panel title="DOM Ladder">
              <DomLadder />
            </Panel>
          )}

          {/* vertical splitter -> right column width */}
          {showScanner && (
            <Splitter
              axis="x"
              invert
              value={layout.rightColumnWidth}
              min={LAYOUT_BOUNDS.rightColumnWidth[0]}
              max={LAYOUT_BOUNDS.rightColumnWidth[1]}
              onChange={(v) => setLayout({ rightColumnWidth: v })}
              onReset={() => resetLayout("rightColumnWidth")}
            />
          )}

          {/* right column: scanner + alerts (collapsible) */}
          {showScanner && (
            <div className="grid min-h-0 min-w-0 grid-rows-[1fr_1fr] gap-0">
              <Panel title="Order Flow Scanner">
                <Scanner />
              </Panel>
              <Panel title="Alerts">
                <AlertsPanel />
              </Panel>
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
}

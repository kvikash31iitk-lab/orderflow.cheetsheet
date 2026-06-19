import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useStore } from "../store/useStore";
import FootprintChart from "../charts/FootprintChart";
import BlockSizeModal from "./BlockSizeModal";
import Header from "./Header";
import AlertsPanel from "../widgets/AlertsPanel";
import CumDelta from "../widgets/CumDelta";
import DeltaHistogram from "../widgets/DeltaHistogram";
import DomLadder from "../widgets/DomLadder";
import ReplayControls from "../widgets/ReplayControls";
import ResearchPanel from "../widgets/ResearchPanel";
import Scanner from "../widgets/Scanner";
import DrawingToolbar from "./DrawingToolbar";
import ObjectTreePanel from "../widgets/ObjectTreePanel";

type View = "terminal" | "research";

// min-w-0 lets grid items shrink below their content's min-content width (Task 4)
function Panel({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="panel flex min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-terminal-border">
        <div className="panel-title border-b-0">{title}</div>
        {extra && <div className="px-2">{extra}</div>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function Tabs({ view, setView }: { view: View; setView: (v: View) => void }) {
  const tabs: { id: View; label: string }[] = [
    { id: "terminal", label: "Terminal View" },
    { id: "research", label: "Research Suite" },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-terminal-border bg-terminal-panel px-3 py-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setView(t.id)}
          className={`rounded px-3 py-1 text-xs font-medium ${
            view === t.id ? "bg-flow-delta text-white" : "text-terminal-muted hover:bg-terminal-border"
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
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
        on ? "bg-flow-delta text-white" : "bg-terminal-border text-terminal-muted"
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

  // left column rows: collapse hidden sub-panels; footprint always takes 1fr.
  // both delta panels hidden -> the chart takes 100% height.
  const leftRows =
    showHist && showCum ? "1fr 180px 160px" : showHist ? "1fr 180px" : showCum ? "1fr 160px" : "1fr";

  // main columns: 1fr left + optional DOM + optional right column.
  // scanner & DOM both hidden -> the left column spans the full width.
  const cols = ["1fr"];
  if (showDom) cols.push("280px");
  if (showScanner) cols.push("320px");

  return (
    <div className="flex h-full flex-col bg-terminal-bg">
      <BlockSizeModal />
      <ObjectTreePanel open={objectsOpen} onClose={() => setObjectsOpen(false)} />
      <Header />
      <Tabs view={view} setView={setView} />

      {view === "research" ? (
        <div className="min-h-0 flex-1">
          <ResearchPanel />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <DrawingToolbar onOpenObjects={() => setObjectsOpen(true)} />
          <div className="grid min-h-0 flex-1 gap-1 p-1" style={{ gridTemplateColumns: cols.join(" ") }}>
          {/* left column: footprint + delta panels */}
          <div className="grid min-h-0 min-w-0 gap-1" style={{ gridTemplateRows: leftRows }}>
            <Panel
              title="Footprint Chart"
              extra={
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1">
                    <PanelToggle label="DOM" on={showDom} set={setShowDom} />
                    <PanelToggle label="Hist" on={showHist} set={setShowHist} />
                    <PanelToggle label="Cum" on={showCum} set={setShowCum} />
                    <PanelToggle label="Scan" on={showScanner} set={setShowScanner} />
                  </div>
                  <ReplayControls />
                </div>
              }
            >
              <FootprintChart />
            </Panel>
            {showHist && (
              <Panel title="Delta Histogram">
                <DeltaHistogram />
              </Panel>
            )}
            {showCum && (
              <Panel title="Cumulative Delta">
                <CumDelta />
              </Panel>
            )}
          </div>

          {/* DOM ladder drawer (collapsible) */}
          {showDom && (
            <Panel title="DOM Ladder">
              <DomLadder />
            </Panel>
          )}

          {/* right column: scanner + alerts (collapsible) */}
          {showScanner && (
            <div className="grid min-h-0 min-w-0 grid-rows-[1fr_1fr] gap-1">
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

import { useEffect } from "react";
import Dashboard from "./dashboard/Dashboard";
import { api } from "./api/rest";
import { wsClient } from "./api/ws";
import { useStore } from "./store/useStore";

export default function App() {
  const setScanner = useStore((s) => s.setScanner);
  const loadSymbolConfigs = useStore((s) => s.loadSymbolConfigs);
  const theme = useStore((s) => s.theme);

  // drive the global light/dark tokens (CSS vars overridden under html.light).
  // toggle both so the <html> class always reflects state (index.html ships "dark").
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    wsClient.start();
    loadSymbolConfigs();   // per-symbol order-flow tuning (imbalance ratios, row size)
    const poll = setInterval(() => {
      api.scanner().then((r) => setScanner(r.rows ?? [])).catch(() => {});
    }, 2000);
    return () => clearInterval(poll);
  }, [setScanner, loadSymbolConfigs]);

  // seed the alerts panel with DB-backed recent alerts on boot (server pre-populates
  // them on restart); only if no live alert has already arrived.
  useEffect(() => {
    api
      .alerts()
      .then((r) => {
        const list = r.alerts ?? [];
        if (list.length && useStore.getState().alerts.length === 0) {
          useStore.setState({ alerts: list });
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="h-full w-full">
      <Dashboard />
    </div>
  );
}

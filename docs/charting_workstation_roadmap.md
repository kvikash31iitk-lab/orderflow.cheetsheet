# Charting Workstation Roadmap

## References

- TradingView drawings list: https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/Drawings-List/
- TradingView object tree: https://www.tradingview.com/charting-library-docs/latest/ui_elements/object-tree/
- TradingView toolbars: https://www.tradingview.com/charting-library-docs/latest/ui_elements/Toolbars/
- Lightweight Charts plugins: https://tradingview.github.io/lightweight-charts/docs/plugins/intro
- Lightweight Charts series primitives: https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives

## Implemented In This Phase

- Draggable, resizable internal workspace windows via a reusable `FloatingWindow`.
- Floating versions of Indicators, Footprint Settings, Block Size, and Object Tree.
- Symbol-scoped drawing persistence in `vikings.drawings.v1`.
- Window geometry persistence in `vikings.windows.v1`.
- Drawing toolbar with select, trendline, ray, horizontal line, vertical line, rectangle, Fibonacci retracement, brush, and text.
- Drawing renderer backed by a Lightweight Charts series primitive.
- Pointer controller for creating, selecting, moving, resizing, and deleting drawings.
- Keyboard handling for Escape, Delete, and Backspace outside editable fields.
- Object Tree for drawings and indicators, including Anchored VWAP instances.
- Selected-drawing toolbar for color, width, line style, hide/show, lock/unlock, and delete.
- AD/LP/A/E/DD signal badges off by default.

## MVP Acceptance Scope

The current target is a professional baseline, not full TradingView parity. The MVP should prove that a user can:

- Mark up charts with the core tools.
- Select and modify drawings.
- Delete drawings from the chart or Object Tree.
- Manage multiple Anchored VWAP instances from the Object Tree.
- Persist drawings and window layout across reloads.

## Recommended Phase 2

- Magnet/snap mode to candle OHLC, high-volume nodes, POC, VWAP, and session levels.
- Stay-in-drawing-mode toggle for repeated placement of the same tool.
- Undo/redo stack for drawing operations.
- Drawing style templates and per-tool defaults.
- Better text editing without browser `prompt`.
- Direct hit-testing and selection for Anchored VWAP lines/anchor markers.
- Context menu on selected drawings and indicators.
- Drawing duplication/clone.
- Full object rename/edit in Object Tree.
- Grouping/folders in Object Tree.

## Recommended Phase 3

- Drawing alerts, such as price crossing trendline/ray/zone.
- Session separators and session boxes.
- Fixed range volume profile.
- Long/short risk-reward tool.
- Price range, date range, and measured move tools.
- Screenshots/export with drawings included.
- Workspace layout save/restore.
- Keyboard shortcut customization.
- Multi-chart drawing sync rules.

## Engineering Notes

- Drawings are stored in data coordinates: epoch-ms time plus price.
- Drawings are symbol-scoped so objects from one market do not appear on another.
- Timeframe changes should reuse timestamps and price levels.
- The renderer should stay a pure drawing layer; object mutations belong in the store/controller.
- Backend storage can be added later for cross-device drawings, but localStorage is enough for this phase.

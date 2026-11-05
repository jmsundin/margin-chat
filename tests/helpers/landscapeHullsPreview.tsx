import { createRoot } from "react-dom/client";
/** Synthetic fixture only: six landscape regions of 400 points with a few strays, to see the region outlines. */
import { GraphLandscapeLayer } from "../../client/src/components/GraphLandscapeLayer";
import { landscapeRegionHue } from "../../client/src/lib/landscapeScene";
import "../../client/src/styles.css";
let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const centers = [[0, 0], [1600, 300], [700, 1400], [-1300, 1100], [2400, 1600], [-600, -1300]];
const points = centers.flatMap(([cx, cy], region) => Array.from({ length: 400 }, (_, i) => {
  const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 600 * (i % 50 === 0 ? 2.2 : 1);
  return { id: `${region}-${i}`, x: cx + Math.cos(a) * r * 1.3, y: cy + Math.sin(a) * r, hue: landscapeRegionHue(region), region };
}));
const labels = centers.map(([x, y], i) => ({ id: `r${i}`, label: ["Longevity", "Coding", "Biology", "Reading", "Health", "Margin Chat"][i], x, y, radius: 600, count: 400 }));
const theme = new URLSearchParams(location.search).get("theme") ?? "dark";
document.documentElement.dataset.theme = theme;
const viewport = { x: 640, y: 330, scale: 0.17 };
function App() {
  return <div style={{ position: "relative", width: 1280, height: 800, background: "var(--graph-canvas-bg, var(--bg-deep))" }} id="host">
    <GraphLandscapeLayer points={points} matched={null} glowing={null} selectedId={null} viewport={viewport} size={{ width: 1280, height: 800 }}
      subscribeCamera={() => () => {}} labels={labels} showLabels hostRef={{ current: null }} titleOf={(id) => id} onSelect={() => {}} onOpenLabel={() => {}} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);

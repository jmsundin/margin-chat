import "./styles.css";
import "katex/dist/katex.min.css";
import "./components/MathEquation.css";

// The page draws an outline or the saved picture of the workspace before this runs (client/build/boot-snapshot.mjs).
// The app's code takes a second or more to start on a phone, and starting it here at once would keep the screen
// blank until it finished, so it starts once that picture is on screen. A hidden page draws no frames: the timer
// starts it then.
let started = false;
function start() {
  if (started) return;
  started = true;
  void import("./start");
}
requestAnimationFrame(() => setTimeout(start, 0));
setTimeout(start, 100);

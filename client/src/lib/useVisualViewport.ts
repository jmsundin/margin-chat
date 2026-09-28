import { useLayoutEffect, useState } from "react";

export function useVisualViewport(enabled: boolean) {
  const measure = () => ({
    top: window.visualViewport?.offsetTop ?? 0,
    left: window.visualViewport?.offsetLeft ?? 0,
    height: window.visualViewport?.height ?? window.innerHeight,
    width: window.visualViewport?.width ?? window.innerWidth,
  });
  const [viewport, setViewport] = useState(measure);
  useLayoutEffect(() => {
    if (!enabled) return;
    const visual = window.visualViewport;
    const update = () => {
      const next = measure();
      setViewport((current) => Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    update();
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);
  return viewport;
}

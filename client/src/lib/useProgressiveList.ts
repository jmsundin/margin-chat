import { useEffect, useRef, useState } from "react";

/**
 * A long list renders one page at a time: the next page appears as the end of
 * the list scrolls near view. `include` is an index that must always be shown,
 * such as the selected row. Without IntersectionObserver every row renders.
 */
export function useProgressiveList(total: number, { page = 150, include = -1 }: { page?: number; include?: number } = {}) {
  const [count, setCount] = useState(page);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const observable = typeof IntersectionObserver !== "undefined";
  const shown = observable ? Math.min(total, Math.max(count, include + 1)) : total;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !observable || shown >= total) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setCount(shown + page);
    }, { rootMargin: "600px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [observable, page, shown, total]);
  return { shown, sentinel, more: shown < total };
}

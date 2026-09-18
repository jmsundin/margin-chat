import { useEffect, useRef, useState } from "react";
import { createGraphInteractionController, type GraphInteractionCallbacks } from "./graphInteractions";

export function useGraphInteractions(callbacks: GraphInteractionCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [controller] = useState(() => createGraphInteractionController(
    () => callbacksRef.current,
    {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (frame) => window.cancelAnimationFrame(frame),
    },
  ));
  useEffect(() => () => controller.dispose(), [controller]);
  return controller;
}

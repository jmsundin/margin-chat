const WHEEL_DELTA_TOLERANCE = 0.5;
const HORIZONTAL_INTENT_RATIO = 0.75;

export type WheelGestureAxis = "horizontal" | "vertical" | "none";

export function getWheelGestureAxis(
  deltaX: number,
  deltaY: number,
): WheelGestureAxis {
  if (
    Math.abs(deltaX) < WHEEL_DELTA_TOLERANCE &&
    Math.abs(deltaY) < WHEEL_DELTA_TOLERANCE
  ) {
    return "none";
  }

  return Math.abs(deltaX) >= Math.abs(deltaY) * HORIZONTAL_INTENT_RATIO
    ? "horizontal"
    : "vertical";
}

export function getHorizontalWheelDelta(args: {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
}) {
  const axis = getWheelGestureAxis(args.deltaX, args.deltaY);

  if (axis === "horizontal") {
    return args.deltaX;
  }

  return args.shiftKey && axis === "vertical" ? args.deltaY : 0;
}

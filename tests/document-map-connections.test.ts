import { expect, test } from "bun:test";
import { documentConnectionGeometry } from "../client/src/lib/documentMapConnections";
import { curvedGraphConnection } from "../client/src/lib/graphConnectionCurve";

const source = { x: 0, y: 0, width: 180, height: 96 };

function cubicPoints(path: string) {
  expect(path).toContain(" C ");
  const values = (path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []).map(Number);
  expect(values).toHaveLength(8);
  expect(values.every(Number.isFinite)).toBe(true);
  return { startX: values[0], startY: values[1], control1X: values[2], control1Y: values[3],
    control2X: values[4], control2Y: values[5], endX: values[6], endY: values[7] };
}

function expectLabelOnCurve(curve: { path: string; labelX: number; labelY: number }) {
  const point = cubicPoints(curve.path);
  expect(curve.labelX).toBeCloseTo((point.startX + 3 * point.control1X + 3 * point.control2X + point.endX) / 8);
  expect(curve.labelY).toBeCloseTo((point.startY + 3 * point.control1Y + 3 * point.control2Y + point.endY) / 8);
  return point;
}

test("tree connections attach to the correct card faces in each orientation", () => {
  const right = documentConnectionGeometry(source, { ...source, x: 280, y: 120 }, "tree-right");
  expect([right.startX, right.startY, right.endX, right.endY]).toEqual([180, 48, 280, 168]);
  expect(right.path).toBe("M 180 48 C 230 48, 230 168, 280 168");
  expectLabelOnCurve(right);
  const down = documentConnectionGeometry(source, { ...source, x: 240, y: 190 }, "tree-down");
  expect([down.startX, down.startY, down.endX, down.endY]).toEqual([90, 96, 330, 190]);
  expect(down.path).toBe("M 90 96 C 90 143, 330 143, 330 190");
  expectLabelOnCurve(down);
  const back = documentConnectionGeometry(source, { ...source, y: -190 }, "tree-down");
  expect(back.startY).toBe(0);
  expect(back.endY).toBe(-94);
});

test("radial connections meet card boundaries along the center-to-center ray", () => {
  for (const [x, y] of [[300, 0], [0, 220], [-300, 0], [0, -220], [300, 220], [-300, -220]]) {
    const target = { ...source, x, y };
    const edge = documentConnectionGeometry(source, target, "connections");
    const onBoundary = (px: number, py: number, box: typeof source) =>
      px >= box.x - 1e-8 && px <= box.x + box.width + 1e-8 && py >= box.y - 1e-8 && py <= box.y + box.height + 1e-8
      && (Math.abs(px - box.x) < 1e-8 || Math.abs(px - box.x - box.width) < 1e-8 || Math.abs(py - box.y) < 1e-8 || Math.abs(py - box.y - box.height) < 1e-8);
    expect(onBoundary(edge.startX, edge.startY, source)).toBe(true);
    expect(onBoundary(edge.endX, edge.endY, target)).toBe(true);
    expect((edge.startX - 90) * y - (edge.startY - 48) * x).toBeCloseTo(0);
    expect(edge.path).not.toMatch(/NaN|Infinity/);
    expectLabelOnCurve(edge);
  }
  expect(documentConnectionGeometry(source, source, "connections").path).not.toMatch(/NaN|Infinity/);
});

test("shared curves bow for axes and every quadrant, with labels at their actual cubic midpoint", () => {
  for (const [dx, dy] of [[240, 0], [0, 240], [-240, 0], [0, -240], [240, 120], [-240, 120], [240, -120], [-240, -120]]) {
    const endpoints = { startX: -37, startY: 21, endX: -37 + dx, endY: 21 + dy };
    const curve = curvedGraphConnection(endpoints);
    const points = expectLabelOnCurve(curve);
    expect([points.startX, points.startY, points.endX, points.endY]).toEqual(Object.values(endpoints));
    const cross = dx * (points.control1Y - points.startY) - dy * (points.control1X - points.startX);
    expect(Math.abs(cross)).toBeGreaterThan(1);
    const reverse = curvedGraphConnection({ startX: endpoints.endX, startY: endpoints.endY, endX: endpoints.startX, endY: endpoints.startY });
    expectLabelOnCurve(reverse);
    expect((curve.labelX + reverse.labelX) / 2).toBeCloseTo((endpoints.startX + endpoints.endX) / 2);
    expect((curve.labelY + reverse.labelY) / 2).toBeCloseTo((endpoints.startY + endpoints.endY) / 2);
  }
});

test("short and coincident connections stay proportionate without a hairpin", () => {
  for (const length of [0, 0.001, 1, 12, 100, 10000]) {
    const curve = curvedGraphConnection({ startX: 0, startY: 0, endX: length, endY: 0 });
    const point = expectLabelOnCurve(curve);
    expect(point.control1X).toBeCloseTo(length / 3);
    expect(point.control2X).toBeCloseTo(length * 2 / 3);
    expect(Math.abs(point.control1Y)).toBeLessThanOrEqual(length * 0.12);
    expect(Math.abs(point.control1Y)).toBeLessThanOrEqual(48);
    if (!length) expect([curve.labelX, curve.labelY]).toEqual([0, 0]);
  }
});

test("aligned tree and automatic connections curve visibly while preserving card-face endpoints", () => {
  for (const mode of ["tree-right", "tree-down", "auto"] as const) {
    const vertical = mode === "tree-down";
    const target = { ...source, x: vertical ? 0 : 300, y: vertical ? 240 : 0 };
    const result = documentConnectionGeometry(source, target, mode);
    const points = expectLabelOnCurve(result);
    expect([result.startX, result.startY, result.endX, result.endY])
      .toEqual(vertical ? [90, 96, 90, 240] : [180, 48, 300, 48]);
    expect(vertical ? points.control1X !== result.startX : points.control1Y !== result.startY).toBe(true);
  }
});

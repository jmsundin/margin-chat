/**
 * Soft outlines around groups of points (G6's hulls): the convex hull of each
 * group's core members, drawn with round joins and a wide stroke so it reads
 * as a padded blob that keeps the same screen padding at any zoom.
 */

export interface HullPoint { x: number; y: number }

export interface GroupHull {
  group: number;
  hue: number | null;
  /** Hull corners in world units, counter-clockwise; a single point or a line when the group is that thin. */
  points: HullPoint[];
  /** SVG path for the corners, closed. */
  path: string;
}

const cross = (o: HullPoint, a: HullPoint, b: HullPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull by the monotone chain, counter-clockwise, without repeated or collinear corners. */
export function convexHull(points: HullPoint[]): HullPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const lower: HullPoint[] = [], upper: HullPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  for (let at = sorted.length - 1; at >= 0; at--) {
    const point = sorted[at];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}

/** Share of a group's members, nearest its middle first, that its outline wraps; strays outside it are left out. */
const CORE_SHARE = 0.9;

/**
 * One outline per group with at least `minMembers` points: the hull of the
 * members nearest the group's middle, so a few strays don't stretch it over
 * its neighbours.
 */
export function groupHulls(points: ReadonlyArray<HullPoint & { group: number; hue: number | null }>, minMembers = 3): GroupHull[] {
  const groups = new Map<number, Array<HullPoint & { hue: number | null }>>();
  for (const point of points) {
    if (point.group < 0) continue;
    (groups.get(point.group) ?? groups.set(point.group, []).get(point.group)!).push(point);
  }
  const hulls: GroupHull[] = [];
  for (const [group, members] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (members.length < minMembers) continue;
    let cx = 0, cy = 0;
    for (const point of members) { cx += point.x; cy += point.y; }
    cx /= members.length; cy /= members.length;
    const core = members.map((point) => ({ point, distance: (point.x - cx) ** 2 + (point.y - cy) ** 2 }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.max(minMembers, Math.ceil(members.length * CORE_SHARE)))
      .map((item) => item.point);
    const corners = convexHull(core);
    const path = corners.map((point, at) => `${at ? "L" : "M"}${Math.round(point.x)} ${Math.round(point.y)}`).join("") + "Z";
    hulls.push({ group, hue: members[0].hue, points: corners, path });
  }
  return hulls;
}

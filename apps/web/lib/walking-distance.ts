import type { Document } from "./types";

type Box = {
  booth: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

const GRID_STEP = 1 / 240;
const MAX_DISTANCE = 0.12;

// Coordinates are fractions of the map diagonal, so the grid has square cells
// even when the source image is not square.
export function walkingDistances(
  document: Document,
  sourceBooths: ReadonlySet<number>,
): Map<number, number> {
  const result = new Map<number, number>();
  const width = document.image_width;
  const height = document.image_height;
  if (
    document.kind !== "map" ||
    !document.mime_type.startsWith("image/") ||
    !width ||
    !height ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return result;

  const diagonal = Math.hypot(width, height);
  if (!Number.isFinite(diagonal)) return result;
  const mapWidth = width / diagonal;
  const mapHeight = height / diagonal;
  const boxes = new Map<number, Box>();
  const seen = new Set<number>();
  for (const booth of document.booths || []) {
    if (seen.has(booth.booth)) {
      boxes.delete(booth.booth);
      continue;
    }
    seen.add(booth.booth);
    if (
      !Number.isInteger(booth.booth) ||
      booth.booth <= 0 ||
      ![booth.x, booth.y, booth.width, booth.height].every(Number.isFinite) ||
      booth.x < 0 ||
      booth.y < 0 ||
      booth.width <= 0 ||
      booth.height <= 0 ||
      booth.x + booth.width > 1.001 ||
      booth.y + booth.height > 1.001
    )
      continue;
    const left = booth.x * mapWidth;
    const top = booth.y * mapHeight;
    const right = (booth.x + booth.width) * mapWidth;
    const bottom = (booth.y + booth.height) * mapHeight;
    boxes.set(booth.booth, {
      booth: booth.booth,
      left,
      top,
      right,
      bottom,
      centerX: (left + right) / 2,
      centerY: (top + bottom) / 2,
    });
  }
  if (!boxes.size || ![...sourceBooths].some((booth) => boxes.has(booth)))
    return result;

  const columns = Math.ceil(mapWidth / GRID_STEP);
  const rows = Math.ceil(mapHeight / GRID_STEP);
  const stepX = mapWidth / columns;
  const stepY = mapHeight / rows;
  const blocked = new Uint8Array(columns * rows);
  const gridX = (column: number) => (column + 0.5) * stepX;
  const gridY = (row: number) => (row + 0.5) * stepY;
  // Close sub-booth-width cracks between adjacent cells. Such cracks are not
  // usable aisles, and would incorrectly connect opposite sides of a row.
  for (const box of boxes.values()) {
    const clearance = Math.min(box.right - box.left, box.bottom - box.top) / 4;
    const left = Math.max(0, Math.floor((box.left - clearance) / stepX));
    const right = Math.min(
      columns - 1,
      Math.floor((box.right + clearance) / stepX),
    );
    const top = Math.max(0, Math.floor((box.top - clearance) / stepY));
    const bottom = Math.min(
      rows - 1,
      Math.floor((box.bottom + clearance) / stepY),
    );
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const x = gridX(column),
          y = gridY(row);
        if (
          x >= box.left - clearance &&
          x <= box.right + clearance &&
          y >= box.top - clearance &&
          y <= box.bottom + clearance
        )
          blocked[row * columns + column] = 1;
      }
    }
  }

  // Access is possible only from a free cell beside a booth perimeter.
  function access(box: Box): number[] {
    const reach = Math.max(stepX, stepY) * 2.5;
    const left = Math.max(0, Math.floor((box.left - reach) / stepX));
    const right = Math.min(
      columns - 1,
      Math.floor((box.right + reach) / stepX),
    );
    const top = Math.max(0, Math.floor((box.top - reach) / stepY));
    const bottom = Math.min(rows - 1, Math.floor((box.bottom + reach) / stepY));
    const cells: number[] = [];
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const index = row * columns + column;
        if (blocked[index]) continue;
        const x = gridX(column),
          y = gridY(row);
        const dx = Math.max(box.left - x, 0, x - box.right);
        const dy = Math.max(box.top - y, 0, y - box.bottom);
        if (Math.hypot(dx, dy) <= reach) cells.push(index);
      }
    }
    return cells;
  }

  const distances = new Float64Array(blocked.length);
  distances.fill(Infinity);
  const heap: { index: number; distance: number }[] = [];
  function push(index: number, distance: number) {
    let position = heap.length;
    heap.push({ index, distance });
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (heap[parent].distance <= distance) break;
      heap[position] = heap[parent];
      position = parent;
    }
    heap[position] = { index, distance };
  }
  function pop() {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      let position = 0;
      while (position * 2 + 1 < heap.length) {
        let child = position * 2 + 1;
        if (
          child + 1 < heap.length &&
          heap[child + 1].distance < heap[child].distance
        )
          child++;
        if (last.distance <= heap[child].distance) break;
        heap[position] = heap[child];
        position = child;
      }
      heap[position] = last;
    }
    return first;
  }
  for (const booth of sourceBooths) {
    const box = boxes.get(booth);
    if (!box) continue;
    for (const index of access(box)) {
      const distance = Math.hypot(
        gridX(index % columns) - box.centerX,
        gridY(Math.floor(index / columns)) - box.centerY,
      );
      if (distance < distances[index]) {
        distances[index] = distance;
        push(index, distance);
      }
    }
  }
  const neighbors = [
    [-1, 0, stepX],
    [1, 0, stepX],
    [0, -1, stepY],
    [0, 1, stepY],
    [-1, -1, Math.hypot(stepX, stepY)],
    [1, -1, Math.hypot(stepX, stepY)],
    [-1, 1, Math.hypot(stepX, stepY)],
    [1, 1, Math.hypot(stepX, stepY)],
  ];
  while (heap.length) {
    const current = pop();
    if (!current) break;
    if (current.distance !== distances[current.index]) continue;
    if (current.distance > MAX_DISTANCE) break;
    const column = current.index % columns;
    const row = Math.floor(current.index / columns);
    for (const [dx, dy, cost] of neighbors) {
      const nextColumn = column + dx;
      const nextRow = row + dy;
      if (
        nextColumn < 0 ||
        nextRow < 0 ||
        nextColumn >= columns ||
        nextRow >= rows
      )
        continue;
      const next = nextRow * columns + nextColumn;
      if (blocked[next]) continue;
      // Diagonal steps cannot cut through occupied corners.
      if (
        dx &&
        dy &&
        (blocked[row * columns + nextColumn] ||
          blocked[nextRow * columns + column])
      )
        continue;
      const distance = current.distance + cost;
      if (distance < distances[next] && distance <= MAX_DISTANCE) {
        distances[next] = distance;
        push(next, distance);
      }
    }
  }
  for (const box of boxes.values()) {
    let nearest = Infinity;
    for (const index of access(box)) {
      const distance =
        distances[index] +
        Math.hypot(
          gridX(index % columns) - box.centerX,
          gridY(Math.floor(index / columns)) - box.centerY,
        );
      nearest = Math.min(nearest, distance);
    }
    if (nearest <= MAX_DISTANCE) result.set(box.booth, nearest);
  }
  return result;
}

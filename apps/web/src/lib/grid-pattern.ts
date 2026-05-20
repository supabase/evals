export type GridPatternConfig = {
  cols: number
  rows: number
  /** 0–1, approximate fraction of cells to fill */
  density?: number
  /** Optional seed for reproducible layouts */
  seed?: number
}

export type GridPatternDrawOptions = {
  cellSize: number
  cornerRadius: number
  fillStyle: string
  /** Apply dot-grid dither inside filled shapes */
  dither?: boolean
  /** CSS pixels between dot origins */
  ditherPitchPx?: number
  /** CSS pixel size of each dot */
  ditherDotPx?: number
}

type Point = { x: number; y: number }
type DirectedEdge = { from: Point; to: Point }

function pointKey(point: Point) {
  // Round to a sub-pixel grid so floating-point drift between mathematically
  // equal coordinates still hashes to the same key.
  return `${Math.round(point.x * 1024)},${Math.round(point.y * 1024)}`
}

function dirKey(from: Point, to: Point) {
  return `${pointKey(from)}>${pointKey(to)}`
}

function createRng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function emptyGrid(rows: number, cols: number): boolean[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(false))
}

function applyGridDither(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maskThreshold: number,
  pitchPx: number,
  dotPx: number
) {
  const pitch = Math.max(1, Math.round(pitchPx))
  const dot = Math.max(1, Math.round(dotPx))

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const value = data[i]

      if (value < maskThreshold) {
        data[i + 3] = 0
        continue
      }

      const tileX = x % pitch
      const tileY = y % pitch
      const on = tileX < dot && tileY < dot

      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = on ? 255 : 0
    }
  }
}

/**
 * Walk each filled cell clockwise. Internal sides shared by two filled cells
 * appear once in each direction and cancel, leaving a clean directed boundary.
 */
function collectDirectedBoundary(
  grid: boolean[][],
  cellSize: number
): DirectedEdge[] {
  const edges = new Map<string, DirectedEdge>()

  const add = (from: Point, to: Point) => {
    const reverseKey = dirKey(to, from)
    if (edges.has(reverseKey)) {
      edges.delete(reverseKey)
      return
    }
    edges.set(dirKey(from, to), { from, to })
  }

  const rows = grid.length
  const cols = grid[0]?.length ?? 0

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!grid[row][col]) continue

      // Compute each edge multiplicatively so neighboring cells share the
      // exact same float for shared vertices (avoids 1-ULP mismatches that
      // would prevent the directed-edge cancellation from firing).
      const x0 = col * cellSize
      const y0 = row * cellSize
      const x1 = (col + 1) * cellSize
      const y1 = (row + 1) * cellSize

      add({ x: x0, y: y0 }, { x: x1, y: y0 })
      add({ x: x1, y: y0 }, { x: x1, y: y1 })
      add({ x: x1, y: y1 }, { x: x0, y: y1 })
      add({ x: x0, y: y1 }, { x: x0, y: y0 })
    }
  }

  return Array.from(edges.values())
}

/**
 * Stitch directed boundary edges into closed loops. At pinch vertices (cells
 * touching only at a corner), prefer the rightmost outgoing edge so each shape
 * keeps its own loop instead of merging through the corner.
 */
function chainLoops(edges: DirectedEdge[]): Point[][] {
  const outgoingByFrom = new Map<string, DirectedEdge[]>()
  for (const edge of edges) {
    const key = pointKey(edge.from)
    const list = outgoingByFrom.get(key)
    if (list) list.push(edge)
    else outgoingByFrom.set(key, [edge])
  }

  const used = new Set<string>()
  const loops: Point[][] = []

  for (const seed of edges) {
    if (used.has(dirKey(seed.from, seed.to))) continue

    const loop: Point[] = []
    let current: DirectedEdge = seed

    while (true) {
      const edgeKey = dirKey(current.from, current.to)
      if (used.has(edgeKey)) break
      used.add(edgeKey)
      loop.push(current.from)

      const inDx = current.to.x - current.from.x
      const inDy = current.to.y - current.from.y
      const candidates: DirectedEdge[] =
        outgoingByFrom.get(pointKey(current.to)) ?? []

      let best: DirectedEdge | null = null
      let bestScore = -Infinity
      for (const candidate of candidates) {
        if (used.has(dirKey(candidate.from, candidate.to))) continue
        const outDx = candidate.to.x - candidate.from.x
        const outDy = candidate.to.y - candidate.from.y
        const cross = inDx * outDy - inDy * outDx
        const dot = inDx * outDx + inDy * outDy
        const score = cross * 1_000_000 + dot
        if (score > bestScore) {
          bestScore = score
          best = candidate
        }
      }

      if (!best) break
      current = best
    }

    if (loop.length >= 3) loops.push(loop)
  }

  return loops
}

/**
 * Trace a polygon as straight segments through edge midpoints connected by
 * `arcTo` through each corner. Works for both convex outer corners and
 * concave inner corners — `arcTo` handles each as a fillet of the same radius.
 */
function drawRoundedLoop(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  radius: number
) {
  const total = points.length
  if (total < 3) return

  const corners: Point[] = []
  for (let i = 0; i < total; i += 1) {
    const prev = points[(i - 1 + total) % total]
    const curr = points[i]
    const next = points[(i + 1) % total]
    const cross =
      (curr.x - prev.x) * (next.y - curr.y) -
      (curr.y - prev.y) * (next.x - curr.x)
    if (cross !== 0) corners.push(curr)
  }

  const count = corners.length
  if (count < 3) return

  const last = corners[count - 1]
  const first = corners[0]
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2)

  for (let i = 0; i < count; i += 1) {
    const curr = corners[i]
    const next = corners[(i + 1) % count]
    const midX = (curr.x + next.x) / 2
    const midY = (curr.y + next.y) / 2
    ctx.arcTo(curr.x, curr.y, midX, midY, radius)
  }

  ctx.closePath()
}

/** Random walk blobs that read as one continuous pattern across the width. */
export function generateGridPattern({
  cols,
  rows,
  density = 0.42,
  seed = Math.floor(Math.random() * 0xffffffff),
}: GridPatternConfig): boolean[][] {
  const grid = emptyGrid(rows, cols)
  const rng = createRng(seed)
  const targetCells = Math.max(8, Math.floor(cols * rows * density))
  const walkerCount = Math.max(3, Math.floor(cols / 14))
  let filled = 0

  const mark = (col: number, row: number) => {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return
    if (grid[row][col]) return
    grid[row][col] = true
    filled += 1
  }

  for (let walker = 0; walker < walkerCount; walker += 1) {
    let col = Math.floor(rng() * cols)
    let row = Math.floor(rng() * rows)
    const steps = Math.floor((targetCells / walkerCount) * (0.85 + rng() * 0.3))

    for (let step = 0; step < steps && filled < targetCells; step += 1) {
      mark(col, row)

      const direction = Math.floor(rng() * 4)
      if (direction === 0) col += 1
      else if (direction === 1) col -= 1
      else if (direction === 2) row += 1
      else row -= 1

      col = Math.max(0, Math.min(cols - 1, col))
      row = Math.max(0, Math.min(rows - 1, row))
    }
  }

  while (filled < targetCells) {
    const col = Math.floor(rng() * cols)
    const row = Math.floor(rng() * rows)
    mark(col, row)
  }

  return grid
}

/**
 * Merge orthogonally adjacent filled cells into unified rounded shapes, then
 * optionally apply a dot-grid dither inside the resulting fill.
 */
export function drawGridPattern(
  ctx: CanvasRenderingContext2D,
  grid: boolean[][],
  {
    cellSize,
    cornerRadius,
    fillStyle,
    dither = false,
    ditherPitchPx = 4,
    ditherDotPx = 1,
  }: GridPatternDrawOptions
) {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (!rows || !cols) return

  const radius = Math.min(cornerRadius, cellSize / 2)
  const width = cols * cellSize
  const height = rows * cellSize
  const dpr = window.devicePixelRatio || 1
  const deviceWidth = Math.ceil(width * dpr)
  const deviceHeight = Math.ceil(height * dpr)

  const maskCanvas = document.createElement("canvas")
  maskCanvas.width = deviceWidth
  maskCanvas.height = deviceHeight
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: dither })
  if (!maskCtx) return

  maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  maskCtx.clearRect(0, 0, width, height)
  maskCtx.fillStyle = "#fff"
  maskCtx.beginPath()

  const edges = collectDirectedBoundary(grid, cellSize)
  const loops = chainLoops(edges)
  for (const loop of loops) {
    drawRoundedLoop(maskCtx, loop, radius)
  }
  maskCtx.fill("nonzero")

  if (dither) {
    const imageData = maskCtx.getImageData(0, 0, deviceWidth, deviceHeight)
    applyGridDither(
      imageData.data,
      deviceWidth,
      deviceHeight,
      128,
      ditherPitchPx * dpr,
      ditherDotPx * dpr
    )
    maskCtx.putImageData(imageData, 0, 0)
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(
    maskCanvas,
    0,
    0,
    deviceWidth,
    deviceHeight,
    0,
    0,
    width,
    height
  )
  ctx.globalCompositeOperation = "source-in"
  ctx.fillStyle = fillStyle
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = "source-over"
}

export function extendGridPattern(
  grid: boolean[][],
  targetCols: number,
  seed: number
): boolean[][] {
  const rows = grid.length
  const cols = grid[0]?.length ?? 0
  if (targetCols <= cols) return grid

  const rng = createRng(seed + targetCols)
  const next = grid.map((row) => [...row])

  for (let col = cols; col < targetCols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const west = next[row][col - 1]
      const north = row > 0 ? next[row - 1][col] : false
      const south = row < rows - 1 ? next[row + 1][col] : false
      const bias = (west ? 0.55 : 0) + (north ? 0.25 : 0) + (south ? 0.15 : 0)
      next[row][col] = rng() < 0.22 + bias
    }
  }

  return next
}

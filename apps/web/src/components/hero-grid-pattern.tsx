import { useEffect, useMemo, useRef, useState } from "react"

import {
  drawGridPattern,
  extendGridPattern,
  generateGridPattern,
} from "@/lib/grid-pattern"
import { cn } from "@/lib/utils"

export type HeroGridPatternProps = {
  /** Canvas height in CSS pixels */
  height?: number
  /** Grid cell size in CSS pixels */
  cellSize?: number
  /** Corner radius for outer and inner junctions */
  cornerRadius?: number
  /** Dot-grid dither inside filled shapes */
  dither?: boolean
  /** CSS pixels between dot origins */
  ditherPitchPx?: number
  /** CSS pixel size of each dot */
  ditherDotPx?: number
  /** Canvas fill color for the generated pattern */
  color?: string
  className?: string
}

const BASE_COLS = 48
const DEFAULT_ROWS = 7
const INTRO_VARIATIONS = 10
const INTRO_INTERVAL_MS = 200
const INTRO_SEEDS = Array.from(
  { length: INTRO_VARIATIONS },
  () => Math.floor(Math.random() * 0xffffffff)
)

export function HeroGridPattern({
  height = 200,
  cellSize: cellSizeProp,
  cornerRadius: cornerRadiusProp,
  dither = false,
  ditherPitchPx = 4,
  ditherDotPx = 1,
  color,
  className,
}: HeroGridPatternProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cellSize = cellSizeProp ?? height / DEFAULT_ROWS
  const cornerRadius = cornerRadiusProp ?? Math.min(5, cellSize * 0.14)
  const [variationIndex, setVariationIndex] = useState(0)

  const baseGrids = useMemo(() => {
    const rows = Math.max(3, Math.round(height / cellSize))
    return INTRO_SEEDS.map((seed) =>
      generateGridPattern({
        cols: BASE_COLS,
        rows,
        seed,
      })
    )
  }, [cellSize, height])

  const settledIndex = INTRO_VARIATIONS - 1

  useEffect(() => {
    if (variationIndex >= settledIndex) return

    const timeoutId = window.setTimeout(() => {
      setVariationIndex((current) => Math.min(current + 1, settledIndex))
    }, INTRO_INTERVAL_MS)

    return () => window.clearTimeout(timeoutId)
  }, [variationIndex, settledIndex])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrapper = wrapperRef.current
    if (!canvas || !wrapper) return

    const activeIndex = Math.min(variationIndex, settledIndex)
    const baseGrid = baseGrids[activeIndex]
    const seed = INTRO_SEEDS[activeIndex]

    const paint = () => {
      const fillStyle =
        getComputedStyle(wrapper).color || "var(--foreground)"
      const width = canvas.clientWidth
      if (!width) return

      const cols = Math.ceil(width / cellSize)
      const grid = extendGridPattern(baseGrid, cols, seed)
      const dpr = window.devicePixelRatio || 1

      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.height = `${height}px`

      const ctx = canvas.getContext("2d")
      if (!ctx) return

      drawGridPattern(ctx, grid, {
        cellSize,
        cornerRadius,
        fillStyle,
        dither,
        ditherPitchPx,
        ditherDotPx,
      })
    }

    paint()

    const observer = new ResizeObserver(paint)
    observer.observe(canvas)

    return () => observer.disconnect()
  }, [
    baseGrids,
    variationIndex,
    settledIndex,
    cellSize,
    cornerRadius,
    dither,
    ditherPitchPx,
    ditherDotPx,
    height,
  ])

  return (
    <div
      ref={wrapperRef}
      className={cn("w-full overflow-hidden text-primary", className)}
      style={{ height, color }}
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        className="block w-full"
        style={{ height: "100%" }}
      />
    </div>
  )
}

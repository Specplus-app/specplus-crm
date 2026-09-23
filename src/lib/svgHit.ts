// When traced parts overlap (e.g. a small emblem sitting on top of a large
// grille), a plain per-shape click handler only ever hits whichever shape is
// painted last. This resolves the click by geometry instead: among every part
// whose shape actually contains the cursor, pick the one with the smallest
// bounding box so the tightest (usually the part the user aimed at) wins.
export function pickPartAtPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): string | null {
  const stack = document.elementsFromPoint(clientX, clientY)
  let best: { id: string; area: number } | null = null
  for (const el of stack) {
    if (!svg.contains(el)) continue
    const id = el.getAttribute('data-part-id')
    if (!id) continue
    const box = (el as SVGGraphicsElement).getBBox()
    const area = box.width * box.height
    if (!best || area < best.area) best = { id, area }
  }
  return best?.id ?? null
}

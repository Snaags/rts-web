# Changelog

## Zoom and Panning Feature

Added the ability to zoom in/out and pan around the game map.

### Changes Made

#### 1. Zoom Implementation (`src/main.ts`)

**Added zoom state variables** (lines ~24-31):
```typescript
let zoomLevel = 1.0;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;

let panX = 0;
let panY = 0;
const EDGE_THRESHOLD = 50;
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
```

**Modified `fitWorld()` function** (lines ~164-198):
- Calculates scaled map dimensions based on zoom level
- Clamps pan values to allow ~1/3 of the map to go off-screen at edges
- When map fills viewport: centers and resets pan to 0
- When zoomed in: uses pan values directly for positioning

Key logic:
- `mapFillsViewport`: determines if zoomed map fits in window
- `PAN_MARGIN = 0.33`: allows 1/3 of the map to be panned off-screen
- Pan bounds are calculated as: `window dimension - scaled dimension - (scaled dimension * PAN_MARGIN)`

**Added wheel event handler** (lines ~200-227):
- Zooms in/out using scroll wheel
- Zooms toward cursor position (not just center)
- Calculates world position before zoom, then adjusts pan to keep that point under cursor

**Added mouse tracking** (lines ~252-256):
- Tracks mouse position on `window` for edge panning

#### 2. Panning Implementation

**Middle-mouse drag panning** (lines ~231-263):
- Click and hold middle mouse button to pan
- Drag moves the view
- Cursor changes to "grabbing" while panning

**Edge panning** (lines ~798-824):
- Only active when map exceeds viewport
- When mouse is within 50px of screen edge, pans in that direction
- Updates continuously in the render loop

### Controls

| Action | Control |
|--------|---------|
| Zoom in/out | Mouse scroll wheel |
| Pan (edge) | Move mouse to screen edges (when zoomed in) |
| Pan (drag) | Middle mouse button drag |

### Technical Notes

- Zoom is multiplied to the base "fit to window" scale
- Pan is independent of zoom (world position is set directly when panning)
- Edge panning disabled when map fits in viewport to prevent awkward positioning
- The `screenToWorld()` function automatically works with the new zoom/pan because it uses `world.scale` and `world.position`

### Files Modified

- `src/main.ts`: All zoom and panning logic

### Related

- `features.md`: Feature request for zoom functionality
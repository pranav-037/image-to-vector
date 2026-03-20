# Image to Vector (Raster -> SVG)

This is a small website that converts a raster image into an SVG using Potrace compiled to WebAssembly (`esm-potrace-wasm`).

## Run locally

1. Install dependencies:
   ```sh
   npm install
   ```
2. Start the dev server:
   ```sh
   npm run dev
   ```
3. Open the shown URL in your browser.

## Build

```sh
npm run build
```

## Notes

- Conversion runs in your browser, so large images may be slower.
- If results look messy, tweak:
  - `turdsize` (noise filter)
  - `opttolerance` (curve smoothing)
  - `posterizelevel` (how many colors/tones to keep)


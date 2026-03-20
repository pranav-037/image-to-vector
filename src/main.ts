import './styles.css';
import { init as initPotrace, potrace } from 'esm-potrace-wasm';

type ColorMode = 'auto' | 'color' | 'bw';

const els = {
  fileInput: document.getElementById('fileInput') as HTMLInputElement | null,
  convertBtn: document.getElementById('convertBtn') as HTMLButtonElement | null,
  downloadLink: document.getElementById('downloadLink') as HTMLAnchorElement | null,
  status: document.getElementById('status') as HTMLDivElement | null,
  output: document.getElementById('output') as HTMLDivElement | null,

  colorMode: document.getElementById('colorMode') as HTMLSelectElement | null,
  posterizeLevel: document.getElementById('posterizeLevel') as HTMLInputElement | null,
  posterizeLevelValue: document.getElementById('posterizeLevelValue') as HTMLDivElement | null,
  turdsize: document.getElementById('turdsize') as HTMLInputElement | null,
  turdsizeValue: document.getElementById('turdsizeValue') as HTMLDivElement | null,
  opttolerance: document.getElementById('opttolerance') as HTMLInputElement | null,
  opttoleranceValue: document.getElementById('opttoleranceValue') as HTMLDivElement | null,
  pathOnly: document.getElementById('pathOnly') as HTMLInputElement | null
};

function assertEl<T extends HTMLElement>(el: T | null, name: string): T {
  if (!el) throw new Error(`Missing element: ${name}`);
  return el;
}

const ui = {
  fileInput: assertEl(els.fileInput, 'fileInput'),
  convertBtn: assertEl(els.convertBtn, 'convertBtn'),
  downloadLink: assertEl(els.downloadLink, 'downloadLink'),
  status: assertEl(els.status, 'status'),
  output: assertEl(els.output, 'output'),

  colorMode: assertEl(els.colorMode, 'colorMode'),
  posterizeLevel: assertEl(els.posterizeLevel, 'posterizeLevel'),
  posterizeLevelValue: assertEl(els.posterizeLevelValue, 'posterizeLevelValue'),
  turdsize: assertEl(els.turdsize, 'turdsize'),
  turdsizeValue: assertEl(els.turdsizeValue, 'turdsizeValue'),
  opttolerance: assertEl(els.opttolerance, 'opttolerance'),
  opttoleranceValue: assertEl(els.opttoleranceValue, 'opttoleranceValue'),
  pathOnly: assertEl(els.pathOnly, 'pathOnly')
};

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
let currentFile: File | null = null;

ui.posterizeLevelValue.textContent = ui.posterizeLevel.value;
ui.turdsizeValue.textContent = ui.turdsize.value;
ui.opttoleranceValue.textContent = ui.opttolerance.value;

ui.posterizeLevel.addEventListener('input', () => {
  ui.posterizeLevelValue.textContent = ui.posterizeLevel.value;
});
ui.turdsize.addEventListener('input', () => {
  ui.turdsizeValue.textContent = ui.turdsize.value;
});
ui.opttolerance.addEventListener('input', () => {
  ui.opttoleranceValue.textContent = Number(ui.opttolerance.value).toString();
});

function setDownloadEnabled(enabled: boolean, href?: string, filename?: string) {
  ui.downloadLink.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  ui.downloadLink.style.pointerEvents = enabled ? 'auto' : 'none';
  ui.downloadLink.style.opacity = enabled ? '1' : '0.6';
  if (!enabled) {
    ui.downloadLink.href = '#';
    ui.downloadLink.setAttribute('download', 'vector.svg');
    return;
  }
  if (href) ui.downloadLink.href = href;
  if (filename) ui.downloadLink.setAttribute('download', filename);
}

let wasmReady = false;
let wasmInitPromise: Promise<void> | null = null;
let lastObjectUrl: string | null = null;
let lastAutoAnalysis:
  | null
  | {
      mode: Exclude<ColorMode, 'auto'>;
      posterizelevel: number;
      turdsize: number;
      opttolerance: number;
      colorSpreadNorm: number;
      noiseNorm: number;
    } = null;

async function ensureWasm() {
  if (wasmReady) return;
  if (!wasmInitPromise) {
    ui.status.textContent = 'Loading Potrace WebAssembly…';
    wasmInitPromise = initPotrace().then(() => {
      wasmReady = true;
      ui.status.textContent = 'Ready. Choose an image to convert.';
    });
  }
  await wasmInitPromise;
}

function buildOptions() {
  const colorMode = ui.colorMode.value as ColorMode;

  // When auto-best is enabled, we analyze the image (async) right before conversion
  // and override these UI-controlled values.
  let mode: Exclude<ColorMode, 'auto'> = colorMode === 'auto' ? 'color' : colorMode;
  let posterizelevel = Math.max(1, Math.min(255, Number(ui.posterizeLevel.value)));
  let turdsize = Number(ui.turdsize.value);
  let opttolerance = Number(ui.opttolerance.value);

  if (colorMode === 'auto') {
    if (!lastAutoAnalysis) {
      throw new Error('Auto settings requested but image analysis was not computed.');
    }
    mode = lastAutoAnalysis.mode;
    posterizelevel = lastAutoAnalysis.posterizelevel;
    turdsize = lastAutoAnalysis.turdsize;
    opttolerance = lastAutoAnalysis.opttolerance;
  }

  const pathonly = ui.pathOnly.checked;

  const extractcolors = mode === 'color' && !pathonly;

  return {
    // Basic Potrace options (see esm-potrace-wasm README).
    turdsize,
    turnpolicy: 4,
    alphamax: 1,
    opticurve: 1,
    opttolerance,
    pathonly,
    extractcolors,
    posterizelevel, // [1, 255]
    posterizationalgorithm: 0 // 0: simple, 1: interpolation
  };
}

function svgToDownload(svg: string, filenameBase: string) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = `${filenameBase}.svg`;
  return { url, filename };
}

async function convertFile(file: File) {
  const filenameBase = file.name.replace(/\.[^/.]+$/, '');
  ui.status.textContent = 'Converting…';
  ui.convertBtn.disabled = true;
  ui.output.innerHTML = '';
  setDownloadEnabled(false);
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  lastObjectUrl = null;
  lastAutoAnalysis = null;

  if ((ui.colorMode.value as ColorMode) === 'auto') {
    ui.status.textContent = 'Analyzing image for auto-best settings…';
    await analyzeAndSetAuto(file);
  }

  const options = buildOptions();
  // Use an ImageBitmap as the source; this matches the primary
  // input type used in the esm-potrace-wasm examples and avoids
  // issues some environments have when passing a File/Blob directly.
  const bitmap = await createBitmapFromFile(file);
  let svg: string;
  try {
    svg = await potrace(bitmap, options);
  } finally {
    try {
      bitmap.close?.();
    } catch {
      // ignore
    }
  }

  ui.output.innerHTML = svg;
  const { url, filename } = svgToDownload(svg, filenameBase);
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  lastObjectUrl = url;
  setDownloadEnabled(true, url, filename);
  ui.status.textContent = 'Done.';
  ui.convertBtn.disabled = false;
}

ui.fileInput.addEventListener('change', async () => {
  currentFile = ui.fileInput.files?.[0] ?? null;
  setDownloadEnabled(false);
  ui.output.innerHTML = '';
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  lastObjectUrl = null;
  lastAutoAnalysis = null;

  if (!currentFile) {
    ui.convertBtn.disabled = true;
    ui.status.textContent = 'Choose an image to convert.';
    return;
  }

  if (currentFile.size > MAX_FILE_BYTES) {
    ui.convertBtn.disabled = true;
    ui.status.textContent = `File is too large (${Math.round(currentFile.size / 1024 / 1024)}MB). Max is 8MB.`;
    return;
  }

  ui.convertBtn.disabled = !wasmReady;
  ui.status.textContent = wasmReady ? 'Ready. Click “Convert to SVG”.' : 'Preparing converter…';
  await ensureWasm();
  ui.convertBtn.disabled = false;
});

ui.convertBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  try {
    await ensureWasm();
    await convertFile(currentFile);
  } catch (err) {
    console.error(err);
    ui.status.textContent = 'Conversion failed. Try a different image or adjust the options.';
    ui.convertBtn.disabled = false;
  }
});

// Preload WASM so the button becomes available quickly.
ensureWasm().catch((err) => {
  console.error(err);
  ui.status.textContent = 'Failed to load converter. Check console logs.';
});

async function analyzeAndSetAuto(file: File) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Not an image file.');
  }

  const posterizeEl = ui.posterizeLevel;
  const turdsizeEl = ui.turdsize;
  const optTolEl = ui.opttolerance;

  const bitmap = await createBitmapFromFile(file);
  try {
    // Limit analysis work: keep a small canvas.
    const maxDim = 256;
    const w0 = bitmap.width;
    const h0 = bitmap.height;
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const w = Math.max(2, Math.round(w0 * scale));
    const h = Math.max(2, Math.round(h0 * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No canvas context.');

    ctx.drawImage(bitmap, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    const { colorSpreadNorm, noiseNorm } = computeImageMetrics(imageData.data, w, h);

    // Heuristics:
    // - If it's close to grayscale, prefer B/W.
    // - Use noise estimate to set `turdsize` and smoothing tolerance.
    const mode: Exclude<ColorMode, 'auto'> = colorSpreadNorm < 0.06 ? 'bw' : 'color';

    // Posterize: higher -> more tones/colors (more detail; can be messy).
    const posterizelevel = clamp(
      mode === 'bw'
        ? 2
        : Math.round(3 + colorSpreadNorm * 50), // tuned for a reasonable range
      2,
      18
    );

    // turdsize: treat noisy images by removing tiny components.
    const turdsize = clamp(Math.round(noiseNorm * 10), 0, 10);

    // opttolerance: higher smooths more; use noise to decide.
    const opttolerance = clamp(Number((0.08 + noiseNorm * 0.55).toFixed(2)), 0.01, 1);

    lastAutoAnalysis = { mode, posterizelevel, turdsize, opttolerance, colorSpreadNorm, noiseNorm };

    // Reflect auto-chosen values in the controls.
    posterizeEl.value = String(posterizelevel);
    turdsizeEl.value = String(turdsize);
    optTolEl.value = String(opttolerance);

    // Optional: if user wants paths-only, we still respect that,
    // but auto-best uses mode only to decide whether to enable `extractcolors`.
    ui.status.textContent = `Auto-best picked ${mode.toUpperCase()} (posterize=${posterizelevel}, turdsize=${turdsize}, opttolerance=${opttolerance}). Converting…`;
  } finally {
    // Best-effort cleanup; some browsers let ImageBitmap be closed.
    try {
      bitmap.close?.();
    } catch {
      // ignore
    }
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function computeImageMetrics(rgba: Uint8ClampedArray, w: number, h: number) {
  // Sample step to keep analysis fast.
  const step = Math.max(1, Math.floor(Math.min(w, h) / 160));
  let spreadSum = 0;
  let sampleCount = 0;

  // For noise estimate: use a simple gradient magnitude on luma.
  // We avoid sqrt for speed by accumulating squared magnitude, then normalize.
  let gradSumSq = 0;
  let gradCount = 0;

  const getLuma = (idx: number) => {
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      spreadSum += max - min;
      sampleCount++;
    }
  }

  // Gradients: avoid border.
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const i = (y * w + x) * 4;
      const lC = getLuma(i);
      const lL = getLuma(((y * w + (x - 1)) * 4) as number);
      const lR = getLuma(((y * w + (x + 1)) * 4) as number);
      const lU = getLuma((((y - 1) * w + x) * 4) as number);
      const lD = getLuma((((y + 1) * w + x) * 4) as number);

      const dx = lR - lL;
      const dy = lD - lU;
      const magSq = dx * dx + dy * dy;
      gradSumSq += magSq;
      gradCount++;
      // Use lC so bundler can't optimize away getLuma
      void lC;
    }
  }

  const colorSpreadNorm = (spreadSum / Math.max(1, sampleCount)) / 255; // 0..~1
  // Normalize noise: sqrt(magSq) then divide by (255*sqrt(2)) approx.
  const noiseMag = Math.sqrt(gradSumSq / Math.max(1, gradCount));
  const noiseNorm = noiseMag / (255 * Math.SQRT2);

  return {
    colorSpreadNorm: clamp(colorSpreadNorm, 0, 1),
    noiseNorm: clamp(noiseNorm, 0, 1)
  };
}

async function createBitmapFromFile(file: File): Promise<ImageBitmap> {
  // Preferred: createImageBitmap (fast).
  if ('createImageBitmap' in window) {
    return await createImageBitmap(file);
  }

  // Fallback: HTMLImageElement -> draw to canvas -> createImageBitmap from canvas.
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image.'));
    });
    img.src = url;
    await loaded;

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas context.');
    ctx.drawImage(img, 0, 0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (createImageBitmap as any)(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}


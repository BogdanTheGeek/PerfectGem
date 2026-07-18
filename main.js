// import { mat4, vec4 } from 'https://cdn.skypack.dev/gl-matrix';
import { mat4, vec4 } from './gl-matrix/esm/index.js';
import {
   loadSTL,
   loadGCS,
   loadASC,
   loadGEM,
   normalizeStoneToUnitSphere,
   computeMeshBoundsRadius,
   buildBVH,
   buildStoneFromFacetDesign,
   hasUniqueTableFacet,
   buildFacetInfo,
   groupExternalFacetsForDesign,
   buildInstructionAngleCutSequence,
   normalizeDesignFacet,
   stretchStoneByVertices,
   computeNormalFromPolar,
   generateFacesFromFacetList,
   computeFacetNotesSummary,
   buildDesignGcsText,
   buildDesignAscText,
   buildDesignGemBuffer,
   buildDesignStlBuffer,
} from './loaders.js';
import {
   computeFacetNormalFromParams,
   computeSignedFacetAngleDeg,
} from './geometry.js';
import { exportInProgress, setupExporter } from './video.js';
import { renderOrtho } from './ortho.js';

const shaderSource = await (await fetch('shaders.wgsl')).text();
const computeShaderSource = await (await fetch('compute.wgsl')).text();
// Toggle debug overlays/features
var DEBUG = true;

// Gem species presets  [name, RI, COD, axisAHex, axisBHex, axisCHex]
const presets = [
   ['Quartz', 1.544, 0.013, '#faf7f2', '#f3f6ff', '#f5fcff'],
   ['Diamond', 2.417, 0.044, '#ffffff', '#f7fbff', '#f6f9ff'],
   ['Ruby', 1.762, 0.018, '#ff3d52', '#d4152f', '#ff6c86'],
   ['Sapphire', 1.762, 0.018, '#2e5cff', '#1b3ec4', '#78a2ff'],
   ['Emerald', 1.575, 0.014, '#22c767', '#0f8f49', '#7cf2b5'],
   ['Amethyst', 1.544, 0.013, '#a86bff', '#6d3bc8', '#d1a7ff'],
   ['Topaz', 1.619, 0.014, '#ffd463', '#d6a62b', '#fff0b0'],
   ['Spinel', 1.718, 0.020, '#ff6ca2', '#cf2d70', '#ffb6d3'],
   ['Zircon', 1.925, 0.039, '#bfe8ff', '#7ec4e8', '#e2f6ff'],
   ['Cubic Zirconia', 2.170, 0.060, '#ffffff', '#eef5ff', '#f8fbff'],
   ['Garnet', 1.75, 0.020, '#d94345', '#9e1f2a', '#ff8185'],
   ['Tourmaline', 1.62, 0.014, '#ff8e63', '#e35c3b', '#ffbf9f'],
   ['Chrome Tourmaline', 1.62, 0.017, '#25d571', '#25d571', '#11753f'],
   ['Pink Tourmaline', 1.62, 0.017, '#ffb6d6', '#ea6aa8', '#ffd7e9'],
   ['Iolite', 1.548, 0.017, '#ffffff', '#4c53d5', '#ffe3a2'],
   ['Tanzanite', 1.690, 0.017, '#5f71ff', '#3f2ab0', '#d66aff'],
   ['Peridot', 1.65, 0.015, '#a7ff28', '#6db516', '#d3ff8a'],
   ['Aquamarine', 1.57, 0.012, '#8df6e8', '#4fbec4', '#c8fff8'],
];

const panel = document.getElementById('gemui');
const toggleBtn = document.getElementById('gemui-toggle');
const uiFileInput = document.getElementById('uiFileInput');
const fileBtn = document.getElementById('fileBtn');
const fileNameEl = document.getElementById('fileNameEl');

// --- UI (built once; survives model swaps) ---
let currentModelFilename = 'stone.gem';
let framePending = false;
let frame = () => { }; // Replaced by setupApp() return value; declared here to avoid closure issues with requestRender()
const ROT_EPSILON = 1e-4;

function easeInOutSine(x) {
   return -(Math.cos(Math.PI * x) - 1) / 2;
}
function easeOutSine(x) {
   return Math.sin((x * Math.PI) / 2);
}
function easeLinear(x) {
   return x;
}

function easeInOutQuad(x) {
   return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

function upDownBell(x) {
   if (x < 0.5) return 2 * x;
   else return 2 * (1 - x);
}

function easeToSvgIcon(easeFunc, steps = 100) {
   // Generate an SVG path string representing the easing function curve in a unit square (0,0 to 1,1)
   let path = `M 0 ${easeFunc(0)}`;
   for (let i = 1; i <= steps; i++) {
      const x = i / steps;
      const y = easeFunc(x);
      path += ` L ${x} ${y}`;
   }
   return path;
}

const easingFuncs = {
   'easeLinear': { func: easeLinear, icon: easeToSvgIcon(easeLinear) },
   'easeOutSine': { func: easeOutSine, icon: easeToSvgIcon(easeOutSine) },
   'easeInOutSine': { func: easeInOutSine, icon: easeToSvgIcon(easeInOutSine) },
   'easeInOutQuad': { func: easeInOutQuad, icon: easeToSvgIcon(easeInOutQuad) },
};

// ---------------------------------------------------------------------------
// Module-level state — shared across model reloads
// ---------------------------------------------------------------------------
const ui = {
   ri: presets[0][1],
   cod: presets[0][2],
   clarity: 0.5,
   lightMode: 3,
   easingFuncName: Object.keys(easingFuncs)[0],
   axisAColor: hexToRgb(presets[0][3]),
   axisBColor: hexToRgb(presets[0][4]),
   axisCColor: hexToRgb(presets[0][5]),
   backgroundColor: [13 / 255, 13 / 255, 13 / 255],
   exitHighlight: [0, 0, 0],
   headShadowColor: [0.5, 0.5, 0.5],
   axisTiltXDeg: 0,
   axisTiltYDeg: 0,
   axisTiltZDeg: 0,
   exitStrength: 0.0,
   tiltAngleDeg: 10,
   focalLength: 200,
   renderScale: 0,
   renderScaleMax: 1,
   exportQualityPx: 1080,
   convexFacetMode: 0,
};

// Camera / interaction (survive model reloads)
const modelMat = mat4.create();
const viewMat = mat4.create();
const projMat = mat4.create();
const cameraPos = vec4.fromValues(0, 0, 5, 0);
let targetRotX = 0, targetRotY = 0;
let currentRotX = 0, currentRotY = 0;
let animating = false, animStartTime = 0;

// Current model GPU resources — replaced by loadModel()
let renderBundle = null; // { bindGroup, graphBindGroups, vertexBuffer, triCount }
let modelBoundsRadius = 1.0;
let currentStone = null;

// Reference to UI controls — set by setupApp(), used by loadModel()
let uiControls = null;

const GRAPH_SAMPLE_SIZE = 64;
const GRAPH_COLOR_FORMAT = 'rgba16float';
const GRAPH_REDUCE_SUM_SCALE = 65536;
const GRAPH_REDUCE_CELL_U32_COUNT = 4;
const GRAPH_VALUE_SCALE = 100;
const GRAPH_TILT_MIN = -30;
const GRAPH_TILT_MAX = 30;
const GRAPH_TILT_STEP = 1;
const GRAPH_MODES = [
   { label: 'ISO', color: '#e8e8e8', mode: 0 },
   { label: 'COS', color: '#ff5f5f', mode: 1 },
   { label: 'SC2', color: '#59e35f', mode: 2 },
];
const GRAPH_TILT_VALUES = Array.from(
   { length: Math.floor((GRAPH_TILT_MAX - GRAPH_TILT_MIN) / GRAPH_TILT_STEP) + 1 },
   (_, i) => GRAPH_TILT_MIN + i * GRAPH_TILT_STEP,
);
const GRAPH_TILT_COUNT = GRAPH_TILT_VALUES.length;
const GRAPH_MODE_COUNT = GRAPH_MODES.length;
const GRAPH_TILE_COUNT = GRAPH_TILT_COUNT * GRAPH_MODE_COUNT;
const GRAPH_ATLAS_WIDTH = GRAPH_SAMPLE_SIZE * GRAPH_TILT_COUNT;
const GRAPH_ATLAS_HEIGHT = GRAPH_SAMPLE_SIZE * GRAPH_MODE_COUNT;
const ORIENTATION_CACHE_ANGLE_STEP_DEG = 0.05;
const ORIENTATION_CACHE_MAX_ENTRIES = 1 / ORIENTATION_CACHE_ANGLE_STEP_DEG * 30 * 2; // 30° in each direction, both axes
const ORIENTATION_CACHE_ANGLE_STEP_RAD = ORIENTATION_CACHE_ANGLE_STEP_DEG * Math.PI / 180.0;
const TILT_ANIM_STEP_SEC = 1.2;
const TILT_ANIM_CYCLE_SEC = TILT_ANIM_STEP_SEC * 2;
const TILT_PRERENDER_SAMPLE_FPS = 60;
const TILT_PRERENDER_FPS_THRESHOLD = 50;
const STONE_MARGIN_SCALE = 0.70;

// Panels are defined in index.html — just acquire references.
const designPanel = document.getElementById('designPanel');
const graphPanel = document.getElementById('lightReturnPanel');
const facetPanel = document.getElementById('facetInfoPanel');
const gemLibraryPanel = document.getElementById('gemLibraryPanel');
const designToggleEl = document.getElementById('designToggle');
const designBodyEl = document.getElementById('designBody');
const designResizeEl = document.getElementById('designResize');
const designStatusEl = document.getElementById('designStatus');
const designFacetListEl = document.getElementById('designFacetList');
const designGearEl = document.getElementById('designGear');
const designSymmetryEl = document.getElementById('designSymmetry');
const designMirrorEl = document.getElementById('designMirror');
const designAngleEl = document.getElementById('designAngle');
const designStartIndexEl = document.getElementById('designStartIndex');
const designDistanceEl = document.getElementById('designDistance');
const designNameEl = document.getElementById('designName');
const designInstructionsEl = document.getElementById('designInstructions');
const designAddFacetBtn = document.getElementById('designAddFacetBtn');
const designRecenterBtn = document.getElementById('designRecenterBtn');
const designUnitSphereBtn = document.getElementById('designUnitSphereBtn');
const designSaveGemBtn = document.getElementById('designSaveGemBtn');
const designClearBtn = document.getElementById('designClearBtn');
const graphToggleEl = document.getElementById('lightReturnToggle');
const graphHeaderEl = document.getElementById('lightReturnHeader');
const graphBodyEl = document.getElementById('lightReturnBody');
const graphResizeEl = document.getElementById('lightReturnResize');
const graphResizeRightEl = document.getElementById('lightReturnResizeRight');
const graphStatusEl = document.getElementById('lightReturnStatus');
const graphSvgEl = document.getElementById('lightReturnSvg');
const gemLibraryToggleEl = document.getElementById('gemLibraryToggle');
const gemLibraryHeaderEl = document.getElementById('gemLibraryHeader');
const gemLibraryStatusEl = document.getElementById('gemLibraryStatus');
const gemLibraryFrameEl = document.getElementById('gemLibraryFrame');
const gemLibraryResizeEl = document.getElementById('gemLibraryResize');
const gemLibraryResizeRightEl = document.getElementById('gemLibraryResizeRight');
const facetToggleEl = document.getElementById('facetInfoToggle');
const facetHeaderEl = document.getElementById('facetInfoHeader');
const facetSplitTabsEl = document.getElementById('facetSplitTabs');
const facetEditPanelEl = document.getElementById('facetEditPanel');
const facetInstructionsPanelEl = document.getElementById('facetInstructionsPanel');
const facetStatusEl = document.getElementById('facetInfoStatus');
const facetListEl = document.getElementById('facetInfoList');
const facetResizeEl = document.getElementById('facetInfoResize');
const facetResizeRightEl = document.getElementById('facetInfoResizeRight');
const designHeaderEl = document.getElementById('designHeader');
const designFooterEl = document.getElementById('designFooter');
const designSizeDriverTypeEl = document.getElementById('designSizeDriverType');
const designSizeDriverValueEl = document.getElementById('designSizeDriverValue');
const designSizeWEl = document.getElementById('designSizeW');
const designSizeLEl = document.getElementById('designSizeL');
const designSizePEl = document.getElementById('designSizeP');
const designSizeCEl = document.getElementById('designSizeC');
const designSizeUEl = document.getElementById('designSizeU');
const designSizeTEl = document.getElementById('designSizeT');
const designSizeGValueEl = document.getElementById('designSizeGValue');
const designSizeHEl = document.getElementById('designSizeH');
const designSizeCalcStatusEl = document.getElementById('designSizeCalcStatus');
let graphCanvasWidth = 388;
let graphCanvasHeight = 220;
let latestGraphSeries = null;
let latestFacetInfo = [];
let designFacets = [];
let designApplyTimer = null;
let pendingDesignApplyGeometryChanged = false;
let designHistoryStack = [];
let designHistoryIndex = -1;
let designHistoryInputBefore = null;
let designHistoryRestoreInProgress = false;
let designNumberScrubDragDepth = 0;
let designFacetReorderSuppressClickUntil = 0;
const DESIGN_HISTORY_LIMIT = 120;
let modelHasTableFacet = false;
let designSizeOverlayWidthMm = null;
const GEM_LIBRARY_ORIGIN = 'https://bogdanthegeek.github.io';
const GEM_LIBRARY_OPEN_MODEL_EVENT = 'gemlibrary:open-model';
let gemLibraryBridgeInstalled = false;

const GRAPH_THEME_DARK = {
   bg: 'rgba(255,255,255,0.04)',
   grid: 'rgba(255,255,255,0.08)',
   axis: '#cfcfcf',
   text: '#aaa',
   legendText: '#ddd',
   lineColors: {
      ISO: '#e8e8e8',
      COS: '#ff5f5f',
      SC2: '#59e35f',
      'ISO table': '#bfbfbf',
      'COS table': '#ff9393',
      'SC2 table': '#91e995',
   },
};

const GRAPH_THEME_LIGHT = {
   bg: '#ffffff',
   grid: '#d7d7d7',
   axis: '#555555',
   text: '#333333',
   legendText: '#111111',
   lineColors: {
      ISO: '#1f1f1f',
      COS: '#a31a1a',
      SC2: '#1d7e13',
      'ISO table': '#4f4f4f',
      'COS table': '#c86a6a',
      'SC2 table': '#5aa160',
   },
};

function getThemeSeriesColor(theme, series) {
   const label = String(series?.label || '').trim();
   const mapped = theme?.lineColors?.[label];
   if (mapped) return mapped;
   const baseLabel = label.replace(/\s+table$/i, '');
   const baseMapped = theme?.lineColors?.[baseLabel];
   if (baseMapped) return baseMapped;
   return series?.color || '#cccccc';
}

function escapeGraphText(text) {
   return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
}

function buildGraphSvgInner(seriesList, width, height, theme) {
   const W = Math.max(220, Math.round(width || 388));
   const H = Math.max(140, Math.round(height || 220));
   const padL = 36;
   const padR = 12;
   const padT = 12;
   const padB = 26;
   const plotW = W - padL - padR;
   const plotH = H - padT - padB;
   const toX = (tilt) => padL + ((tilt - GRAPH_TILT_MIN) / (GRAPH_TILT_MAX - GRAPH_TILT_MIN)) * plotW;
   const toY = (value) => padT + plotH - (Math.max(0, Math.min(100, value)) / 100) * plotH;

   const parts = [];
   parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${theme.bg}"/>`);

   const gridCountY = 10;
   const gridCountX = 12;
   for (let y = 0; y <= gridCountY; y++) {
      const py = padT + (plotH * y / gridCountY);
      parts.push(`<line x1="${padL}" y1="${py.toFixed(3)}" x2="${(W - padR).toFixed(3)}" y2="${py.toFixed(3)}" stroke="${theme.grid}" stroke-width="1"/>`);
   }
   for (let x = 0; x <= gridCountX; x++) {
      const px = padL + (plotW * x / gridCountX);
      parts.push(`<line x1="${px.toFixed(3)}" y1="${padT}" x2="${px.toFixed(3)}" y2="${(H - padB).toFixed(3)}" stroke="${theme.grid}" stroke-width="1"/>`);
   }

   parts.push(`<polyline points="${padL},${padT} ${padL},${H - padB} ${W - padR},${H - padB}" fill="none" stroke="${theme.axis}" stroke-width="1.2"/>`);

   for (let v = 0; v <= 100; v += 20) {
      const py = toY(v);
      parts.push(`<text x="${padL - 6}" y="${py}" text-anchor="end" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="11" fill="${theme.text}">${v}</text>`);
   }

   for (let x = GRAPH_TILT_MIN; x <= GRAPH_TILT_MAX; x += 10) {
      const px = toX(x);
      parts.push(`<text x="${px}" y="${H - padB + 17}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="11" fill="${theme.text}">${x}</text>`);
   }

   for (const series of seriesList) {
      const seriesColor = getThemeSeriesColor(theme, series);
      const path = (series.points || []).map((point, idx) => {
         const x = toX(point.tilt).toFixed(3);
         const y = toY(point.value).toFixed(3);
         return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
      }).join(' ');
      const dashAttr = series.dashed ? ' stroke-dasharray="6 4"' : '';
      parts.push(`<path d="${path}" fill="none" stroke="${seriesColor}" stroke-width="${series.dashed ? 1.5 : 2}" stroke-linecap="round"${dashAttr}/>`);
   }

   seriesList.forEach((series, idx) => {
      const y = padT + 8 + idx * 16;
      const seriesColor = getThemeSeriesColor(theme, series);
      const dashAttr = series.dashed ? ' stroke-dasharray="6 4"' : '';
      parts.push(`<line x1="${W - padR - 90}" y1="${y}" x2="${W - padR - 62}" y2="${y}" stroke="${seriesColor}" stroke-width="${series.dashed ? 1.5 : 2}"${dashAttr}/>`);
      parts.push(`<text x="${W - padR - 56}" y="${y}" text-anchor="start" dominant-baseline="middle" font-family="system-ui, sans-serif" font-size="11" fill="${theme.legendText}">${escapeGraphText(series.label || '')}</text>`);
   });

   return parts.join('');
}

function buildGraphSvgMarkup(seriesList, width, height, printTheme = false) {
   const W = Math.max(220, Math.round(width || 388));
   const H = Math.max(140, Math.round(height || 220));
   const theme = printTheme ? GRAPH_THEME_LIGHT : GRAPH_THEME_DARK;
   return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${buildGraphSvgInner(seriesList, W, H, theme)}</svg>`;
}

function hexToRgb(hex) {
   const r = parseInt(hex.slice(1, 3), 16) / 255;
   const g = parseInt(hex.slice(3, 5), 16) / 255;
   const b = parseInt(hex.slice(5, 7), 16) / 255;
   return [r, g, b];
}

function rgbToHex(rgb) {
   const r = Math.max(0, Math.min(255, Math.round((rgb?.[0] ?? 0) * 255)));
   const g = Math.max(0, Math.min(255, Math.round((rgb?.[1] ?? 0) * 255)));
   const b = Math.max(0, Math.min(255, Math.round((rgb?.[2] ?? 0) * 255)));
   return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function escapeHtml(text) {
   return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
}

function bytesPerPixelForFormat(format) {
   switch (format) {
      case 'bgra8unorm':
      case 'bgra8unorm-srgb':
      case 'rgba8unorm':
      case 'rgba8unorm-srgb':
      case 'rgba8snorm':
      case 'rgba8uint':
      case 'rgba8sint':
         return 4;
      case 'rg16float':
      case 'rg16uint':
      case 'rg16sint':
         return 4;
      case 'rgba16float':
      case 'rgba16uint':
      case 'rgba16sint':
         return 8;
      case 'r16float':
      case 'r16uint':
      case 'r16sint':
         return 2;
      case 'r32float':
      case 'r32uint':
      case 'r32sint':
         return 4;
      case 'rg32float':
      case 'rg32uint':
      case 'rg32sint':
         return 8;
      case 'rgba32float':
      case 'rgba32uint':
      case 'rgba32sint':
         return 16;
      default:
         return 4;
   }
}

function estimateCacheTextureBytes(width, height, bytesPerPixel) {
   return Math.max(0, Math.floor(width) * Math.floor(height) * bytesPerPixel);
}

function requestRender() {
   if (framePending) return;
   framePending = true;
   requestAnimationFrame(frame);
}

function clampRenderScale(scale, maxScale) {
   const upper = Math.max(0.5, maxScale || 1);
   return Math.min(upper, Math.max(0.5, scale || upper));
}

function applyBodyBackground(ui) {
   document.body.style.backgroundColor = rgbToHex(ui.backgroundColor);
}

function setGemLibraryStatus(message) {
   if (gemLibraryStatusEl) gemLibraryStatusEl.textContent = message;
}

function parseGemLibraryModelTarget(targetUrl) {
   const parsedTarget = new URL(targetUrl, window.location.href);
   const modelParams = new URLSearchParams(parsedTarget.search || '');
   const modelCandidate = (
      modelParams.get('url')
      || modelParams.get('file')
      || modelParams.get('model')
      || ''
   ).trim();

   let modelUrl = '';
   if (modelCandidate) {
      modelUrl = new URL(modelCandidate, parsedTarget.href).href;
   } else if (/\.(stl|gem|gcs|asc)$/i.test(parsedTarget.pathname || '')) {
      modelUrl = parsedTarget.href;
   }

   if (!modelUrl) {
      throw new Error('GemLibrary URL does not include a model path.');
   }

   const parsedModel = new URL(modelUrl);
   const leaf = parsedModel.pathname.split('/').filter(Boolean).pop() || 'model.stl';
   const name = decodeURIComponent(leaf);
   return { name, url: parsedModel.href };
}

function installGemLibraryMessageBridge(onOpenModel) {
   if (gemLibraryBridgeInstalled) return;
   gemLibraryBridgeInstalled = true;
   window.addEventListener('message', (event) => {
      if (event.origin !== GEM_LIBRARY_ORIGIN) return;
      if (!event.data || event.data.type !== GEM_LIBRARY_OPEN_MODEL_EVENT) return;
      const targetUrl = String(event.data.webRayUrl || '').trim();
      if (!targetUrl) {
         setGemLibraryStatus('GemLibrary sent empty model URL.');
         return;
      }
      try {
         const parsed = new URL(targetUrl, window.location.href);
         if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            setGemLibraryStatus('Blocked non-http model URL from GemLibrary.');
            return;
         }

         const targetModel = parseGemLibraryModelTarget(parsed.toString());
         if (typeof onOpenModel !== 'function') {
            setGemLibraryStatus('Model loader not ready yet.');
            return;
         }

         setGemLibraryStatus(`Loading ${targetModel.name}...`);
         Promise.resolve(onOpenModel(targetModel))
            .then(() => {
               try {
                  const nextUrl = new URL(window.location.href);
                  nextUrl.searchParams.set('url', targetModel.url);
                  window.history.replaceState(null, '', nextUrl.toString());
               } catch {
                  // Ignore URL-state sync failures.
               }
               setGemLibraryStatus(`Loaded ${targetModel.name}.`);
            })
            .catch((err) => {
               console.error(err);
               setGemLibraryStatus(`Failed to load ${targetModel.name}.`);
            });
      } catch (err) {
         console.error(err);
         setGemLibraryStatus('GemLibrary sent invalid model URL.');
      }
   });
}

function getMetadataFromDesign() {
   const metadata = {
      title: designHeaderEl.value,
      comments: designFooterEl.value,
   };
   return metadata;
}

function setMetadataToDesign(metadata) {
   if (metadata.title !== undefined) designHeaderEl.value = metadata.title;
   else designHeaderEl.value = '';
   if (metadata.comments !== undefined) designFooterEl.value = metadata.comments;
   else designFooterEl.value = '';
}

function isBootstrapFacet(facet) {
   return String(facet?.instructions || '').trim().toUpperCase() === 'BOOTSTRAP';
}


// ---------------------------------------------------------------------------
// UI panel — markup and CSS live in index.html; this function wires up
// event listeners and initialises values from the ui state object.
// ---------------------------------------------------------------------------
function buildUI(ui, cbs) {
   // Populate preset dropdown (options are generated from the JS presets array)
   const gPreset = panel.querySelector('#gPreset');
   gPreset.innerHTML = presets.map((p, i) => `<option value="${i}">${p[0]}</option>`).join('')
      + '<option value="-1">Custom</option>';

   // Initialise slider / display values from ui state
   panel.querySelector('#riSlider').value = ui.ri;
   panel.querySelector('#riVal').textContent = ui.ri.toFixed(3);
   panel.querySelector('#codSlider').value = ui.cod;
   panel.querySelector('#codVal').textContent = ui.cod.toFixed(3);
   panel.querySelector('#claritySlider').value = ui.clarity;
   panel.querySelector('#clarityVal').textContent = ui.clarity.toFixed(3);
   panel.querySelector('#tiltAngle').value = ui.tiltAngleDeg;
   panel.querySelector('#tiltVal').textContent = ui.tiltAngleDeg;
   panel.querySelector('#focalSlider').value = ui.focalLength;
   panel.querySelector('#focalVal').textContent = `${ui.focalLength} mm`;
   const renderScaleSlider = panel.querySelector('#renderScaleSlider');
   const renderScaleVal = panel.querySelector('#renderScaleVal');
   const applyRenderScaleUi = () => {
      const maxScale = Math.max(0.5, ui.renderScaleMax || 1);
      ui.renderScale = clampRenderScale(ui.renderScale, maxScale);
      renderScaleSlider.min = '0.50';
      renderScaleSlider.max = maxScale.toFixed(2);
      renderScaleSlider.step = '0.25';
      renderScaleSlider.value = ui.renderScale.toFixed(2);
      renderScaleVal.textContent = `${Math.round(ui.renderScale * 100)}%`;
   };
   applyRenderScaleUi();
   panel.querySelector('#bgColor').value = rgbToHex(ui.backgroundColor);
   panel.querySelector('#exitColor').value = '#000000';
   panel.querySelector('#headShadowColor').value = '#ffbf66';
   ui.headShadowColor = [1.0, 0.75, 0.4];
   panel.querySelector('#axisAColor').value = rgbToHex(ui.axisAColor);
   panel.querySelector('#axisBColor').value = rgbToHex(ui.axisBColor);
   panel.querySelector('#axisCColor').value = rgbToHex(ui.axisCColor);
   panel.querySelector('#axisTiltXSlider').value = ui.axisTiltXDeg;
   panel.querySelector('#axisTiltXVal').textContent = ui.axisTiltXDeg.toFixed(0);
   panel.querySelector('#axisTiltYSlider').value = ui.axisTiltYDeg;
   panel.querySelector('#axisTiltYVal').textContent = ui.axisTiltYDeg.toFixed(0);
   panel.querySelector('#axisTiltZSlider').value = ui.axisTiltZDeg;
   panel.querySelector('#axisTiltZVal').textContent = ui.axisTiltZDeg.toFixed(0);
   applyBodyBackground(ui);

   // Sync active light-mode button with ui.lightMode
   panel.querySelectorAll('#modes .mode').forEach(b =>
      b.classList.toggle('active', parseInt(b.dataset.mode) === ui.lightMode)
   );

   function setLightMode(mode) {
      console.log('Setting light mode to', mode);
      ui.lightMode = mode;
      panel.querySelectorAll('#modes .mode').forEach(b => b.classList.toggle('active', parseInt(b.dataset.mode) === mode));
      cbs.onRenderOutputChanged?.();
   }
   const easingButtonsContainer = panel.querySelector('#easing');
   for (const [name, { icon }] of Object.entries(easingFuncs)) {

      easingButtonsContainer.innerHTML += `
      <button class="mode" data-ease="${name}" title="${name}">
         <svg viewBox="-0.1 -0.1 1.2 1.2" width="16" height="16" fill="none" stroke="currentColor" stroke-width="0.1">
            <path d="${icon}" />
         </svg>
      </button>`;
   }

   panel.querySelectorAll('#easing .mode').forEach(b => b.classList.toggle('active', b.dataset.ease === ui.easingFuncName));

   easingButtonsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode[data-ease]');
      if (!btn) return;
      const easeName = btn.dataset.ease;
      const ease = easingFuncs[easeName]?.func;
      if (ease) {
         ui.easingFuncName = easeName;
         easingButtonsContainer.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b.dataset.ease === easeName));
      }
      cbs.onRenderOutputChanged?.();
   });


   const gemTopTabsEl = document.getElementById('gemTopTabs');
   const gemControlsTabPanelEl = document.getElementById('gemControlsTabPanel');
   const gemDesignTabPanelEl = document.getElementById('gemDesignTabPanel');
   const gemCutsTabPanelEl = document.getElementById('gemCutsTabPanel');
   const cutsReadoutEl = document.getElementById('cutsReadout');
   const cutsAnglePrevBtn = document.getElementById('cutsAnglePrevBtn');
   const cutsAngleNextBtn = document.getElementById('cutsAngleNextBtn');
   const cutsIndexPrevBtn = document.getElementById('cutsIndexPrevBtn');
   const cutsIndexNextBtn = document.getElementById('cutsIndexNextBtn');
   const setGemTopTab = (tabName) => {
      const isDesign = tabName === 'design';
      const isCuts = tabName === 'cuts';
      gemControlsTabPanelEl?.classList.toggle('active', !isDesign && !isCuts);
      gemDesignTabPanelEl?.classList.toggle('active', isDesign);
      gemCutsTabPanelEl?.classList.toggle('active', isCuts);
      gemTopTabsEl?.querySelectorAll('.mode').forEach((btn) => {
         btn.classList.toggle('active', btn.dataset.gemTab === tabName);
      });

      const mode = (isDesign || isCuts) ? 4 : 3; // Flat for design/cuts, default for controls
      if (mode !== ui.lightMode) {
         setLightMode(mode);
      }

      cbs.onGemTopTabChanged?.(tabName);

   };
   gemTopTabsEl?.addEventListener('click', (e) => {
      const button = e.target.closest('.mode[data-gem-tab]');
      if (!button) return;
      setGemTopTab(button.dataset.gemTab);
   });
   cutsAnglePrevBtn?.addEventListener('click', () => cbs.onCutsNavigate?.('angle', -1));
   cutsAngleNextBtn?.addEventListener('click', () => cbs.onCutsNavigate?.('angle', 1));
   cutsIndexPrevBtn?.addEventListener('click', () => cbs.onCutsNavigate?.('index', -1));
   cutsIndexNextBtn?.addEventListener('click', () => cbs.onCutsNavigate?.('index', 1));
   setGemTopTab('controls');

   // Mobile toggle
   toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('mobile-open');
      const icon = toggleBtn.querySelector('span:first-child');
      icon.textContent = panel.classList.contains('mobile-open') ? '✕' : '☰';
   });
   if (window.innerWidth <= 960) {
      const collapsePanel = (panelId, toggleId, expandLabel) => {
         document.getElementById(panelId)?.classList.add('collapsed');
         const btn = document.getElementById(toggleId);
         if (!btn) return;
         btn.textContent = '+';
         btn.setAttribute('aria-label', expandLabel);
      };
      collapsePanel('lightReturnPanel', 'lightReturnToggle', 'Expand graph');
      collapsePanel('facetInfoPanel', 'facetInfoToggle', 'Expand facet notes');
      collapsePanel('gemLibraryPanel', 'gemLibraryToggle', 'Expand gem library');
   }

   // Button triggers hidden input
   fileBtn.addEventListener('click', () => uiFileInput.click());

   uiFileInput.addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      fileNameEl.textContent = f.name;
      const url = URL.createObjectURL(f);
      cbs.onFileSelected?.(f.name, url);
   });

   const claritySlider = panel.querySelector('#claritySlider');
   const clarityVal = panel.querySelector('#clarityVal');
   const axisAColorInput = panel.querySelector('#axisAColor');
   const axisBColorInput = panel.querySelector('#axisBColor');
   const axisCColorInput = panel.querySelector('#axisCColor');
   const setClarityValue = (clarity) => {
      ui.clarity = parseFloat(clarity);
      claritySlider.value = ui.clarity;
      clarityVal.textContent = ui.clarity.toFixed(3);
   };
   const setAxisColors = (aHex, bHex, cHex) => {
      ui.axisAColor = hexToRgb(aHex);
      ui.axisBColor = hexToRgb(bHex);
      ui.axisCColor = hexToRgb(cHex);
      axisAColorInput.value = aHex;
      axisBColorInput.value = bHex;
      axisCColorInput.value = cHex;
   };
   const setAxisColorsUniform = (hex) => {
      setAxisColors(hex, hex, hex);
   };

   // --- Colour presets (apply one colour to all three axes) ---
   const gemColours = [
      '#ffffff', '#e8253a', '#1a5fd4',
      '#1db85c', '#9b59d0', '#f5c842',
      '#ff6090',
   ];
   const swatchContainer = panel.querySelector('#swatches');
   let activeSwatch = null;

   const clearSwatchActive = () => {
      if (activeSwatch) activeSwatch.classList.remove('active');
      activeSwatch = null;
   };

   if (swatchContainer) {
      gemColours.forEach(hex => {
         const el = document.createElement('div');
         el.className = 'swatch';
         el.style.background = hex;
         el.title = hex;
         el.addEventListener('click', () => {
            clearSwatchActive();
            el.classList.add('active');
            activeSwatch = el;
            setAxisColorsUniform(hex);
            axisColorPresetPicker.value = hex;
            cbs.onGraphParamsChanged?.();
            cbs.onRenderOutputChanged?.();
         });
         swatchContainer.appendChild(el);
      });

      const axisColorPresetPicker = document.createElement('input');
      axisColorPresetPicker.type = 'color';
      axisColorPresetPicker.value = axisAColorInput.value;
      axisColorPresetPicker.title = 'Custom colour preset';
      axisColorPresetPicker.addEventListener('input', () => {
         clearSwatchActive();
         setAxisColorsUniform(axisColorPresetPicker.value);
         cbs.onGraphParamsChanged?.();
         cbs.onRenderOutputChanged?.();
      });
      swatchContainer.appendChild(axisColorPresetPicker);
   }

   // --- RI slider ---
   const riSlider = panel.querySelector('#riSlider');
   const riVal = panel.querySelector('#riVal');
   riSlider.addEventListener('input', () => {
      ui.ri = parseFloat(riSlider.value);
      riVal.textContent = ui.ri.toFixed(3);
      panel.querySelector('#gPreset').value = '-1';
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   // --- COD slider ---
   const codSlider = panel.querySelector('#codSlider');
   const codVal = panel.querySelector('#codVal');
   codSlider.addEventListener('input', () => {
      ui.cod = parseFloat(codSlider.value);
      codVal.textContent = ui.cod.toFixed(3);
      panel.querySelector('#gPreset').value = '-1';
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   // --- Clarity slider ---
   claritySlider.addEventListener('input', () => {
      setClarityValue(claritySlider.value);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   // --- Preset dropdown ---
   panel.querySelector('#gPreset').addEventListener('change', (e) => {
      const idx = parseInt(e.target.value);
      if (idx < 0) return;
      const [, ri, cod, axisAHex, axisBHex, axisCHex] = presets[idx];
      ui.ri = ri;
      ui.cod = cod;
      riSlider.value = ri;
      riVal.textContent = ri.toFixed(3);
      codSlider.value = cod;
      codVal.textContent = cod.toFixed(3);
      setAxisColors(axisAHex, axisBHex, axisCHex);
      clearSwatchActive();
      setClarityValue(0.5);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   panel.querySelector('#bgColor').addEventListener('input', e => {
      ui.backgroundColor = hexToRgb(e.target.value);
      applyBodyBackground(ui);
      cbs.onRenderOutputChanged?.();
   });

   panel.querySelector('#exitColor').addEventListener('input', e => {
      ui.exitHighlight = hexToRgb(e.target.value);
      ui.exitStrength = 1.0; // Ensure it's visible when a colour is picked
      cbs.onRenderOutputChanged?.();
   });

   panel.querySelector('#headShadowColor').addEventListener('input', e => {
      ui.headShadowColor = hexToRgb(e.target.value);
      cbs.onRenderOutputChanged?.();
   });

   axisAColorInput.addEventListener('input', e => {
      ui.axisAColor = hexToRgb(e.target.value);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   axisBColorInput.addEventListener('input', e => {
      ui.axisBColor = hexToRgb(e.target.value);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   axisCColorInput.addEventListener('input', e => {
      ui.axisCColor = hexToRgb(e.target.value);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   const axisTiltXSlider = panel.querySelector('#axisTiltXSlider');
   const axisTiltXVal = panel.querySelector('#axisTiltXVal');
   axisTiltXSlider.addEventListener('input', (e) => {
      ui.axisTiltXDeg = parseFloat(e.target.value);
      axisTiltXVal.textContent = ui.axisTiltXDeg.toFixed(0);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   const axisTiltYSlider = panel.querySelector('#axisTiltYSlider');
   const axisTiltYVal = panel.querySelector('#axisTiltYVal');
   axisTiltYSlider.addEventListener('input', (e) => {
      ui.axisTiltYDeg = parseFloat(e.target.value);
      axisTiltYVal.textContent = ui.axisTiltYDeg.toFixed(0);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   const axisTiltZSlider = panel.querySelector('#axisTiltZSlider');
   const axisTiltZVal = panel.querySelector('#axisTiltZVal');
   axisTiltZSlider.addEventListener('input', (e) => {
      ui.axisTiltZDeg = parseFloat(e.target.value);
      axisTiltZVal.textContent = ui.axisTiltZDeg.toFixed(0);
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   // --- Light mode buttons ---
   panel.querySelector('#modes').addEventListener('click', (e) => {
      const btn = e.target.closest('.mode');
      if (!btn) return;
      panel.querySelectorAll('#modes .mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ui.lightMode = parseInt(btn.dataset.mode);
      cbs.onRenderOutputChanged?.();
   });

   // --- Focal length slider ---
   const focalSlider = panel.querySelector('#focalSlider');
   const focalVal = panel.querySelector('#focalVal');
   focalSlider.addEventListener('input', () => {
      ui.focalLength = parseFloat(focalSlider.value);
      focalVal.textContent = `${ui.focalLength} mm`;
      cbs.onGraphParamsChanged?.();
      cbs.onRenderOutputChanged?.();
   });

   renderScaleSlider.addEventListener('input', () => {
      const maxScale = Math.max(0.5, ui.renderScaleMax || 1);
      ui.renderScale = clampRenderScale(parseFloat(renderScaleSlider.value), maxScale);
      renderScaleSlider.value = ui.renderScale.toFixed(2);
      renderScaleVal.textContent = `${Math.round(ui.renderScale * 100)}%`;
      cbs.onRenderScaleChanged?.();
   });

   // --- View buttons (Reset / Tilt) ---
   const vTiltEl = panel.querySelector('#vTilt');
   panel.querySelector('#vReset').addEventListener('click', () => {
      vTiltEl.classList.remove('active');
      cbs.onReset();
   });
   vTiltEl.addEventListener('click', () => {
      const on = cbs.onTilt();
      vTiltEl.classList.toggle('active', on);
   });

   // Tilt angle control
   const tiltSlider = panel.querySelector('#tiltAngle');
   const tiltVal = panel.querySelector('#tiltVal');
   tiltSlider.addEventListener('input', (e) => {
      ui.tiltAngleDeg = parseFloat(e.target.value);
      tiltVal.textContent = ui.tiltAngleDeg.toFixed(0);
      requestRender();
   });

   // Instruction page printing
   async function printPreview() {
      const views = {
         top: [0, 0, 1],
         right: [-1, 0, 0],
         back: [0, 0, -1],
         front: [0, -1, 0],
      };

      // render into temporary canvases in the current window
      const dataURLs = {};
      const gear = parseInt(designGearEl.value, 10);
      const designDefinition = {
         gear: gear,
         refractiveIndex: ui.ri,
         facets: designFacets.map((facet, idx) => normalizeDesignFacet(facet, idx)),
         metadata: getMetadataFromDesign(),
      };
      const stone = buildStoneFromFacetDesign(designDefinition);
      const facesList = generateFacesFromFacetList(designDefinition.facets, gear);
      const faces = facesList.faces;
      stone.preform = facesList.preform;
      const summary = computeFacetNotesSummary(stone);
      const summaryHtml = buildFacetInfo(stone, summary);
      const size = 500;
      for (const [name, view] of Object.entries(views)) {
         const tmp = document.createElement('canvas');
         tmp.width = size;
         tmp.height = size;
         renderOrtho(faces, view, tmp, 1 / modelBoundsRadius, gear, summary);
         dataURLs[name] = tmp.toDataURL();
      }

      const graphSvg = buildGraphSvgMarkup(
         latestGraphSeries || [],
         640,
         426,
         true,
      );
      const graphImg = `<div id="graph" class="graph">${graphSvg}</div>`;

      // build html using <img> tags with the captured pixel data
      const imgs = Object.entries(dataURLs)
         .map(([name, url]) => `<img id="${name}" src="${url}" style="width:32%;aspect-ratio:1;">`)
         .join('\n');

      let stoneRenderImg = '';
      try {
         const raytraceDataUrl = await cbs.captureRaytracedStoneForPrint?.();
         if (raytraceDataUrl) {
            stoneRenderImg = `<img id="stoneRender" src="${raytraceDataUrl}" class="stoneRender">`;
         }
      } catch (err) {
         console.error('printPreview: failed to capture raytraced stone image', err);
      }

      const printWindow = window.open('', '', 'width=800,height=600');
      printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
  <style>
body { font-family: Arial; margin: 20px; }
.header { font-size: 18px; font-weight: bold; margin-bottom: 12px; margin-top: 12px; }
.facetSection {
   padding: 0px 10px 10px;
   width: 100%;
}
.facetSectionTitle {
   font-size: 12px; font-weight: 600;
   letter-spacing: .05em; text-transform: uppercase; margin: 0 0 6px;
}
.facetGroup {
   display: grid;
   grid-template-columns: 40px 58px minmax(0,1fr) minmax(0,1.2fr);
   gap: 4px 10px; align-items: start; padding: 4px 0;
}
.facetGroup + .facetGroup { border-top: 1px solid; }
.facetGroupName,
.facetGroupAngle { font-size: 12px; font-weight: 600; }
.facetGroupIndexes,
.facetGroupInst {
   font-size: 11px; line-height: 1.45;
   white-space: pre-wrap; word-break: break-word;
}
.facetGroupIndexes { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.facetGroupInst {  }
.facetEmpty { font-size: 12px; padding: 10px 2px; }
.facetSummaryCompact {
   flex-wrap: wrap;
   gap: 6px 10px;
   margin: 0 0 8px;
   padding: 6px 8px;
   border-radius: 8px;
   font-size: 11px;
   line-height: 1.3;
   white-space: pre-wrap;
}
.facetSummaryCompact strong {
   font-weight: 600;
   margin-right: 3px;
}
.facetHeader {
   display: flex;
   align-items: center;
   gap: 8px;
   margin: 0 0 6px;
}
.facetComments {
   display: flex;
   align-items: center;
   gap: 8px;
   margin: 0 0 6px;
}
.facetSummeryComments {
   white-space-collapse: collapse;
}
.wrapper {
   display: flex;
   align-items: flex-start;
   justify-content: flex-start;
   flex-direction:row;
   flex-wrap:wrap;
}
.stoneRender {
   width: min(100%, 420px);
   height: auto;
   margin: 0 12px 12px 0;
   background: #fff;
}
.graph {
   width: min(100%, 640px);
   height: auto;
   aspect-ratio: 3 / 2;
   margin-top: 20px;
   margin-left: auto;
   margin-right: auto;
   background: #fff;
   border-radius: 8px;
   border: 1px solid #ddd;
}
@media print {
    .pb { page-break-before: always; }
}
  </style>
</head>
<body>
<div class="wrapper">
${imgs}
${summaryHtml}
</div>
<div class="pb"></div>
<div class="header">Light Return Graph for RI: ${ui.ri}</div>
${graphImg}
<div class="header">Render:</div>
${stoneRenderImg}
</body>
</html>`);
      printWindow.document.close();
      printWindow.onload = () => printWindow.print();
   }
   document.getElementById('printInstructions').addEventListener('click', () => { printPreview(); });


   // External API for model-loading to push updates into the live panel
   return {
      setFileName(name) {
         fileNameEl.textContent = name;
      },
      setRI(ri) {
         ui.ri = parseFloat(ri.toFixed(3));
         riSlider.value = ui.ri;
         riVal.textContent = ui.ri.toFixed(3);
         panel.querySelector('#gPreset').value = '-1';
      },
      setCOD(cod) {
         ui.cod = parseFloat(cod.toFixed(3));
         codSlider.value = ui.cod;
         codVal.textContent = ui.cod.toFixed(3);
         panel.querySelector('#gPreset').value = '-1';
      },
      setRenderScaleMax(maxScale) {
         ui.renderScaleMax = Math.max(0.5, maxScale || 1);
         applyRenderScaleUi();
      },
      setCutsReadout(text) {
         if (!cutsReadoutEl) return;
         cutsReadoutEl.textContent = String(text || 'No cut sequence loaded.');
      },
   };
}

// ---------------------------------------------------------------------------
// setupApp — one-time WebGPU + UI init; returns { loadModel }
// ---------------------------------------------------------------------------
async function setupApp() {
   const canvas = document.getElementById('gpuCanvas');
   const isMobileDevice =
      navigator.userAgentData?.mobile
      || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
   const adapter = await navigator.gpu?.requestAdapter(
      isMobileDevice ? { powerPreference: 'low-power' } : undefined,
   );
   const adapterSupportsTimestamps = adapter?.features?.has?.('timestamp-query') ?? false;
   let device = null;
   if (adapterSupportsTimestamps) {
      try {
         device = await adapter?.requestDevice({ requiredFeatures: ['timestamp-query'] });
      } catch {
         device = null;
      }
   }
   if (!device) {
      device = await adapter?.requestDevice();
   }

   if (!device) {
      alert('WebGPU is not supported. Try a different browser.');
      return null;
   }

   const context = canvas.getContext('webgpu');
   const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
   const mobileRenderDprCap = 3; // this used to be important, but the code is fast now.
   const getRenderScaleUpperBound = () => {
      const deviceDpr = Math.max(1, window.devicePixelRatio || 1);
      return isMobileDevice
         ? Math.min(deviceDpr, mobileRenderDprCap)
         : deviceDpr;
   };
   ui.renderScaleMax = getRenderScaleUpperBound();
   if (ui.renderScale <= 0) {
      ui.renderScale = isMobileDevice ? Math.min(ui.renderScaleMax, 1.5) : ui.renderScaleMax;
   } else {
      ui.renderScale = clampRenderScale(ui.renderScale, ui.renderScaleMax);
   }
   const tiltPreRenderSampleFps = TILT_PRERENDER_SAMPLE_FPS;
   const tiltPreRenderBudgetPerFrame = 1;
   const orientationCacheMaxEntries = ORIENTATION_CACHE_MAX_ENTRIES;

   const cacheBytesPerPixel = bytesPerPixelForFormat(canvasFormat);

   context.configure({
      device,
      format: canvasFormat,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
   });

   // --- Pipeline (created once, reused for every model load) ---
   const shaderModule = device.createShaderModule({ code: shaderSource });

   const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
         module: shaderModule, entryPoint: 'vs_main',
         buffers: [{
            arrayStride: 7 * 4,
            attributes: [
               { shaderLocation: 0, offset: 0, format: 'float32x3' },
               { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },
               { shaderLocation: 2, offset: 6 * 4, format: 'float32' },
            ],
         }],
      },
      fragment: {
         module: shaderModule, entryPoint: 'fs_main',
         targets: [{
            format: canvasFormat,
            blend: {
               color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
               alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
         }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
   });

   // --- Uniform buffer (layout matches Uniforms struct in shaders.wgsl) ---
   const uniformBuffer = device.createBuffer({
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
   });

   const graphUniformBuffers = Array.from({ length: GRAPH_TILE_COUNT }, () => device.createBuffer({
      size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
   }));

   const graphPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
         module: shaderModule, entryPoint: 'vs_main',
         buffers: [{
            arrayStride: 7 * 4,
            attributes: [
               { shaderLocation: 0, offset: 0, format: 'float32x3' },
               { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },
               { shaderLocation: 2, offset: 6 * 4, format: 'float32' },
            ],
         }],
      },
      fragment: {
         module: shaderModule, entryPoint: 'fs_main',
         targets: [{
            format: GRAPH_COLOR_FORMAT,
            blend: {
               color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
               alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
         }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' },
   });

   // Separate module loaded from compute.wgsl — only declares @group(0)
   // bindings it actually uses, so Firefox doesn't require the main
   // shader's @group(0) (uniforms/triangles/bvh) to be bound at dispatch.
   const computeReduceShaderModule = device.createShaderModule({ code: computeShaderSource });
   const graphReducePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
         module: computeReduceShaderModule,
         entryPoint: 'cs_reduce_graph',
      },
   });

   // --- Depth texture (recreated on resize) ---
   let depthTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
   });
   let depthTextureView = depthTexture.createView(); // cached; recreated only on resize

   const graphColorTexture = device.createTexture({
      size: [GRAPH_ATLAS_WIDTH, GRAPH_ATLAS_HEIGHT],
      format: GRAPH_COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
   });
   const graphDepthTexture = device.createTexture({
      size: [GRAPH_ATLAS_WIDTH, GRAPH_ATLAS_HEIGHT],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
   });
   const graphAtlasParamsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
   });
   new Uint32Array(graphAtlasParamsBuffer.getMappedRange()).set([
      GRAPH_SAMPLE_SIZE,
      GRAPH_SAMPLE_SIZE,
      GRAPH_TILT_COUNT,
      GRAPH_MODE_COUNT,
   ]);
   graphAtlasParamsBuffer.unmap();
   const graphReduceBuffer = device.createBuffer({
      size: GRAPH_TILE_COUNT * GRAPH_REDUCE_CELL_U32_COUNT * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
   });
   const graphReduceReadbackBuffer = device.createBuffer({
      size: GRAPH_TILE_COUNT * GRAPH_REDUCE_CELL_U32_COUNT * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
   });

   const graphReduceBindGroup = device.createBindGroup({
      layout: graphReducePipeline.getBindGroupLayout(0),
      entries: [
         { binding: 0, resource: graphColorTexture.createView() },
         { binding: 1, resource: { buffer: graphReduceBuffer } },
         { binding: 2, resource: { buffer: graphAtlasParamsBuffer } },
      ],
   });

   const hasGpuTimestamps = device.features?.has?.('timestamp-query') ?? false;
   const frameTimestampQuerySet = hasGpuTimestamps
      ? device.createQuerySet({ type: 'timestamp', count: 2 })
      : null;
   const frameTimestampResolveBuffer = hasGpuTimestamps
      ? device.createBuffer({
         size: 16,
         usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      })
      : null;
   const frameTimestampReadbackBuffer = hasGpuTimestamps
      ? device.createBuffer({
         size: 16,
         usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      : null;
   const queueTimestampPeriod = typeof device.queue.getTimestampPeriod === 'function'
      ? device.queue.getTimestampPeriod()
      : 1;

   // Camera looks down +Z toward the table
   mat4.lookAt(viewMat, cameraPos, [0, 0, 0], [0, 1, 0]);

   function setFacetSplitTab(tabName) {
      const isEdit = tabName === 'edit';
      facetEditPanelEl?.classList.toggle('active', isEdit);
      facetInstructionsPanelEl?.classList.toggle('active', !isEdit);
      facetSplitTabsEl?.querySelectorAll('.tabBtn').forEach((button) => {
         button.classList.toggle('active', button.dataset.facetTab === tabName);
      });
   }

   facetSplitTabsEl?.addEventListener('click', (e) => {
      const button = e.target.closest('.tabBtn[data-facet-tab]');
      if (!button) return;
      setFacetSplitTab(button.dataset.facetTab || 'edit');
   });

   setFacetSplitTab('instructions');

   function resizeGraphCanvas() {
      const nextWidth = Math.max(220, Math.round(graphSvgEl?.clientWidth || graphBodyEl.clientWidth));
      const nextHeight = Math.max(140, Math.round(graphSvgEl?.clientHeight || 220));
      graphCanvasWidth = nextWidth;
      graphCanvasHeight = nextHeight;
      if (graphSvgEl) graphSvgEl.setAttribute('viewBox', `0 0 ${graphCanvasWidth} ${graphCanvasHeight}`);
      if (latestGraphSeries && !graphPanel.classList.contains('collapsed')) drawGraph(latestGraphSeries);
   }

   resizeGraphCanvas();

   let graphUpdateTimer = null;
   let graphRequestId = 0;
   let graphBusy = false;
   let graphNeedsRerun = false;
   // DOM is the source of truth for collapsed state — no separate JS flags.
   let designExpandedSize = { width: 420, height: 380 };
   let graphExpandedSize = { width: 420, height: 320 };
   let facetExpandedSize = { width: 420, height: 260 };
   let gemLibraryExpandedSize = {
      width: 480,
      height: Math.max(120, window.innerHeight - 36),
   };

   function setFacetStatus(text) {
      facetStatusEl.textContent = text;
   }

   function setDesignStatus(text) {
      designStatusEl.textContent = text;
   }

   function setDesignSizeValue(el, value, digits = 3) {
      if (!el) return;
      el.value = Number.isFinite(value) ? value.toFixed(digits) : '';
   }

   function clearDesignSizeCalculatorOutputs() {
      setDesignSizeValue(designSizeWEl, NaN);
      setDesignSizeValue(designSizeLEl, NaN);
      setDesignSizeValue(designSizePEl, NaN);
      setDesignSizeValue(designSizeCEl, NaN);
      setDesignSizeValue(designSizeUEl, NaN);
      setDesignSizeValue(designSizeTEl, NaN);
      setDesignSizeValue(designSizeHEl, NaN);
      designSizeOverlayWidthMm = null;
   }

   function setDesignSizeCalculatorStatus(text) {
      if (!designSizeCalcStatusEl) return;
      designSizeCalcStatusEl.textContent = text;
   }

   function computeDesignSizeCalculatorResult() {
      if (!currentStone) return { ok: false, message: 'Load stone to compute dimensions.' };
      const summary = computeFacetNotesSummary(currentStone);
      if (!summary || !Number.isFinite(summary.lw) || summary.lw <= 0) {
         return { ok: false, message: 'Dimensions unavailable for current stone.' };
      }

      const driverType = (designSizeDriverTypeEl?.value === 'L') ? 'L' : 'W';
      const driverValue = parseFloat(designSizeDriverValueEl?.value ?? '');
      if (!Number.isFinite(driverValue) || driverValue <= 0) {
         return { ok: false, message: 'Enter positive W or L value in mm.' };
      }

      const girdleMm = parseFloat(designSizeGValueEl?.value ?? '');
      if (!Number.isFinite(girdleMm) || girdleMm < 0) {
         return { ok: false, message: 'Enter non-negative G value in mm.' };
      }

      const widthMm = driverType === 'L'
         ? driverValue / summary.lw
         : driverValue;
      if (!Number.isFinite(widthMm) || widthMm <= 0) {
         return { ok: false, message: 'Unable to solve width from input.' };
      }

      return {
         ok: true,
         driverType,
         driverValue,
         widthMm,
         lengthMm: summary.lw * widthMm,
         pavilionMm: summary.pw * widthMm,
         crownMm: summary.cw * widthMm,
         upperMm: summary.uw * widthMm,
         tableMm: summary.tw * widthMm,
         heightMm: summary.cw * widthMm + summary.pw * widthMm + girdleMm,
      };
   }

   function refreshDesignSizeCalculator() {
      if (!designSizeDriverTypeEl || !designSizeDriverValueEl) return;
      const result = computeDesignSizeCalculatorResult();
      if (!result.ok) {
         clearDesignSizeCalculatorOutputs();
         setDesignSizeCalculatorStatus(result.message);
         return;
      }

      setDesignSizeValue(designSizeWEl, result.widthMm);
      setDesignSizeValue(designSizeLEl, result.lengthMm);
      setDesignSizeValue(designSizePEl, result.pavilionMm);
      setDesignSizeValue(designSizeCEl, result.crownMm);
      setDesignSizeValue(designSizeUEl, result.upperMm);
      setDesignSizeValue(designSizeTEl, result.tableMm);
      setDesignSizeValue(designSizeHEl, result.heightMm);
      designSizeOverlayWidthMm = result.widthMm;
      setDesignSizeCalculatorStatus(`Solved from ${result.driverType} = ${result.driverValue.toFixed(3)} mm`);
   }

   function updateDesignStatusSummary() {
      if (!designFacets.length) {
         setDesignStatus('No custom facets yet.');
         return;
      }
      const uniqueNames = new Set(designFacets.map((f) => f.name || '?')).size;
      setDesignStatus(`${designFacets.length} design facets (${uniqueNames} names)`);
   }

   function snapshotDesignFacets() {
      return designFacets.map((facet, idx) => normalizeDesignFacet({ ...facet }, idx));
   }

   function cloneDesignFacetSnapshot(snapshot) {
      return (snapshot || []).map((facet, idx) => normalizeDesignFacet({ ...facet }, idx));
   }

   function sameDesignFacetSnapshot(a, b) {
      return JSON.stringify(a || []) === JSON.stringify(b || []);
   }

   function resetDesignHistory() {
      const snapshot = snapshotDesignFacets();
      designHistoryStack = [snapshot];
      designHistoryIndex = 0;
      designHistoryInputBefore = null;
   }

   function commitDesignHistory(beforeSnapshot) {
      if (designHistoryRestoreInProgress || !beforeSnapshot) return false;
      const before = cloneDesignFacetSnapshot(beforeSnapshot);
      const after = snapshotDesignFacets();
      if (sameDesignFacetSnapshot(before, after)) return false;

      if (designHistoryIndex < designHistoryStack.length - 1) {
         designHistoryStack = designHistoryStack.slice(0, designHistoryIndex + 1);
      }
      designHistoryStack.push(after);
      if (designHistoryStack.length > DESIGN_HISTORY_LIMIT) {
         const overflow = designHistoryStack.length - DESIGN_HISTORY_LIMIT;
         designHistoryStack.splice(0, overflow);
      }
      designHistoryIndex = designHistoryStack.length - 1;
      return true;
   }

   function queueDesignInputHistory() {
      if (designHistoryRestoreInProgress) return;
      if (!designHistoryInputBefore) {
         designHistoryInputBefore = snapshotDesignFacets();
      }
   }

   function flushDesignInputHistory() {
      if (!designHistoryInputBefore || designHistoryRestoreInProgress) return;
      const before = designHistoryInputBefore;
      designHistoryInputBefore = null;
      commitDesignHistory(before);
   }

   function restoreDesignHistorySnapshot(snapshot) {
      designHistoryRestoreInProgress = true;
      designHistoryInputBefore = null;
      designFacets = cloneDesignFacetSnapshot(snapshot);
      renderDesignFacetList();
      scheduleDesignApply(true);
      designHistoryRestoreInProgress = false;
   }

   function flushPendingDesignApplyNow() {
      if (designApplyTimer) {
         clearTimeout(designApplyTimer);
         designApplyTimer = null;
         const geometryChanged = pendingDesignApplyGeometryChanged;
         pendingDesignApplyGeometryChanged = false;
         applyDesignStone(geometryChanged);
      }
      flushDesignInputHistory();
   }

   function beginDesignNumberScrubDrag() {
      designNumberScrubDragDepth += 1;
   }

   function endDesignNumberScrubDrag() {
      designNumberScrubDragDepth = Math.max(0, designNumberScrubDragDepth - 1);
   }

   function isDesignNumberScrubDragging() {
      return designNumberScrubDragDepth > 0;
   }

   function undoDesignHistory() {
      flushPendingDesignApplyNow();
      if (designHistoryIndex <= 0) return false;
      designHistoryIndex -= 1;
      restoreDesignHistorySnapshot(designHistoryStack[designHistoryIndex]);
      return true;
   }

   function redoDesignHistory() {
      flushPendingDesignApplyNow();
      if (designHistoryIndex >= designHistoryStack.length - 1) return false;
      designHistoryIndex += 1;
      restoreDesignHistorySnapshot(designHistoryStack[designHistoryIndex]);
      return true;
   }

   function renderDesignFacetList() {
      if (!designFacets.length) {
         designFacetListEl.innerHTML = '<div class="designFacetEmpty">No facets in design. Add from Create tab.</div>';
         updateDesignStatusSummary();
         return;
      }

      const rows = designFacets.map((facet, idx) => `
         <tr data-id="${escapeHtml(facet.id)}">
            <td class="cellName"><input data-field="name" type="text" value="${escapeHtml(facet.name || `F${idx + 1}`)}"></td>
            <td class="cellNum"><input data-field="symmetry" type="number" min="1" max="96" step="1" value="${facet.symmetry}"></td>
            <td class="cellMirror"><label class="check"><input data-field="mirror" type="checkbox" ${facet.mirror ? 'checked' : ''}></label></td>
            <td class="cellNum"><input data-field="angleDeg" type="number" min="-90" max="90" step="0.001" value="${facet.angleDeg.toFixed(4)}"></td>
            <td class="cellNum"><input data-field="startIndex" type="number" min="0" max="360" step="1" value="${facet.startIndex}"></td>
            <td class="cellNum"><input data-field="distance" type="number" min="-5" max="5" step="0.00001" value="${facet.distance.toFixed(5)}"></td>
            <td class="cellInst"><input data-field="instructions" type="text" value="${escapeHtml(facet.instructions || '')}"></td>
            <td class="cellRemove"><button class="designFacetRemove" type="button" data-remove="1">X</button></td>
         </tr>
      `).join('');

      designFacetListEl.innerHTML = `
         <table class="designFacetTable">
            <colgroup>
               <col class="colName">
               <col class="colSym">
               <col class="colMirror">
               <col class="colAngle">
               <col class="colStart">
               <col class="colDist">
               <col class="colInst">
               <col class="colDel">
            </colgroup>
            <thead>
               <tr>
                  <th>Name</th>
                  <th>Sym</th>
                  <th>Mirror</th>
                  <th>Angle</th>
                  <th>Index</th>
                  <th>Dist</th>
                  <th>Notes</th>
                  <th>Del</th>
               </tr>
            </thead>
            <tbody>${rows}</tbody>
         </table>
      `;

      updateDesignStatusSummary();
   }

   function readCreateFacetFromInputs() {
      return normalizeDesignFacet({
         name: designNameEl.value,
         instructions: designInstructionsEl.value,
         symmetry: parseInt(designSymmetryEl.value, 10),
         mirror: designMirrorEl.checked,
         angleDeg: parseFloat(designAngleEl.value),
         startIndex: parseInt(designStartIndexEl.value, 10),
         distance: parseFloat(designDistanceEl.value),
      }, designFacets.length);
   }

   function autofillCreateFacetDistanceFromSelectedVertex() {
      const selectedVertexId = getSingleSelectedVertexId();
      if (selectedVertexId == null) return false;
      const inputFacet = readCreateFacetFromInputs();
      const pivoted = buildFacetWithDistanceFromVertex(inputFacet, designFacets.length, selectedVertexId);
      if (!pivoted?.facet || !Number.isFinite(Number(pivoted.facet.distance))) return false;

      const planeDist = Math.abs(Number(pivoted.facet.distance));
      const keepNegativeFlat = Math.abs(Number(inputFacet.angleDeg) || 0) <= 1e-8 && Number(inputFacet.distance) < 0;
      const signedDistance = keepNegativeFlat ? -planeDist : planeDist;
      designDistanceEl.value = signedDistance.toFixed(5);
      requestRender();
      return true;
   }

   function scheduleDesignApply(geometryChanged = true) {
      pendingDesignApplyGeometryChanged = pendingDesignApplyGeometryChanged || Boolean(geometryChanged);
      if (designApplyTimer) {
         if (isDesignNumberScrubDragging()) {
            return;
         }
         clearTimeout(designApplyTimer);
      }
      designApplyTimer = setTimeout(() => {
         designApplyTimer = null;
         const nextGeometryChanged = pendingDesignApplyGeometryChanged;
         pendingDesignApplyGeometryChanged = false;
         applyDesignStone(nextGeometryChanged);
         if (!isDesignNumberScrubDragging()) {
            flushDesignInputHistory();
         }
      }, 20);
   }

   function wrapDesignGearIndex(value, gear) {
      const g = Math.max(1, Number.isFinite(Number(gear)) ? Math.round(Number(gear)) : 1);
      let idx = Number(value);
      if (!Number.isFinite(idx)) idx = 0;
      idx = idx % g;
      if (idx < 0) idx += g;
      return idx;
   }

   function mirrorDesignGearIndex(index, gear) {
      const idx = wrapDesignGearIndex(index, gear);
      if (idx === gear) return gear;
      return wrapDesignGearIndex(gear - idx, gear);
   }

   function buildDesignPlaneMetadataList(facetList, gear) {
      const g = Math.max(1, Number.isFinite(Number(gear)) ? Math.round(Number(gear)) : 1);
      const planes = [];
      const normalizedInput = (facetList || []).map((facet, idx) => normalizeDesignFacet(facet, idx));

      normalizedInput.forEach((facet, idx) => {
         const normalized = normalizeDesignFacet(facet, idx);
         const symmetryValue = parseInt(normalized.symmetry, 10);
         const symmetry = Math.max(1, Number.isFinite(symmetryValue) ? symmetryValue : 1);
         const mirror = Boolean(normalized.mirror);
         const step = g / symmetry;
         const indexSet = new Set();
         const explicitIndexes = Array.isArray(normalized.indexes)
            ? [...new Set(
               normalized.indexes
                  .map((value) => parseInt(value, 10))
                  .filter((value) => Number.isFinite(value) && value >= 0)
                  .map((value) => (value === 0 ? g : value))
                  .map((value) => wrapDesignGearIndex(value, g)),
            )]
            : [];

         if (explicitIndexes.length > 0) {
            explicitIndexes.forEach((value) => indexSet.add(value));
         } else {
            const startIndex = wrapDesignGearIndex(normalized.startIndex, g);
            for (let i = 0; i < symmetry; i++) {
               const offset = i * step;
               const primary = wrapDesignGearIndex(startIndex + offset, g);
               indexSet.add(primary);
               if (mirror) indexSet.add(mirrorDesignGearIndex(primary, g));
            }
         }

         const angle = Number.isFinite(Number(normalized.angleDeg)) ? Number(normalized.angleDeg) : 0;
         const normalizedName = String(normalized.name || `F${idx + 1}`).trim() || `F${idx + 1}`;
         const normalizedInstructions = String(normalized.instructions || '').trim();
         const normalizedFrosted = Boolean(normalized.frosted);

         if (Math.abs(angle) <= 1e-8) {
            planes.push({
               name: normalizedName,
               instructions: normalizedInstructions,
               frosted: normalizedFrosted,
            });
            return;
         }

         for (const _index of indexSet) {
            planes.push({
               name: normalizedName,
               instructions: normalizedInstructions,
               frosted: normalizedFrosted,
            });
         }
      });

      return planes;
   }

   function applyDesignMetadataToCurrentStone() {
      if (!currentStone || !Array.isArray(currentStone.facets)) return false;
      const metadata = getMetadataFromDesign();
      currentStone.metadata = metadata;
      const gear = parseInt(designGearEl.value, 10);
      const planeMetadata = buildDesignPlaneMetadataList(designFacets, gear);

      if (planeMetadata.length > 0) {
         const matchedCount = Math.min(planeMetadata.length, currentStone.facets.length);
         currentStone.facets = currentStone.facets.map((facet, idx) => {
            if (idx >= matchedCount) return facet;
            return {
               ...facet,
               name: planeMetadata[idx].name,
               instructions: planeMetadata[idx].instructions,
               frosted: planeMetadata[idx].frosted,
            };
         });
      }

      renderFacetInfo(currentStone);
      setFacetStatus(`${currentStone.facets.length} generated facets from design`);
      syncCutsSequenceFromDesignFacets();
      requestRender();
      return true;
   }

   function setDesignFromStoneFacets(facets = [], sourceGear, options = {}) {
      const { resetHistory = true } = options;
      const gear = parseInt(sourceGear, 10);
      const hasSourceGear = Number.isFinite(gear) && gear > 0;
      if (!hasSourceGear) {
         console.warn('Invalid source gear for design facets', { sourceGear });
         return;
      }
      designGearEl.value = String(gear);


      const grouped = groupExternalFacetsForDesign(facets, gear);
      const symmetryValues = grouped
         .map((facet) => parseInt(facet?.symmetry, 10))
         .filter((value) => Number.isFinite(value) && value >= 1);

      if (designSymmetryEl) {
         designSymmetryEl.max = String(gear);
         const pool = symmetryValues.some((value) => value > 1)
            ? symmetryValues.filter((value) => value > 1)
            : symmetryValues;

         if (pool.length > 0) {
            const counts = new Map();
            for (const value of pool) {
               counts.set(value, (counts.get(value) || 0) + 1);
            }
            let bestSymmetry = 1;
            let bestCount = -1;
            for (const [value, count] of counts) {
               if (count > bestCount || (count === bestCount && value > bestSymmetry)) {
                  bestCount = count;
                  bestSymmetry = value;
               }
            }
            designSymmetryEl.value = String(Math.max(1, Math.min(gear, bestSymmetry)));
         } else {
            designSymmetryEl.value = '1';
         }
      }

      designFacets = grouped.map((facet, idx) => normalizeDesignFacet(facet, idx));
      renderDesignFacetList();
      if (resetHistory) resetDesignHistory();
   }

   function installNumberDragScrub(rootEl) {
      if (!rootEl) return;
      let dragState = null;
      const DRAG_DEADZONE_PX = 3;

      const countStepDecimals = (step) => {
         if (!Number.isFinite(step)) return 0;
         const text = String(step);
         if (!text.includes('.')) return 0;
         return text.length - text.indexOf('.') - 1;
      };

      const clamp = (value, min, max) => {
         let out = value;
         if (Number.isFinite(min)) out = Math.max(min, out);
         if (Number.isFinite(max)) out = Math.min(max, out);
         return out;
      };

      rootEl.addEventListener('pointerdown', (e) => {
         const inputEl = e.target.closest('input[type="number"]');
         if (!inputEl || !rootEl.contains(inputEl) || inputEl.disabled || inputEl.readOnly) return;
         if (e.button !== 0) return;

         const startValue = parseFloat(inputEl.value);
         const step = parseFloat(inputEl.step);
         const parsedStep = Number.isFinite(step) && step > 0 ? step : 1;
         const min = parseFloat(inputEl.min);
         const max = parseFloat(inputEl.max);

         dragState = {
            inputEl,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startValue: Number.isFinite(startValue) ? startValue : 0,
            step: parsedStep,
            decimals: countStepDecimals(parsedStep),
            min: Number.isFinite(min) ? min : null,
            max: Number.isFinite(max) ? max : null,
            moved: false,
            vel: 0,
            axisLocked: false,
            scrubActive: false,
         };
      });

      rootEl.addEventListener('pointermove', (e) => {
         if (!dragState || e.pointerId !== dragState.pointerId) return;

         const dx = e.clientX - dragState.startX;
         const dy = e.clientY - dragState.startY;
         if (!dragState.axisLocked) {
            if (Math.abs(dx) < DRAG_DEADZONE_PX && Math.abs(dy) < DRAG_DEADZONE_PX) return;
            if (Math.abs(dy) > Math.abs(dx)) {
               dragState = null;
               return;
            }
            dragState.axisLocked = true;
            dragState.inputEl.setPointerCapture(e.pointerId);
            dragState.scrubActive = true;
            beginDesignNumberScrubDrag();
         }

         if (!dragState.moved && Math.abs(dx) < 2) return;
         dragState.moved = true;
         e.preventDefault();

         dragState.vel = 0.9 * dragState.vel + 0.1 * dx;
         const rawValue = dragState.startValue + dx * dragState.step * Math.max(0.1, 0.8 * Math.abs(dragState.vel));
         const clamped = clamp(rawValue, dragState.min, dragState.max);
         const snapped = Math.round(clamped / dragState.step) * dragState.step;
         const nextValue = clamp(snapped, dragState.min, dragState.max);
         dragState.inputEl.value = nextValue.toFixed(dragState.decimals);
         dragState.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const endDrag = (e) => {
         if (!dragState || e.pointerId !== dragState.pointerId) return;
         const shouldFinalizeHistory = dragState.scrubActive;
         if (dragState.inputEl.hasPointerCapture(dragState.pointerId)) {
            dragState.inputEl.releasePointerCapture(dragState.pointerId);
         }
         if (dragState.scrubActive) {
            endDesignNumberScrubDrag();
         }
         dragState = null;
         if (shouldFinalizeHistory) {
            flushPendingDesignApplyNow();
         }
      };

      rootEl.addEventListener('pointerup', endDrag);
      rootEl.addEventListener('pointercancel', endDrag);
      rootEl.addEventListener('lostpointercapture', (e) => {
         if (!dragState || e.pointerId !== dragState.pointerId) return;
         if (dragState.scrubActive) {
            endDesignNumberScrubDrag();
            flushPendingDesignApplyNow();
         }
         dragState = null;
      });
   }

   function installDesignFacetRowReorder(rootEl) {
      if (!rootEl) return;

      const DRAG_DEADZONE_PX = 3;
      let dragState = null;

      const clearDragClasses = () => {
         rootEl.classList.remove('designFacetReorderActive');
         rootEl.querySelectorAll('tr.designFacetDragging').forEach((rowEl) => rowEl.classList.remove('designFacetDragging'));
         rootEl.querySelectorAll('tr.designFacetDropBefore').forEach((rowEl) => rowEl.classList.remove('designFacetDropBefore'));
         rootEl.querySelectorAll('tr.designFacetDropAfter').forEach((rowEl) => rowEl.classList.remove('designFacetDropAfter'));
      };

      const getRows = () => [...rootEl.querySelectorAll('tbody tr[data-id]')];

      const findDropIndex = (clientY, rows) => {
         for (let idx = 0; idx < rows.length; idx += 1) {
            const rect = rows[idx].getBoundingClientRect();
            const midpoint = rect.top + (rect.height * 0.5);
            if (clientY < midpoint) return idx;
         }
         return rows.length;
      };

      const updateDropVisuals = (sourceId, dropIndex) => {
         clearDragClasses();
         const rows = getRows();
         if (!rows.length) return;

         rootEl.classList.add('designFacetReorderActive');
         const dragRow = rows.find((rowEl) => rowEl.dataset.id === sourceId);
         if (dragRow) dragRow.classList.add('designFacetDragging');

         const fromIdx = designFacets.findIndex((facet) => facet.id === sourceId);
         if (fromIdx < 0) return;
         if (dropIndex === fromIdx || dropIndex === fromIdx + 1) return;

         if (dropIndex >= rows.length) {
            rows[rows.length - 1]?.classList.add('designFacetDropAfter');
            return;
         }
         rows[dropIndex]?.classList.add('designFacetDropBefore');
      };

      const finishReorder = (state) => {
         const fromIdx = designFacets.findIndex((facet) => facet.id === state.sourceId);
         if (fromIdx < 0) return false;
         const dropIndex = Math.max(0, Math.min(state.dropIndex, designFacets.length));
         if (dropIndex === fromIdx || dropIndex === fromIdx + 1) return false;

         const next = designFacets.slice();
         const [moved] = next.splice(fromIdx, 1);
         if (!moved) return false;
         const targetIdx = dropIndex > fromIdx ? dropIndex - 1 : dropIndex;
         next.splice(targetIdx, 0, moved);

         designFacets = next.map((facet, idx) => normalizeDesignFacet(facet, idx));
         renderDesignFacetList();
         scheduleDesignApply(false);
         commitDesignHistory(state.beforeSnapshot);
         return true;
      };

      rootEl.addEventListener('pointerdown', (e) => {
         if (e.button !== 0) return;
         if (Date.now() < designFacetReorderSuppressClickUntil) return;
         const rowEl = e.target.closest('tr[data-id]');
         if (!rowEl || !rootEl.contains(rowEl)) return;
         if (e.target.closest('[data-remove]')) return;

         dragState = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            sourceId: rowEl.dataset.id,
            mode: null,
            dropIndex: designFacets.findIndex((facet) => facet.id === rowEl.dataset.id),
            beforeSnapshot: null,
         };
      });

      rootEl.addEventListener('pointermove', (e) => {
         if (!dragState || e.pointerId !== dragState.pointerId) return;

         const dx = e.clientX - dragState.startX;
         const dy = e.clientY - dragState.startY;
         if (dragState.mode !== 'vertical') {
            if (Math.abs(dx) < DRAG_DEADZONE_PX && Math.abs(dy) < DRAG_DEADZONE_PX) return;
            if (Math.abs(dy) <= Math.abs(dx)) {
               dragState = null;
               clearDragClasses();
               return;
            }

            flushPendingDesignApplyNow();
            dragState.beforeSnapshot = snapshotDesignFacets();
            dragState.mode = 'vertical';
            rootEl.setPointerCapture(e.pointerId);
         }

         e.preventDefault();
         const rows = getRows();
         if (!rows.length) return;
         dragState.dropIndex = findDropIndex(e.clientY, rows);
         updateDropVisuals(dragState.sourceId, dragState.dropIndex);
      });

      const finishDrag = (e) => {
         if (!dragState || e.pointerId !== dragState.pointerId) return;
         const state = dragState;
         dragState = null;

         if (rootEl.hasPointerCapture(state.pointerId)) {
            rootEl.releasePointerCapture(state.pointerId);
         }

         if (state.mode === 'vertical' && state.beforeSnapshot) {
            const didReorder = finishReorder(state);
            if (didReorder) {
               designFacetReorderSuppressClickUntil = Date.now() + 220;
            }
         }

         clearDragClasses();
      };

      rootEl.addEventListener('pointerup', finishDrag);
      rootEl.addEventListener('pointercancel', finishDrag);
      rootEl.addEventListener('lostpointercapture', (e) => {
         if (dragState && e.pointerId === dragState.pointerId) {
            dragState = null;
            clearDragClasses();
         }
      });
   }

   function renderFacetInfo(stone) {
      const facets = stone?.facets || [];
      latestFacetInfo = facets;
      facetListEl.innerHTML = buildFacetInfo(stone);
   }

   // Toggles a panel's collapsed state. DOM class is the sole source of truth.
   function togglePanel(panelEl, toggleEl, expandedSizeRef, name, onExpand) {
      const willCollapse = !panelEl.classList.contains('collapsed');
      const isLeftAnchored = panelEl.dataset.anchorSide === 'left';
      if (window.innerWidth > 960) {
         if (willCollapse) {
            const rect = panelEl.getBoundingClientRect();
            expandedSizeRef.width = Math.max(260, Math.round(rect.width));
            expandedSizeRef.height = Math.max(120, Math.round(rect.height));
            const rightPx = Math.max(0, Math.round(window.innerWidth - rect.right));
            const leftPx = Math.max(0, Math.round(rect.left));
            const topPx = Math.max(0, Math.round(rect.top));
            panelEl.dataset.anchorRightPx = String(rightPx);
            panelEl.dataset.anchorLeftPx = String(leftPx);
            panelEl.dataset.anchorTopPx = String(topPx);
            panelEl.style.position = 'fixed';
            panelEl.style.left = isLeftAnchored ? `${leftPx}px` : 'auto';
            panelEl.style.right = isLeftAnchored ? 'auto' : `${rightPx}px`;
            panelEl.style.top = `${topPx}px`;
            panelEl.style.bottom = 'auto';
            panelEl.style.width = '200px';
            panelEl.style.height = 'auto';
         } else {
            const desiredWidth = Math.max(260, Math.round(expandedSizeRef.width || 260));
            const desiredHeight = Math.max(120, Math.round(expandedSizeRef.height || 120));
            const rect = panelEl.getBoundingClientRect();
            const rawRight = Math.round(window.innerWidth - rect.right);
            const rawLeft = Math.round(rect.left);
            const rawTop = Math.round(rect.top);
            const maxRight = Math.max(0, window.innerWidth - desiredWidth);
            const maxLeft = Math.max(0, window.innerWidth - desiredWidth);
            const maxTop = Math.max(0, window.innerHeight - desiredHeight);
            const rightPx = Math.max(0, Math.min(maxRight, rawRight));
            const leftPx = Math.max(0, Math.min(maxLeft, rawLeft));
            const topPx = Math.max(0, Math.min(maxTop, rawTop));

            panelEl.style.position = 'fixed';
            panelEl.style.left = isLeftAnchored ? `${leftPx}px` : 'auto';
            panelEl.style.right = isLeftAnchored ? 'auto' : `${rightPx}px`;
            panelEl.style.top = `${topPx}px`;
            panelEl.style.bottom = 'auto';
            panelEl.style.width = `${desiredWidth}px`;
            panelEl.style.height = `${desiredHeight}px`;
            panelEl.style.zIndex = '120';
         }
      } else {
         panelEl.style.width = '';
         panelEl.style.height = '';
      }
      panelEl.classList.toggle('collapsed', willCollapse);
      toggleEl.textContent = willCollapse ? '+' : '−';
      toggleEl.setAttribute('aria-label', willCollapse ? `Expand ${name}` : `Minimize ${name}`);
      if (!willCollapse) onExpand?.();
   }

   function ensureDesktopFloatingPanel(panelEl) {
      if (!panelEl || window.innerWidth <= 960) return;
      const rect = panelEl.getBoundingClientRect();
      panelEl.style.position = 'fixed';
      panelEl.style.left = `${Math.max(0, Math.round(rect.left))}px`;
      panelEl.style.top = `${Math.max(0, Math.round(rect.top))}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      panelEl.style.width = `${Math.round(rect.width)}px`;
      panelEl.style.height = `${Math.round(rect.height)}px`;
      panelEl.style.zIndex = '120';
   }

   function installDesktopPanelDrag(panelEl, handleEl) {
      if (!panelEl || !handleEl) return;

      let dragState = null;
      let dragPointerId = null;
      handleEl.style.cursor = 'move';

      const resetToFlowLayoutOnMobile = () => {
         if (window.innerWidth > 960) return;
         panelEl.style.position = '';
         panelEl.style.left = '';
         panelEl.style.top = '';
         panelEl.style.right = '';
         panelEl.style.bottom = '';
         panelEl.style.zIndex = '';
      };

      const endDrag = (pointerId = dragPointerId) => {
         if (!dragState) return;
         dragState = null;
         if (pointerId != null && handleEl.hasPointerCapture(pointerId)) {
            handleEl.releasePointerCapture(pointerId);
         }
         dragPointerId = null;
      };

      window.addEventListener('resize', resetToFlowLayoutOnMobile);

      handleEl.addEventListener('pointerdown', (e) => {
         if (isMobileDevice || window.innerWidth <= 960) return;
         if (e.target.closest('button,input,textarea,select,a,[data-facet-tab],.mode')) return;

         e.preventDefault();
         e.stopPropagation();

         ensureDesktopFloatingPanel(panelEl);
         const rect = panelEl.getBoundingClientRect();

         dragState = {
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
         };
         dragPointerId = e.pointerId;
         handleEl.setPointerCapture(e.pointerId);
      });

      handleEl.addEventListener('pointermove', (e) => {
         if (!dragState || e.pointerId !== dragPointerId) return;
         const rect = panelEl.getBoundingClientRect();
         const maxLeft = Math.max(0, window.innerWidth - rect.width);
         const maxTop = Math.max(0, window.innerHeight - rect.height);
         const nextLeft = Math.max(0, Math.min(maxLeft, Math.round(e.clientX - dragState.offsetX)));
         const nextTop = Math.max(0, Math.min(maxTop, Math.round(e.clientY - dragState.offsetY)));
         panelEl.style.left = `${nextLeft}px`;
         panelEl.style.right = 'auto';
         panelEl.style.top = `${nextTop}px`;
      });

      handleEl.addEventListener('pointerup', (e) => endDrag(e.pointerId));
      handleEl.addEventListener('pointercancel', (e) => endDrag(e.pointerId));
      handleEl.addEventListener('lostpointercapture', () => endDrag());
      window.addEventListener('blur', () => endDrag());
   }

   designAddFacetBtn.addEventListener('click', () => {
      const historyBefore = snapshotDesignFacets();
      const nextFacet = readCreateFacetFromInputs();
      designFacets.push(nextFacet);
      renderDesignFacetList();
      scheduleDesignApply();
      commitDesignHistory(historyBefore);
      const lastName = designNameEl.value;
      let newName = lastName;

      const matchNumbered = lastName.match(/^(.*?)(\d+)?$/);
      if (matchNumbered) {
         const prefix = matchNumbered[1];
         const num = parseInt(matchNumbered[2], 10);
         if (Number.isFinite(num)) {
            newName = `${prefix}${num + 1}`;
         }
      }
      const matchAlphabetic = lastName.match(/^([a-zA-Z])$/);
      if (matchAlphabetic) {
         const letter = matchAlphabetic[1];
         if (letter.length === 1) {
            const nextChar = String.fromCharCode(letter.charCodeAt(0) + 1);
            if (/[a-zA-Z]/.test(nextChar)) {
               newName = nextChar;
            }
         }
      }
      designNameEl.value = newName;
   });

   designRecenterBtn?.addEventListener('click', () => {
      if (!designFacets.length) {
         setDesignStatus('Add facets before recenter.');
         return;
      }

      const gear = parseInt(designGearEl.value, 10);
      if (!Number.isFinite(gear) || gear <= 0) {
         setDesignStatus('Invalid gear for recenter.');
         return;
      }

      const historyBefore = snapshotDesignFacets();
      try {
         const designDefinition = {
            gear: gear,
            refractiveIndex: ui.ri,
            facets: designFacets.map((facet, idx) => normalizeDesignFacet(facet, idx)),
            metadata: getMetadataFromDesign(),
         };
         const stone = buildStoneFromFacetDesign(designDefinition);
         if (!(stone?.vertexData instanceof Float32Array) || stone.vertexData.length < 3) {
            setDesignStatus('Recenter failed: no geometry.');
            return;
         }

         let minZ = Infinity;
         let maxZ = -Infinity;
         for (let i = 2; i < stone.vertexData.length; i += 7) {
            const z = stone.vertexData[i];
            if (!Number.isFinite(z)) continue;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
         }

         if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
            setDesignStatus('Recenter failed: invalid vertex data.');
            return;
         }

         const deltaZ = -((minZ + maxZ) * 0.5);
         if (Math.abs(deltaZ) <= 1e-8) {
            setDesignStatus('Stone already centered.');
            return;
         }

         designFacets = designFacets.map((facet, idx) => {
            const normalized = normalizeDesignFacet(facet, idx);
            const normal = computeNormalFromPolar(normalized.angleDeg, normalized.startIndex, gear, 0);
            let nz = Number.isFinite(normal?.[2]) ? normal[2] : 0;
            if (Math.abs(normalized.angleDeg) <= 1e-8 && Number.isFinite(Number(normalized.distance)) && Number(normalized.distance) < 0) {
               nz = -1;
            }
            const nextDistance = (Number(normalized.distance) || 0) + (nz * deltaZ);
            return normalizeDesignFacet({ ...normalized, distance: nextDistance }, idx);
         });

         renderDesignFacetList();
         scheduleDesignApply(true);
         commitDesignHistory(historyBefore);
         setDesignStatus(`Recentered stone by z=${deltaZ.toFixed(4)}`);
      } catch (err) {
         console.error(err);
         setDesignStatus(`Recenter failed: ${err?.message || 'error'}`);
      }
   });

   designUnitSphereBtn?.addEventListener('click', () => {
      if (!designFacets.length) {
         setDesignStatus('Add facets before unit-sphere rescale.');
         return;
      }

      const gear = parseInt(designGearEl.value, 10);
      if (!Number.isFinite(gear) || gear <= 0) {
         setDesignStatus('Invalid gear for unit-sphere rescale.');
         return;
      }

      const historyBefore = snapshotDesignFacets();
      try {
         const designDefinition = {
            gear: gear,
            refractiveIndex: ui.ri,
            facets: designFacets.map((facet, idx) => normalizeDesignFacet(facet, idx)),
            metadata: getMetadataFromDesign(),
         };
         const stone = buildStoneFromFacetDesign(designDefinition);
         normalizeStoneToUnitSphere(stone);
         applyStoneData(currentModelFilename, stone, { syncDesignFromStone: false, isDesign: true });
         setDesignFromStoneFacets(stone.facets || [], stone.sourceGear, { resetHistory: false });
         commitDesignHistory(historyBefore);
         setDesignStatus('Rescaled design to unit sphere.');
      } catch (err) {
         console.error(err);
         setDesignStatus(`Unit-sphere rescale failed: ${err?.message || 'error'}`);
      }
   });

   designSaveGemBtn?.addEventListener('click', async () => {
      if (!designFacets.length) {
         setDesignStatus('Add at least one facet before save.');
         return;
      }

      const designDefinition = {
         gear: parseInt(designGearEl.value, 10),
         refractiveIndex: ui.ri,
         facets: designFacets.map((facet, idx) => normalizeDesignFacet(facet, idx)),
         metadata: getMetadataFromDesign(),
      };

      let exportDefinition = designDefinition;
      try {
         const normalizedStone = buildStoneFromFacetDesign(designDefinition);
         normalizeStoneToUnitSphere(normalizedStone);
         // Preserve authored facet tier/index order for export; only normalize values.
         const exportFacets = designDefinition.facets.map((facet, idx) => normalizeDesignFacet(facet, idx));
         if (exportFacets.length > 0 && normalizedStone) {
            exportDefinition = {
               ...designDefinition,
               facets: exportFacets,
            };
         }
      } catch (err) {
         console.warn('Save normalization failed; using current design facets.', err);
      }


      if (('showSaveFilePicker' in window) === false) {
         const baseName = currentModelFilename.replace(/\.[^.]+$/, '') || 'design';
         const currentExt = (String(currentModelFilename).split('.').pop() || '').toLowerCase();
         const fallbackExt = currentExt === 'asc' || currentExt === 'gcs' || currentExt === 'stl' ? currentExt : 'gem';
         let outName = `${baseName}.${fallbackExt}`;
         let blob = null;
         if (fallbackExt === 'asc') {
            const ascText = buildDesignAscText(exportDefinition);
            blob = new Blob([ascText], { type: 'text/plain;charset=utf-8' });
         } else if (fallbackExt === 'gcs') {
            const gcsText = buildDesignGcsText(exportDefinition);
            blob = new Blob([gcsText], { type: 'application/xml' });
         } else if (fallbackExt === 'stl') {
            const stlBuffer = buildDesignStlBuffer(exportDefinition);
            blob = new Blob([stlBuffer], { type: 'model/stl' });
         } else {
            const gemBuffer = buildDesignGemBuffer(exportDefinition);
            outName = `${baseName}.gem`;
            blob = new Blob([gemBuffer], { type: 'application/octet-stream' });
         }
         const url = URL.createObjectURL(blob);
         const anchor = document.createElement('a');
         anchor.href = url;
         anchor.download = outName;
         document.body.appendChild(anchor);
         anchor.click();
         document.body.removeChild(anchor);
         URL.revokeObjectURL(url);
         setDesignStatus(`Saved ${outName}`);
         return;
      }

      try {
         const handle = await window.showSaveFilePicker({
            suggestedName: currentModelFilename.replace(/\.[^.]+$/, ''),
            types: [
               {
                  description: 'GemCad File',
                  accept: { 'application/octet-stream': ['.gem'] },
               },
               {
                  description: 'GemCutStudio Design (GCS) File',
                  accept: { 'application/xml': ['.gcs'] },
               },
               {
                  description: 'GemCad ASCII Design (ASC) File',
                  accept: { 'text/plain': ['.asc'] },
               },
               {
                  description: 'STL Mesh File',
                  accept: { 'model/stl': ['.stl'] },
               },
            ],
         });

         const file = await handle.getFile();
         const extension = (file.name.split('.').pop() || '').toLowerCase();

         let content = "";
         if (extension === 'gcs') {
            content = buildDesignGcsText(exportDefinition);
         }
         else if (extension === 'stl') {
            content = buildDesignStlBuffer(exportDefinition);
         }
         else if (extension === 'gem') {
            content = buildDesignGemBuffer(exportDefinition);
         } else if (extension === 'asc') {
            content = buildDesignAscText(exportDefinition);
         } else {
            setDesignStatus('Unsupported file type selected.');
            return;
         }

         const writable = await handle.createWritable();
         await writable.write(content);
         await writable.close();

         setDesignStatus(`Saved ${file.name}`);
      } catch (err) {
         console.error(err);
         setDesignStatus(`Save failed: ${err?.message || 'invalid design'}`);
      }
   });

   designGearEl.addEventListener('input', () => {
      autofillCreateFacetDistanceFromSelectedVertex();
      scheduleDesignApply();
   });

   designAngleEl.addEventListener('input', () => {
      autofillCreateFacetDistanceFromSelectedVertex();
   });
   designStartIndexEl.addEventListener('input', () => {
      autofillCreateFacetDistanceFromSelectedVertex();
   });
   designSymmetryEl.addEventListener('input', () => {
      autofillCreateFacetDistanceFromSelectedVertex();
   });
   designMirrorEl.addEventListener('change', () => {
      autofillCreateFacetDistanceFromSelectedVertex();
   });

   designClearBtn.addEventListener('click', () => {
      designFacets = [];
      designHeaderEl.value = '';
      designFooterEl.value = '';
      renderDesignFacetList();
      resetDesignHistory();
      scheduleDesignApply();
   });

   renderDesignFacetList();
   resetDesignHistory();
   installNumberDragScrub(designBodyEl);
   installNumberDragScrub(designFacetListEl);
   installDesignFacetRowReorder(designFacetListEl);

   designFacetListEl.addEventListener('input', (e) => {
      const itemEl = e.target.closest('[data-id]');
      if (!itemEl) return;
      const facetIdx = designFacets.findIndex((facet) => facet.id === itemEl.dataset.id);
      if (facetIdx < 0) return;
      const field = e.target.dataset.field;
      if (!field) return;
      queueDesignInputHistory();
      const nextFacet = { ...designFacets[facetIdx] };
      if (field === 'mirror') nextFacet[field] = Boolean(e.target.checked);
      else if (field === 'name' || field === 'instructions') nextFacet[field] = e.target.value;
      else nextFacet[field] = parseFloat(e.target.value);
      if (field === 'symmetry' || field === 'mirror' || field === 'startIndex') {
         nextFacet.indexes = undefined;
         nextFacet.indexDistances = undefined;
      }
      if (field === 'distance') {
         nextFacet.indexDistances = undefined;
      }
      let nextNormalizedFacet = normalizeDesignFacet(nextFacet, facetIdx);
      if (field === 'angleDeg' || field === 'startIndex' || field === 'symmetry' || field === 'mirror') {
         const selectedVertexId = getSingleSelectedVertexId();
         if (selectedVertexId != null && doesVertexBelongToFacetRow(selectedVertexId, facetIdx)) {
            const pivoted = buildFacetWithDistanceFromVertex(nextNormalizedFacet, facetIdx, selectedVertexId);
            if (pivoted) {
               nextNormalizedFacet = pivoted.facet;
               const distanceEl = itemEl.querySelector('[data-field="distance"]');
               if (distanceEl) distanceEl.value = pivoted.facet.distance.toFixed(5);
            }
         }
      }
      designFacets[facetIdx] = nextNormalizedFacet;
      updateDesignStatusSummary();
      const geometryChanged = field !== 'name' && field !== 'instructions';
      scheduleDesignApply(geometryChanged);
   });

   designFacetListEl.addEventListener('click', (e) => {
      if (Date.now() < designFacetReorderSuppressClickUntil) {
         e.preventDefault();
         return;
      }
      const removeBtn = e.target.closest('[data-remove]');
      const itemEl = e.target.closest('[data-id]');
      if (!itemEl) return;

      if (removeBtn) {
         const historyBefore = snapshotDesignFacets();
         designFacets = designFacets.filter((facet) => facet.id !== itemEl.dataset.id);
         renderDesignFacetList();
         scheduleDesignApply();
         commitDesignHistory(historyBefore);
         return;
      }

      const distanceInputEl = itemEl.querySelector('[data-field="distance"]');
      if (!distanceInputEl) return;
      const distanceCellEl = distanceInputEl.closest('td');
      const clickedDistanceControl = e.target.closest('[data-field="distance"]');
      const clickedCellEl = e.target.closest('td');
      const isDistanceInteraction = clickedDistanceControl
         || (distanceCellEl && clickedCellEl && clickedCellEl === distanceCellEl);
      if (!isDistanceInteraction) return;

      if (applyFacetDistanceFromSelectedVertex(itemEl.dataset.id)) {
         requestRender();
      }
   });

   designHeaderEl.addEventListener('input', () => {
      scheduleDesignApply(false);
   });

   designFooterEl.addEventListener('input', () => {
      scheduleDesignApply(false);
   });

   designToggleEl.addEventListener('click', () => {
      togglePanel(designPanel, designToggleEl, designExpandedSize, 'stone design');
   });

   let designResizeDrag = null;
   let designResizePointerId = null;
   designResizeEl.addEventListener('pointerdown', (e) => {
      if (designPanel.classList.contains('collapsed')) return;
      e.preventDefault();
      e.stopPropagation();
      designResizeDrag = {
         top: designPanel.getBoundingClientRect().top,
         right: designPanel.getBoundingClientRect().right,
      };
      designResizePointerId = e.pointerId;
      designResizeEl.setPointerCapture(e.pointerId);
   });

   designResizeEl.addEventListener('pointermove', (e) => {
      if (!designResizeDrag) return;
      const nextWidth = Math.max(260, Math.round(designResizeDrag.right - e.clientX));
      const nextHeight = Math.max(140, Math.round(e.clientY - designResizeDrag.top));
      designPanel.style.width = `${nextWidth}px`;
      designPanel.style.height = `${nextHeight}px`;
      designExpandedSize = { width: nextWidth, height: nextHeight };
   });

   function endDesignResize(pointerId = designResizePointerId) {
      if (!designResizeDrag) return;
      designResizeDrag = null;
      if (pointerId != null && designResizeEl.hasPointerCapture(pointerId)) {
         designResizeEl.releasePointerCapture(pointerId);
      }
      designResizePointerId = null;
   }

   designResizeEl.addEventListener('pointerup', (e) => endDesignResize(e.pointerId));
   designResizeEl.addEventListener('pointercancel', (e) => endDesignResize(e.pointerId));
   designResizeEl.addEventListener('lostpointercapture', () => endDesignResize());
   window.addEventListener('pointerup', () => endDesignResize());
   window.addEventListener('blur', () => endDesignResize());

   facetToggleEl.addEventListener('click', () => {
      togglePanel(facetPanel, facetToggleEl, facetExpandedSize, 'facet notes');
   });

   let facetResizeDrag = null;
   let facetResizePointerId = null;
   function beginFacetResize(e, side) {
      if (facetPanel.classList.contains('collapsed') || window.innerWidth <= 960) return;
      e.preventDefault();
      e.stopPropagation();
      ensureDesktopFloatingPanel(facetPanel);
      const rect = facetPanel.getBoundingClientRect();
      facetResizeDrag = {
         top: rect.top,
         right: rect.right,
         left: rect.left,
         side,
         handleEl: e.currentTarget,
      };
      facetResizePointerId = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
   }

   function moveFacetResize(e) {
      if (!facetResizeDrag || e.pointerId !== facetResizePointerId) return;
      const nextWidthRaw = facetResizeDrag.side === 'right'
         ? Math.round(e.clientX - facetResizeDrag.left)
         : Math.round(facetResizeDrag.right - e.clientX);
      const nextWidth = Math.max(260, nextWidthRaw);
      const nextHeight = Math.max(120, Math.round(e.clientY - facetResizeDrag.top));
      if (facetResizeDrag.side === 'left') {
         const nextLeft = Math.round(facetResizeDrag.right - nextWidth);
         facetPanel.style.left = `${Math.max(0, nextLeft)}px`;
      }
      facetPanel.style.right = 'auto';
      facetPanel.style.width = `${nextWidth}px`;
      facetPanel.style.height = `${nextHeight}px`;
      facetExpandedSize = { width: nextWidth, height: nextHeight };
   }

   facetResizeEl.addEventListener('pointerdown', (e) => beginFacetResize(e, 'left'));
   facetResizeRightEl?.addEventListener('pointerdown', (e) => beginFacetResize(e, 'right'));
   facetResizeEl.addEventListener('pointermove', moveFacetResize);
   facetResizeRightEl?.addEventListener('pointermove', moveFacetResize);

   function endFacetResize(pointerId = facetResizePointerId) {
      if (!facetResizeDrag) return;
      const activeHandleEl = facetResizeDrag.handleEl;
      facetResizeDrag = null;
      if (pointerId != null && activeHandleEl?.hasPointerCapture(pointerId)) {
         activeHandleEl.releasePointerCapture(pointerId);
      }
      facetResizePointerId = null;
   }

   facetResizeEl.addEventListener('pointerup', (e) => endFacetResize(e.pointerId));
   facetResizeEl.addEventListener('pointercancel', (e) => endFacetResize(e.pointerId));
   facetResizeEl.addEventListener('lostpointercapture', () => endFacetResize());
   facetResizeRightEl?.addEventListener('pointerup', (e) => endFacetResize(e.pointerId));
   facetResizeRightEl?.addEventListener('pointercancel', (e) => endFacetResize(e.pointerId));
   facetResizeRightEl?.addEventListener('lostpointercapture', () => endFacetResize());
   window.addEventListener('pointerup', () => endFacetResize());
   window.addEventListener('blur', () => endFacetResize());

   installDesktopPanelDrag(graphPanel, graphHeaderEl);
   installDesktopPanelDrag(facetPanel, facetHeaderEl);

   const graphModelMat = mat4.create();
   const graphProjMat = mat4.create();

   function setGraphStatus(text) {
      graphStatusEl.textContent = text;
   }

   installGemLibraryMessageBridge(({ name, url }) => loadModel(name, url));
   if (gemLibraryFrameEl) {
      gemLibraryFrameEl.addEventListener('load', () => {
         setGemLibraryStatus('GemLibrary ready. Select model to load here without refresh.');
      });
      gemLibraryFrameEl.addEventListener('error', () => {
         setGemLibraryStatus('GemLibrary failed to load.');
      });
   }

   graphToggleEl.addEventListener('click', () => {
      togglePanel(graphPanel, graphToggleEl, graphExpandedSize, 'graph', resizeGraphCanvas);
   });

   gemLibraryToggleEl?.addEventListener('click', () => {
      gemLibraryExpandedSize.width = Math.max(480, Math.round(gemLibraryExpandedSize.width || 480));
      togglePanel(gemLibraryPanel, gemLibraryToggleEl, gemLibraryExpandedSize, 'gem library');
   });

   let graphResizeDrag = null;
   let graphResizePointerId = null;
   function beginGraphResize(e, side) {
      if (graphPanel.classList.contains('collapsed') || window.innerWidth <= 960) return;
      e.preventDefault();
      e.stopPropagation();
      ensureDesktopFloatingPanel(graphPanel);
      const rect = graphPanel.getBoundingClientRect();
      graphResizeDrag = {
         top: rect.top,
         right: rect.right,
         left: rect.left,
         side,
         handleEl: e.currentTarget,
      };
      graphResizePointerId = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
   }

   function moveGraphResize(e) {
      if (!graphResizeDrag || e.pointerId !== graphResizePointerId) return;
      const nextWidthRaw = graphResizeDrag.side === 'right'
         ? Math.round(e.clientX - graphResizeDrag.left)
         : Math.round(graphResizeDrag.right - e.clientX);
      const nextWidth = Math.max(260, nextWidthRaw);
      const nextHeight = Math.max(120, Math.round(e.clientY - graphResizeDrag.top));
      if (graphResizeDrag.side === 'left') {
         const nextLeft = Math.round(graphResizeDrag.right - nextWidth);
         graphPanel.style.left = `${Math.max(0, nextLeft)}px`;
      }
      graphPanel.style.right = 'auto';
      graphPanel.style.width = `${nextWidth}px`;
      graphPanel.style.height = `${nextHeight}px`;
      graphExpandedSize = { width: nextWidth, height: nextHeight };
      resizeGraphCanvas();
   }

   graphResizeEl.addEventListener('pointerdown', (e) => beginGraphResize(e, 'left'));
   graphResizeRightEl?.addEventListener('pointerdown', (e) => beginGraphResize(e, 'right'));
   graphResizeEl.addEventListener('pointermove', moveGraphResize);
   graphResizeRightEl?.addEventListener('pointermove', moveGraphResize);

   function endGraphResize(pointerId = graphResizePointerId) {
      if (!graphResizeDrag) return;
      const activeHandleEl = graphResizeDrag.handleEl;
      graphResizeDrag = null;
      if (pointerId != null && activeHandleEl?.hasPointerCapture(pointerId)) {
         activeHandleEl.releasePointerCapture(pointerId);
      }
      graphResizePointerId = null;
   }

   graphResizeEl.addEventListener('pointerup', (e) => endGraphResize(e.pointerId));
   graphResizeEl.addEventListener('pointercancel', (e) => endGraphResize(e.pointerId));
   graphResizeEl.addEventListener('lostpointercapture', () => endGraphResize());
   graphResizeRightEl?.addEventListener('pointerup', (e) => endGraphResize(e.pointerId));
   graphResizeRightEl?.addEventListener('pointercancel', (e) => endGraphResize(e.pointerId));
   graphResizeRightEl?.addEventListener('lostpointercapture', () => endGraphResize());
   window.addEventListener('pointerup', () => endGraphResize());
   window.addEventListener('blur', () => endGraphResize());

   let gemLibraryResizeDrag = null;
   let gemLibraryResizePointerId = null;
   function beginGemLibraryResize(e, side) {
      if (gemLibraryPanel?.classList.contains('collapsed') || window.innerWidth <= 960) return;
      e.preventDefault();
      e.stopPropagation();
      ensureDesktopFloatingPanel(gemLibraryPanel);
      const rect = gemLibraryPanel.getBoundingClientRect();
      gemLibraryResizeDrag = {
         top: rect.top,
         right: rect.right,
         left: rect.left,
         side,
         handleEl: e.currentTarget,
      };
      gemLibraryResizePointerId = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
   }

   function moveGemLibraryResize(e) {
      if (!gemLibraryResizeDrag || e.pointerId !== gemLibraryResizePointerId) return;
      const nextWidthRaw = gemLibraryResizeDrag.side === 'right'
         ? Math.round(e.clientX - gemLibraryResizeDrag.left)
         : Math.round(gemLibraryResizeDrag.right - e.clientX);
      const nextWidth = Math.max(480, nextWidthRaw);
      const nextHeight = Math.max(120, Math.round(e.clientY - gemLibraryResizeDrag.top));
      if (gemLibraryResizeDrag.side === 'left') {
         const nextLeft = Math.round(gemLibraryResizeDrag.right - nextWidth);
         gemLibraryPanel.style.left = `${Math.max(0, nextLeft)}px`;
      }
      gemLibraryPanel.style.right = 'auto';
      gemLibraryPanel.style.width = `${nextWidth}px`;
      gemLibraryPanel.style.height = `${nextHeight}px`;
      gemLibraryExpandedSize = { width: nextWidth, height: nextHeight };
   }

   gemLibraryResizeEl?.addEventListener('pointerdown', (e) => beginGemLibraryResize(e, 'left'));
   gemLibraryResizeRightEl?.addEventListener('pointerdown', (e) => beginGemLibraryResize(e, 'right'));
   gemLibraryResizeEl?.addEventListener('pointermove', moveGemLibraryResize);
   gemLibraryResizeRightEl?.addEventListener('pointermove', moveGemLibraryResize);

   function endGemLibraryResize(pointerId = gemLibraryResizePointerId) {
      if (!gemLibraryResizeDrag) return;
      const activeHandleEl = gemLibraryResizeDrag.handleEl;
      gemLibraryResizeDrag = null;
      if (pointerId != null && activeHandleEl?.hasPointerCapture(pointerId)) {
         activeHandleEl.releasePointerCapture(pointerId);
      }
      gemLibraryResizePointerId = null;
   }

   gemLibraryResizeEl?.addEventListener('pointerup', (e) => endGemLibraryResize(e.pointerId));
   gemLibraryResizeEl?.addEventListener('pointercancel', (e) => endGemLibraryResize(e.pointerId));
   gemLibraryResizeEl?.addEventListener('lostpointercapture', () => endGemLibraryResize());
   gemLibraryResizeRightEl?.addEventListener('pointerup', (e) => endGemLibraryResize(e.pointerId));
   gemLibraryResizeRightEl?.addEventListener('pointercancel', (e) => endGemLibraryResize(e.pointerId));
   gemLibraryResizeRightEl?.addEventListener('lostpointercapture', () => endGemLibraryResize());
   window.addEventListener('pointerup', () => endGemLibraryResize());
   window.addEventListener('blur', () => endGemLibraryResize());

   // Use one positioning model from startup so resize behavior is identical
   // before and after any drag interaction.
   ensureDesktopFloatingPanel(graphPanel);
   ensureDesktopFloatingPanel(facetPanel);
   ensureDesktopFloatingPanel(gemLibraryPanel);
   if (window.innerWidth > 960 && gemLibraryPanel) {
      const desiredWidth = Math.max(480, Math.round(gemLibraryExpandedSize.width || 480));
      const desiredHeight = Math.max(120, Math.round(window.innerHeight - 36));
      gemLibraryExpandedSize = { width: desiredWidth, height: desiredHeight };
      gemLibraryPanel.dataset.anchorSide = 'left';
      gemLibraryPanel.style.position = 'fixed';
      gemLibraryPanel.style.left = '18px';
      gemLibraryPanel.style.right = 'auto';
      gemLibraryPanel.style.top = '18px';
      gemLibraryPanel.style.bottom = 'auto';
      gemLibraryPanel.style.width = `${desiredWidth}px`;
      gemLibraryPanel.style.height = `${desiredHeight}px`;
      gemLibraryPanel.style.zIndex = '120';
   }
   installDesktopPanelDrag(gemLibraryPanel, gemLibraryHeaderEl);
   if (window.innerWidth > 960) {
      const graphRect = graphPanel.getBoundingClientRect();
      const facetRect = facetPanel.getBoundingClientRect();
      const desiredTop = Math.round(graphRect.bottom + 12);
      if (facetRect.top < desiredTop) {
         const maxTop = Math.max(0, window.innerHeight - Math.round(facetRect.height));
         facetPanel.style.top = `${Math.max(0, Math.min(maxTop, desiredTop))}px`;
      }
   }

   const graphResizeObserver = new ResizeObserver(() => {
      if (!graphPanel.classList.contains('collapsed')) resizeGraphCanvas();
   });
   graphResizeObserver.observe(graphPanel);
   graphResizeObserver.observe(graphSvgEl);

   const uniformScratch = new Float32Array(320 / 4);
   const invViewProjMat = mat4.create();
   const invModelMat = mat4.create();

   let currentGemTab = 'controls';
   let cutsSourceStone = null;
   let cutsSequence = [];
   let cutsAngleIndex = 0;
   let cutsIndexIndex = 0;
   let cutsActionChain = Promise.resolve();
   let cutsRestoreStone = null;
   let cutsRestoreFilename = '';
   let cutsRestoreIsDesign = false;
   let designPickDirty = true;
   let designHaloCache = null;
   let designHover = null;
   let designPointerClientX = 0;
   let designPointerClientY = 0;
   let designSelection = {
      vertexIds: [],
      edgeIds: [],
   };
   let designPickCache = {
      vertices: [], // { id, p:[x,y,z], key, faceIds:number[] }
      edges: [], // { id, aId, bId, faceIds:number[] }
      faces: [], // { id, normal:[x,y,z], center:[x,y,z], vertexIds:number[] }
   };

   const selectionOverlayCanvas = document.createElement('canvas');
   selectionOverlayCanvas.id = 'selectionOverlayCanvas';
   Object.assign(selectionOverlayCanvas.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '80',
      display: 'block',
   });
   document.body.appendChild(selectionOverlayCanvas);
   const selectionOverlayCtx = selectionOverlayCanvas.getContext('2d');
   let selectionOverlayDpr = Math.max(1, window.devicePixelRatio || 1);
   let selectionOverlayCssWidth = Math.max(1, window.innerWidth || 1);
   let selectionOverlayCssHeight = Math.max(1, window.innerHeight || 1);

   function resizeSelectionOverlay() {
      selectionOverlayDpr = Math.max(1, window.devicePixelRatio || 1);
      const viewport = window.visualViewport;
      const cssW = Math.max(1, Math.round(viewport?.width || window.innerWidth || 1));
      const cssH = Math.max(1, Math.round(viewport?.height || window.innerHeight || 1));
      selectionOverlayCssWidth = cssW;
      selectionOverlayCssHeight = cssH;

      selectionOverlayCanvas.style.width = `${cssW}px`;
      selectionOverlayCanvas.style.height = `${cssH}px`;

      const w = Math.max(1, Math.round(cssW * selectionOverlayDpr));
      const h = Math.max(1, Math.round(cssH * selectionOverlayDpr));
      if (selectionOverlayCanvas.width !== w) selectionOverlayCanvas.width = w;
      if (selectionOverlayCanvas.height !== h) selectionOverlayCanvas.height = h;
      selectionOverlayCtx.setTransform(selectionOverlayDpr, 0, 0, selectionOverlayDpr, 0, 0);
   }

   function clearDesignSelection(clearSelected = true) {
      designHover = null;
      if (clearSelected) {
         designSelection.vertexIds = [];
         designSelection.edgeIds = [];
      }
   }

   function invalidateDesignPickState(clearSelected = true) {
      designPickDirty = true;
      clearDesignSelection(clearSelected);
   }

   function computeGearLabelStep(gear) {
      for (let d = 5; d <= gear; d++) {
         if (gear % d === 0) return d;
      }
      return 5;
   }

   function updateCutsReadout() {
      if (!uiControls?.setCutsReadout) return;
      if (!cutsSequence.length) {
         uiControls.setCutsReadout('No cut sequence loaded.');
         return;
      }

      const group = cutsSequence[cutsAngleIndex];
      const step = group?.steps?.[cutsIndexIndex];
      if (!group || !step) {
         uiControls.setCutsReadout('No cut sequence loaded.');
         return;
      }

      const indexLabel = String(step.index).padStart(2, '0');
      const cutName = step.name || '?';
      const cutInstructions = step.instructions ? `\n${step.instructions}` : '';
      const text = [
         `Angle: ${group.angleLabel} (${cutsAngleIndex + 1}/${cutsSequence.length})`,
         `Index: ${indexLabel} (${cutsIndexIndex + 1}/${group.steps.length})`,
         `Cut: ${cutName}${cutInstructions}`,
      ].join('\n');
      uiControls.setCutsReadout(text);
   }

   function setCutsSequenceFromStone(stone) {
      const facets = Array.isArray(stone?.facets) ? stone.facets : [];
      const sourceGear = parseInt(stone?.sourceGear, 10);
      const gear = Number.isFinite(sourceGear) && sourceGear > 0
         ? sourceGear
         : Math.max(1, parseInt(designGearEl.value, 10) || 96);
      const grouped = buildInstructionAngleCutSequence(facets, gear);

      cutsSourceStone = stone || null;
      cutsSequence = grouped.map((group, groupIdx) => {
         const steps = [];
         group.cuts.forEach((cut, cutIdx) => {
            const indexes = Array.isArray(cut.indexes) && cut.indexes.length
               ? cut.indexes
               : [Math.max(1, parseInt(cut.startIndex, 10) || 1)];

            indexes.forEach((indexValue, indexIdx) => {
               const index = Math.max(1, parseInt(indexValue, 10) || 1);
               const facet = normalizeDesignFacet({
                  id: `cut-${groupIdx}-${cutIdx}-${indexIdx}`,
                  name: cut.name,
                  instructions: cut.instructions,
                  symmetry: 1,
                  mirror: false,
                  angleDeg: cut.angleDeg,
                  startIndex: index,
                  distance: cut.distance,
                  indexes: [index],
               }, steps.length);
               steps.push({
                  name: cut.name,
                  instructions: cut.instructions,
                  index,
                  facet,
               });
            });
         });

         return {
            angleDeg: group.angleDeg,
            angleLabel: group.angleLabel,
            steps,
         };
      }).filter((group) => group.steps.length > 0);

      cutsAngleIndex = 0;
      cutsIndexIndex = 0;
      updateCutsReadout();
   }

   function moveCutsAngle(direction) {
      if (!cutsSequence.length) return;
      const total = cutsSequence.length;
      const nextAngle = cutsAngleIndex + direction;
      if (nextAngle < 0 || nextAngle >= total) return;
      cutsAngleIndex = nextAngle;
      const stepCount = cutsSequence[cutsAngleIndex]?.steps?.length || 1;
      cutsIndexIndex = direction > 0 ? Math.max(0, stepCount - 1) : 0;
   }

   function moveCutsIndex(direction) {
      if (!cutsSequence.length) return;
      const group = cutsSequence[cutsAngleIndex];
      if (!group || !group.steps.length) return;

      const next = cutsIndexIndex + direction;
      if (next >= 0 && next < group.steps.length) {
         cutsIndexIndex = next;
         return;
      }

      if (direction > 0) {
         const prevAngleIndex = cutsAngleIndex;
         moveCutsAngle(1);
         if (cutsAngleIndex !== prevAngleIndex) {
            cutsIndexIndex = 0;
         }
      } else {
         const prevAngleIndex = cutsAngleIndex;
         moveCutsAngle(-1);
         if (cutsAngleIndex !== prevAngleIndex) {
            const prevGroup = cutsSequence[cutsAngleIndex];
            cutsIndexIndex = Math.max(0, (prevGroup?.steps?.length || 1) - 1);
         }
      }
   }

   function buildCutsFacetPreviewSubset() {
      if (!cutsSequence.length) return [];
      const out = [];
      for (let groupIdx = 0; groupIdx <= cutsAngleIndex; groupIdx++) {
         const group = cutsSequence[groupIdx];
         if (!group || !Array.isArray(group.steps)) continue;
         const limit = groupIdx < cutsAngleIndex
            ? group.steps.length
            : Math.min(group.steps.length, cutsIndexIndex + 1);
         for (let stepIdx = 0; stepIdx < limit; stepIdx++) {
            out.push(group.steps[stepIdx].facet);
         }
      }
      return out;
   }

   async function applyCutsPreviewFromCursor() {
      if (!cutsSequence.length || !cutsSourceStone) return;

      const gear = Math.max(1, parseInt(cutsSourceStone.sourceGear, 10) || 96);
      const designDefinition = {
         gear,
         refractiveIndex: ui.ri,
         facets: buildCutsFacetPreviewSubset(),
         metadata: cutsSourceStone.metadata || getMetadataFromDesign(),
      };
      const stone = buildStoneFromFacetDesign(designDefinition);
      await applyStoneData(currentModelFilename, stone, { syncDesignFromStone: false, isDesign: true });

      // Keep instruction pane anchored to source instructions while previewing cuts.
      renderFacetInfo(cutsSourceStone);
      setFacetStatus(`${cutsSourceStone.facets.length} facets parsed from ${currentModelFilename} (cuts preview)`);
   }

   function queueCutsNavigation(kind, direction) {
      cutsActionChain = cutsActionChain
         .then(async () => {
            if (!cutsSequence.length) return;
            if (kind === 'angle') moveCutsAngle(direction);
            else moveCutsIndex(direction);
            updateCutsReadout();
            await applyCutsPreviewFromCursor();
            requestRender();
         })
         .catch((err) => {
            console.error('Cuts navigation failed:', err);
         });
   }

   function captureCutsRestoreState(fromTab) {
      if (!currentStone) return;
      cutsRestoreStone = currentStone;
      cutsRestoreFilename = currentModelFilename;
      cutsRestoreIsDesign = fromTab === 'design';
   }

   function setCutsRestoreState(stone, filename, isDesign = false) {
      cutsRestoreStone = stone || null;
      cutsRestoreFilename = filename || currentModelFilename || '';
      cutsRestoreIsDesign = !!isDesign;
   }

   function queueRestoreAfterCuts() {
      const restoreStone = cutsRestoreStone;
      const restoreFilename = cutsRestoreFilename || currentModelFilename;
      const restoreIsDesign = cutsRestoreIsDesign;
      if (!restoreStone) return;

      cutsActionChain = cutsActionChain
         .then(async () => {
            await applyStoneData(restoreFilename, restoreStone, {
               syncDesignFromStone: false,
               isDesign: restoreIsDesign,
            });
            requestRender();
         })
         .catch((err) => {
            console.error('Cuts restore failed:', err);
         });
   }

   function getDesignHaloSpec() {
      const stone = currentStone;
      if (!stone || !(stone.vertexData instanceof Float32Array) || stone.vertexData.length < 7) return null;
      if (designHaloCache?.stone === stone) return designHaloCache;

      let minZ = Infinity;
      let maxZ = -Infinity;
      let maxRxy = 0;
      const data = stone.vertexData;
      for (let i = 0; i < data.length; i += 7) {
         const x = data[i + 0];
         const y = data[i + 1];
         const z = data[i + 2];
         if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
         if (z < minZ) minZ = z;
         if (z > maxZ) maxZ = z;
         const rxy = Math.hypot(x, y);
         if (rxy > maxRxy) maxRxy = rxy;
      }

      if (!Number.isFinite(minZ) || !Number.isFinite(maxZ) || !Number.isFinite(maxRxy)) return null;
      const margin = Math.max(0.02, modelBoundsRadius * 0.06);
      designHaloCache = {
         stone,
         z: (minZ + maxZ) * 0.5,
         radius: Math.max(0.05, maxRxy + margin),
      };
      return designHaloCache;
   }

   function roundKey(v) {
      return Math.round(v * 100000);
   }

   function buildFallbackFacesFromStoneMesh(stone, facetList) {
      const data = stone?.vertexData;
      const facets = Array.isArray(stone?.facets) ? stone.facets : [];
      if (!(data instanceof Float32Array) || data.length < 7 || !facets.length) return [];

      const sourceFacets = Array.isArray(facetList) ? facetList : [];
      const faces = [];
      const floatsPerVertex = 7;
      const vertsPerTri = 3;
      let triOffset = 0;

      const findSourceFacetOrder = (name, instructions) => {
         const targetName = String(name || '').trim();
         const targetInst = String(instructions || '').trim();
         if (!targetName && !targetInst) return -1;
         return sourceFacets.findIndex((facet) => {
            const facetName = String(facet?.name || '').trim();
            const facetInst = String(facet?.instructions || '').trim();
            return facetName === targetName && facetInst === targetInst;
         });
      };

      for (const facet of facets) {
         const triCount = Math.max(0, Math.round(Number(facet?.triangleCount) || 0));
         if (triCount <= 0) continue;

         const unique = new Map();
         for (let t = 0; t < triCount; t++) {
            const triBase = (triOffset + t) * vertsPerTri * floatsPerVertex;
            for (let v = 0; v < vertsPerTri; v++) {
               const base = triBase + v * floatsPerVertex;
               const x = Number(data[base + 0]);
               const y = Number(data[base + 1]);
               const z = Number(data[base + 2]);
               if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
               const key = `${roundKey(x)}|${roundKey(y)}|${roundKey(z)}`;
               if (!unique.has(key)) unique.set(key, [x, y, z]);
            }
         }
         triOffset += triCount;

         const verts = [...unique.values()];
         if (verts.length < 3) continue;

         const normal = Array.isArray(facet?.normal) && facet.normal.length >= 3
            ? normalize3([Number(facet.normal[0]), Number(facet.normal[1]), Number(facet.normal[2])])
            : [0, 0, 0];
         if (len3(normal) <= 1e-8) continue;

         let cx = 0;
         let cy = 0;
         let cz = 0;
         for (const p of verts) {
            cx += p[0];
            cy += p[1];
            cz += p[2];
         }
         cx /= verts.length;
         cy /= verts.length;
         cz /= verts.length;

         let basis = [1, 0, 0];
         if (Math.abs(normal[0]) > 0.9) basis = [0, 1, 0];
         let tangent = normalize3(cross3(normal, basis));
         if (len3(tangent) <= 1e-8) tangent = normalize3(cross3(normal, [0, 0, 1]));
         const bitangent = normalize3(cross3(tangent, normal));
         if (len3(bitangent) <= 1e-8) continue;

         const ordered = verts
            .map((p) => {
               const delta = sub3(p, [cx, cy, cz]);
               const u = dot3(delta, bitangent);
               const v = dot3(delta, tangent);
               return { p, angle: Math.atan2(v, u) };
            })
            .sort((a, b) => a.angle - b.angle)
            .map((entry) => entry.p);

         faces.push({
            name: String(facet?.name || ''),
            instructions: String(facet?.instructions || ''),
            normal,
            vertices: ordered,
            sourceFacetOrder: findSourceFacetOrder(facet?.name, facet?.instructions),
            sourceGearIndex: null,
         });
      }

      return faces;
   }

   function buildDesignPickCacheIfNeeded() {
      if (!designPickDirty) return;
      designPickDirty = false;
      designPickCache = { vertices: [], edges: [], faces: [] };

      const stone = currentStone;
      if (!stone) return;

      const vertexMap = new Map();
      const edgeMap = new Map();
      const vertices = [];
      const edges = [];
      const facesCache = [];

      const gearValue = parseInt(designGearEl.value, 10);
      const pickGear = Number.isFinite(gearValue) && gearValue > 0
         ? gearValue
         : (Number.isFinite(Number(stone.sourceGear)) && Number(stone.sourceGear) > 0
            ? Number(stone.sourceGear)
            : 96);

      const sourceFacetList = (Array.isArray(designFacets) && designFacets.length > 0)
         ? designFacets
         : groupExternalFacetsForDesign(Array.isArray(stone.facets) ? stone.facets : [], pickGear);
      let faces = buildFallbackFacesFromStoneMesh(stone, sourceFacetList);
      if (!Array.isArray(faces) || faces.length === 0) {
         const facesList = generateFacesFromFacetList(sourceFacetList, pickGear);
         faces = facesList.faces;
      }
      if (!Array.isArray(faces) || faces.length === 0) return;

      const getVertexId = (x, y, z) => {
         const key = `${roundKey(x)}|${roundKey(y)}|${roundKey(z)}`;
         const found = vertexMap.get(key);
         if (found != null) return found;
         const id = vertices.length;
         vertices.push({ id, p: [x, y, z], key, faceIds: [] });
         vertexMap.set(key, id);
         return id;
      };

      const getEdgeId = (aId, bId) => {
         const lo = Math.min(aId, bId);
         const hi = Math.max(aId, bId);
         const edgeKey = `${lo}|${hi}`;
         const found = edgeMap.get(edgeKey);
         if (found != null) return found;
         const id = edges.length;
         edges.push({ id, aId: lo, bId: hi, faceIds: [] });
         edgeMap.set(edgeKey, id);
         return id;
      };

      for (const face of faces) {
         const faceVerts = Array.isArray(face?.vertices) ? face.vertices : [];
         if (faceVerts.length < 2) continue;
         const ids = [];
         for (const v of faceVerts) {
            if (!Array.isArray(v) || v.length < 3) continue;
            const x = Number(v[0]);
            const y = Number(v[1]);
            const z = Number(v[2]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            ids.push(getVertexId(x, y, z));
         }
         if (ids.length < 2) continue;

         const faceId = facesCache.length;
         const center = [0, 0, 0];
         for (const vertexId of ids) {
            const p = vertices[vertexId].p;
            center[0] += p[0];
            center[1] += p[1];
            center[2] += p[2];
            vertices[vertexId].faceIds.push(faceId);
         }
         center[0] /= ids.length;
         center[1] /= ids.length;
         center[2] /= ids.length;

         let normal = [0, 0, 0];
         if (Array.isArray(face?.normal) && face.normal.length >= 3
            && Number.isFinite(face.normal[0]) && Number.isFinite(face.normal[1]) && Number.isFinite(face.normal[2])) {
            normal = normalize3([Number(face.normal[0]), Number(face.normal[1]), Number(face.normal[2])]);
         }
         if (len3(normal) <= 1e-8 && ids.length >= 3) {
            const p0 = vertices[ids[0]].p;
            const p1 = vertices[ids[1]].p;
            const p2 = vertices[ids[2]].p;
            normal = normalize3(cross3(sub3(p1, p0), sub3(p2, p0)));
         }
         facesCache.push({
            id: faceId,
            normal,
            center,
            vertexIds: ids.slice(),
            sourceFacetOrder: Number.isFinite(Number(face?.sourceFacetOrder))
               ? Number(face.sourceFacetOrder)
               : -1,
            sourceGearIndex: Number.isFinite(Number(face?.sourceGearIndex))
               ? Number(face.sourceGearIndex)
               : null,
         });

         for (let i = 0; i < ids.length; i++) {
            const aRaw = ids[i];
            const bRaw = ids[(i + 1) % ids.length];
            if (aRaw === bRaw) continue;
            const edgeId = getEdgeId(aRaw, bRaw);
            const edge = edges[edgeId];
            if (!edge.faceIds.includes(faceId)) edge.faceIds.push(faceId);
         }
      }

      designPickCache = { vertices, edges, faces: facesCache };
   }

   function dot3(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
   }

   function sub3(a, b) {
      return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
   }

   function add3(a, b) {
      return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
   }

   function scale3(v, s) {
      return [v[0] * s, v[1] * s, v[2] * s];
   }

   function len3(v) {
      return Math.hypot(v[0], v[1], v[2]);
   }

   function normalize3(v) {
      const len = len3(v);
      if (!Number.isFinite(len) || len <= 1e-9) return [0, 0, 0];
      return scale3(v, 1 / len);
   }

   function cross3(a, b) {
      return [
         a[1] * b[2] - a[2] * b[1],
         a[2] * b[0] - a[0] * b[2],
         a[0] * b[1] - a[1] * b[0],
      ];
   }

   function distanceRayToPoint(rayOrigin, rayDir, point) {
      const toPoint = sub3(point, rayOrigin);
      const t = Math.max(0, dot3(toPoint, rayDir));
      const closest = add3(rayOrigin, scale3(rayDir, t));
      return {
         dist: len3(sub3(point, closest)),
         rayT: t,
      };
   }

   function distanceRayToSegment(rayOrigin, rayDir, segA, segB) {
      const u = rayDir;
      const v = sub3(segB, segA);
      const w = sub3(rayOrigin, segA);
      const a = dot3(u, u);
      const b = dot3(u, v);
      const c = dot3(v, v);
      const d = dot3(u, w);
      const e = dot3(v, w);
      const den = a * c - b * b;

      let sc = 0;
      let tc = 0;

      if (Math.abs(den) < 1e-8 || c <= 1e-8) {
         sc = 0;
         tc = c > 1e-8 ? Math.max(0, Math.min(1, e / c)) : 0;
      } else {
         sc = (b * e - c * d) / den;
         tc = (a * e - b * d) / den;
         if (sc < 0) {
            sc = 0;
            tc = Math.max(0, Math.min(1, e / c));
         } else {
            tc = Math.max(0, Math.min(1, tc));
         }
      }

      const pRay = add3(rayOrigin, scale3(u, sc));
      const pSeg = add3(segA, scale3(v, tc));
      return {
         dist: len3(sub3(pRay, pSeg)),
         rayT: sc,
      };
   }

   function intersectRayWithFacePolygon(rayOrigin, rayDir, face, vertices) {
      if (!face || !Array.isArray(face.vertexIds) || face.vertexIds.length < 3) return null;
      const normal = Array.isArray(face.normal) ? face.normal : null;
      if (!normal || len3(normal) <= 1e-8) return null;

      const p0 = vertices[face.vertexIds[0]]?.p;
      if (!p0) return null;

      const denom = dot3(normal, rayDir);
      if (Math.abs(denom) <= 1e-8) return null;

      const rayT = dot3(normal, sub3(p0, rayOrigin)) / denom;
      if (!Number.isFinite(rayT) || rayT < 0) return null;

      const hitPoint = add3(rayOrigin, scale3(rayDir, rayT));
      let hasPos = false;
      let hasNeg = false;

      for (let i = 0; i < face.vertexIds.length; i++) {
         const a = vertices[face.vertexIds[i]]?.p;
         const b = vertices[face.vertexIds[(i + 1) % face.vertexIds.length]]?.p;
         if (!a || !b) return null;
         const edge = sub3(b, a);
         const toHit = sub3(hitPoint, a);
         const side = dot3(normal, cross3(edge, toHit));
         if (side > 1e-7) hasPos = true;
         else if (side < -1e-7) hasNeg = true;
         if (hasPos && hasNeg) return null;
      }

      return { rayT };
   }

   function cursorToModelRay(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = 1 - ((clientY - rect.top) / rect.height) * 2;

      const nearWorld = vec4.fromValues(x, y, -1, 1);
      const farWorld = vec4.fromValues(x, y, 1, 1);
      vec4.transformMat4(nearWorld, nearWorld, invViewProjMat);
      vec4.transformMat4(farWorld, farWorld, invViewProjMat);
      if (Math.abs(nearWorld[3]) <= 1e-8 || Math.abs(farWorld[3]) <= 1e-8) return null;
      nearWorld[0] /= nearWorld[3]; nearWorld[1] /= nearWorld[3]; nearWorld[2] /= nearWorld[3];
      farWorld[0] /= farWorld[3]; farWorld[1] /= farWorld[3]; farWorld[2] /= farWorld[3];

      const nearModel = vec4.fromValues(nearWorld[0], nearWorld[1], nearWorld[2], 1);
      const farModel = vec4.fromValues(farWorld[0], farWorld[1], farWorld[2], 1);
      vec4.transformMat4(nearModel, nearModel, invModelMat);
      vec4.transformMat4(farModel, farModel, invModelMat);
      if (Math.abs(nearModel[3]) <= 1e-8 || Math.abs(farModel[3]) <= 1e-8) return null;
      nearModel[0] /= nearModel[3]; nearModel[1] /= nearModel[3]; nearModel[2] /= nearModel[3];
      farModel[0] /= farModel[3]; farModel[1] /= farModel[3]; farModel[2] /= farModel[3];

      const origin = [nearModel[0], nearModel[1], nearModel[2]];
      const dir = normalize3([
         farModel[0] - nearModel[0],
         farModel[1] - nearModel[1],
         farModel[2] - nearModel[2],
      ]);
      if (len3(dir) <= 1e-8) return null;
      return { origin, dir };
   }

   function pickDesignEntity(clientX, clientY) {
      buildDesignPickCacheIfNeeded();
      const ray = cursorToModelRay(clientX, clientY);
      if (!ray) return null;

      const cameraModel4 = vec4.fromValues(cameraPos[0], cameraPos[1], cameraPos[2], 1);
      vec4.transformMat4(cameraModel4, cameraModel4, invModelMat);
      if (Math.abs(cameraModel4[3]) <= 1e-8) return null;
      const cameraModel = [
         cameraModel4[0] / cameraModel4[3],
         cameraModel4[1] / cameraModel4[3],
         cameraModel4[2] / cameraModel4[3],
      ];

      const faceVisibility = designPickCache.faces.map((face) => {
         if (!face || !Array.isArray(face.normal) || len3(face.normal) <= 1e-8) return false;
         const toCamera = sub3(cameraModel, face.center);
         return dot3(face.normal, toCamera) > 1e-8;
      });

      const isVertexVisible = (vertex) => {
         if (!vertex || !Array.isArray(vertex.faceIds) || vertex.faceIds.length === 0) return false;
         for (const faceId of vertex.faceIds) {
            if (faceVisibility[faceId]) return true;
         }
         return false;
      };

      const isEdgeVisible = (edge) => {
         if (!edge || !Array.isArray(edge.faceIds) || edge.faceIds.length === 0) return false;
         for (const faceId of edge.faceIds) {
            if (faceVisibility[faceId]) return true;
         }
         return false;
      };

      const vertexThreshold = Math.max(0.01, modelBoundsRadius * 0.025);
      const edgeThreshold = Math.max(0.01, modelBoundsRadius * 0.02);
      let bestVertex = null;

      for (const vertex of designPickCache.vertices) {
         if (!isVertexVisible(vertex)) continue;
         const hit = distanceRayToPoint(ray.origin, ray.dir, vertex.p);
         if (hit.rayT < 0) continue;
         if (hit.dist > vertexThreshold) continue;
         if (!bestVertex || hit.dist < bestVertex.dist) {
            bestVertex = { type: 'vertex', id: vertex.id, dist: hit.dist };
         }
      }
      if (bestVertex) return bestVertex;

      let bestEdge = null;
      for (const edge of designPickCache.edges) {
         if (!isEdgeVisible(edge)) continue;
         const a = designPickCache.vertices[edge.aId]?.p;
         const b = designPickCache.vertices[edge.bId]?.p;
         if (!a || !b) continue;
         const hit = distanceRayToSegment(ray.origin, ray.dir, a, b);
         if (hit.rayT < 0) continue;
         if (hit.dist > edgeThreshold) continue;
         if (!bestEdge || hit.dist < bestEdge.dist) {
            bestEdge = { type: 'edge', id: edge.id, dist: hit.dist };
         }
      }
      if (bestEdge) return bestEdge;

      let bestFace = null;
      for (const face of designPickCache.faces) {
         if (!face || !faceVisibility[face.id]) continue;
         const hit = intersectRayWithFacePolygon(ray.origin, ray.dir, face, designPickCache.vertices);
         if (!hit) continue;
         if (!bestFace || hit.rayT < bestFace.rayT) {
            bestFace = { type: 'face', id: face.id, dist: 0, rayT: hit.rayT };
         }
      }
      return bestFace;
   }

   function setSelectionFromHover(additiveSelection) {
      if (!designHover) {
         if (!additiveSelection) clearDesignSelection(true);
         return;
      }

      if (!additiveSelection) {
         designSelection.vertexIds = [];
         designSelection.edgeIds = [];
      }

      if (designHover.type === 'vertex') {
         if (!designSelection.vertexIds.includes(designHover.id)) {
            designSelection.vertexIds.push(designHover.id);
         }
      } else if (designHover.type === 'edge') {
         if (!designSelection.edgeIds.includes(designHover.id)) {
            designSelection.edgeIds.push(designHover.id);
         }
      }

      if (!additiveSelection) {
         if (designHover.type === 'vertex') designSelection.edgeIds = [];
         if (designHover.type === 'edge') designSelection.vertexIds = [];
      }
   }

   function computeFacetNormalFromDesignInputs() {
      const gear = Math.max(1, parseInt(designGearEl.value, 10) || 96);
      const rawIndex = parseFloat(designStartIndexEl.value) || 0;
      const angleDeg = Math.max(-90, Math.min(90, parseFloat(designAngleEl.value) || 0));
      const distance = parseFloat(designDistanceEl.value);
      return computeFacetNormalFromParams(gear, rawIndex, angleDeg, distance);
   }

   function buildFacetIndexSetForRow(facet, gearValue) {
      const gear = Math.max(1, parseInt(gearValue, 10) || 96);
      const normalized = normalizeDesignFacet(facet || {}, 0);
      const symmetry = Math.max(1, Math.min(gear, Math.round(Number(normalized.symmetry) || 1)));
      const mirror = Boolean(normalized.mirror);
      const step = gear / symmetry;
      const indexSet = new Set();

      const explicitIndexes = Array.isArray(normalized.indexes)
         ? [...new Set(
            normalized.indexes
               .map((value) => parseInt(value, 10))
               .filter((value) => Number.isFinite(value) && value >= 0)
               .map((value) => (value === 0 ? gear : value))
               .map((value) => wrapDesignGearIndex(value, gear)),
         )]
         : [];

      if (explicitIndexes.length > 0) {
         for (const idx of explicitIndexes) indexSet.add(idx);
      } else {
         const start = wrapDesignGearIndex(normalized.startIndex, gear);
         for (let i = 0; i < symmetry; i++) {
            const off = Math.round(i * step);
            const primary = wrapDesignGearIndex(start + off, gear);
            indexSet.add(primary);
            if (mirror) indexSet.add(mirrorDesignGearIndex(primary, gear));
         }
      }

      const list = [...indexSet];
      if (list.length === 0) list.push(wrapDesignGearIndex(normalized.startIndex, gear));
      return list;
   }

   function getSingleSelectedVertexId() {
      if (!Array.isArray(designSelection.vertexIds) || designSelection.vertexIds.length !== 1) return null;
      if (Array.isArray(designSelection.edgeIds) && designSelection.edgeIds.length > 0) return null;
      const selectedVertexId = Number(designSelection.vertexIds[0]);
      if (!Number.isInteger(selectedVertexId) || selectedVertexId < 0) return null;
      return selectedVertexId;
   }

   function captureSingleSelectedVertexPosition() {
      const selectedVertexId = getSingleSelectedVertexId();
      if (selectedVertexId == null) return null;
      buildDesignPickCacheIfNeeded();
      const vertex = designPickCache.vertices[selectedVertexId];
      if (!vertex || !Array.isArray(vertex.p) || vertex.p.length < 3) return null;
      const x = Number(vertex.p[0]);
      const y = Number(vertex.p[1]);
      const z = Number(vertex.p[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      return [x, y, z];
   }

   function rebindSelectionToVertexPosition(position) {
      if (!Array.isArray(position) || position.length < 3) return false;
      const px = Number(position[0]);
      const py = Number(position[1]);
      const pz = Number(position[2]);
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return false;

      buildDesignPickCacheIfNeeded();
      if (!Array.isArray(designPickCache.vertices) || designPickCache.vertices.length === 0) return false;

      let best = null;
      for (const vertex of designPickCache.vertices) {
         const p = vertex?.p;
         if (!Array.isArray(p) || p.length < 3) continue;
         const dx = Number(p[0]) - px;
         const dy = Number(p[1]) - py;
         const dz = Number(p[2]) - pz;
         if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) continue;
         const d2 = dx * dx + dy * dy + dz * dz;
         if (!best || d2 < best.d2) {
            best = { id: vertex.id, d2 };
         }
      }
      if (!best) return false;

      const snapTol = Math.max(1e-6, modelBoundsRadius * 1e-3);
      if (Math.sqrt(best.d2) > snapTol) return false;

      designSelection.vertexIds = [best.id];
      designSelection.edgeIds = [];
      return true;
   }

   function doesVertexBelongToFacetRow(vertexId, facetIdx) {
      if (!Number.isInteger(vertexId) || vertexId < 0) return false;
      if (!Number.isInteger(facetIdx) || facetIdx < 0) return false;
      buildDesignPickCacheIfNeeded();
      const vertex = designPickCache.vertices[vertexId];
      if (!vertex || !Array.isArray(vertex.faceIds) || vertex.faceIds.length === 0) return false;
      for (const faceId of vertex.faceIds) {
         const face = designPickCache.faces[faceId];
         if (!face) continue;
         const sourceFacetOrder = Number(face.sourceFacetOrder);
         if (Number.isFinite(sourceFacetOrder) && Math.round(sourceFacetOrder) === facetIdx) {
            return true;
         }
      }
      return false;
   }

   function buildFacetWithDistanceFromVertex(facetInput, facetIdx, vertexId) {
      if (!Number.isInteger(vertexId) || vertexId < 0) return null;
      buildDesignPickCacheIfNeeded();
      const vertex = designPickCache.vertices[vertexId];
      if (!vertex || !Array.isArray(vertex.p) || vertex.p.length < 3) return null;

      const facet = normalizeDesignFacet(facetInput, facetIdx);
      const gear = Math.max(1, parseInt(designGearEl.value, 10) || 96);
      const candidateIndexes = buildFacetIndexSetForRow(facet, gear);

      const startIndex = wrapDesignGearIndex(Number(facet.startIndex) || 0, gear);
      const vx = Number(vertex.p[0]) || 0;
      const vy = Number(vertex.p[1]) || 0;
      const vertexTurns = Math.atan2(vx, -vy) / (Math.PI * 2);
      const vertexIndex = wrapDesignGearIndex(Math.round(vertexTurns * gear), gear);
      const circularDistance = (a, b) => {
         const da = Math.abs(wrapDesignGearIndex(a, gear) - wrapDesignGearIndex(b, gear));
         return Math.min(da, gear - da);
      };

      let best = null;
      for (const idx of candidateIndexes) {
         const normal = computeFacetNormalFromParams(gear, idx, facet.angleDeg, facet.distance);
         const requiredDistance = Math.abs(dot3(normal, vertex.p));
         if (!Number.isFinite(requiredDistance)) continue;
         const vertexIndexDistance = circularDistance(idx, vertexIndex);
         const startIndexDistance = circularDistance(idx, startIndex);
         if (!best
            || vertexIndexDistance < best.vertexIndexDistance
            || (vertexIndexDistance === best.vertexIndexDistance && startIndexDistance < best.startIndexDistance)) {
            best = { idx, requiredDistance, vertexIndexDistance, startIndexDistance };
         }
      }
      if (!best) return null;

      const keepNegativeFlat = Math.abs(facet.angleDeg) <= 1e-8 && Number(facet.distance) < 0;
      const nextFacet = normalizeDesignFacet(
         {
            ...facet,
            distance: keepNegativeFlat ? -best.requiredDistance : best.requiredDistance,
            indexDistances: undefined,
         },
         facetIdx,
      );
      return {
         facet: nextFacet,
         best,
      };
   }

   function applyFacetDistanceFromSelectedVertex(facetId) {
      if (!facetId) return false;
      const selectedVertexId = getSingleSelectedVertexId();
      if (selectedVertexId == null) return false;

      const facetIdx = designFacets.findIndex((facet) => facet.id === facetId);
      if (facetIdx < 0) return false;

      const pivoted = buildFacetWithDistanceFromVertex(designFacets[facetIdx], facetIdx, selectedVertexId);
      if (!pivoted) return false;

      const historyBefore = snapshotDesignFacets();
      designFacets[facetIdx] = pivoted.facet;

      renderDesignFacetList();
      scheduleDesignApply();
      commitDesignHistory(historyBefore);
      setDesignStatus(`Set ${pivoted.facet.name || `F${facetIdx + 1}`} distance to meet selected vertex on index ${pivoted.best.idx}`);
      return true;
   }

   function computeDesignIndexFromNormal(normal, gear, fallbackIndex = 0) {
      const x = Number(normal?.[0]) || 0;
      const y = Number(normal?.[1]) || 0;
      if (Math.abs(x) < 1e-8 && Math.abs(y) < 1e-8) {
         return fallbackIndex;
      }
      const turns = Math.atan2(x, -y) / (Math.PI * 2);
      let idx = Math.round(turns * gear);
      idx = ((idx % gear) + gear) % gear;
      return idx;
   }

   function computeStoneCenterXYForSelection() {
      const verts = designPickCache.vertices;
      if (!Array.isArray(verts) || verts.length < 2) return null;

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const vertex of verts) {
         const p = vertex?.p;
         if (!Array.isArray(p) || p.length < 2) continue;
         const x = Number(p[0]);
         const y = Number(p[1]);
         if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
         if (x < minX) minX = x;
         if (x > maxX) maxX = x;
         if (y < minY) minY = y;
         if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
         return null;
      }
      return [(minX + maxX) * 0.5, (minY + maxY) * 0.5];
   }

   function inferIndexFromTwoVertices(v0, v1, centerXY, gear, fallbackIndex) {
      const p0 = [v0[0], v0[1]];
      const p1 = [v1[0], v1[1]];
      const edgeVec = [p1[0] - p0[0], p1[1] - p0[1]];
      const edgeLenSq = edgeVec[0] * edgeVec[0] + edgeVec[1] * edgeVec[1];
      if (edgeLenSq <= 1e-16) return fallbackIndex;

      const toCenter = [centerXY[0] - p0[0], centerXY[1] - p0[1]];
      const t = (toCenter[0] * edgeVec[0] + toCenter[1] * edgeVec[1]) / edgeLenSq;
      const foot = [p0[0] + t * edgeVec[0], p0[1] + t * edgeVec[1]];
      const n = [foot[0] - centerXY[0], foot[1] - centerXY[1]];
      const nLen = Math.hypot(n[0], n[1]);
      if (nLen <= 1e-8) return fallbackIndex;

      return computeDesignIndexFromNormal([n[0], n[1], 0], gear, fallbackIndex);
   }

   function computeStoneWidthForSelection() {
      const verts = designPickCache.vertices;
      if (!Array.isArray(verts) || verts.length < 2) return null;

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const vertex of verts) {
         const p = vertex?.p;
         if (!Array.isArray(p) || p.length < 3) continue;
         const x = Number(p[0]);
         const y = Number(p[1]);
         if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
         if (x < minX) minX = x;
         if (x > maxX) maxX = x;
         if (y < minY) minY = y;
         if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
         return null;
      }
      const xSpan = maxX - minX;
      const ySpan = maxY - minY;
      const width = Math.max(1e-9, Math.min(xSpan, ySpan));
      return Number.isFinite(width) && width > 0 ? width : null;
   }

   function computeStoneMidZForSelection() {
      const verts = designPickCache.vertices;
      if (!Array.isArray(verts) || verts.length < 2) return null;

      const zValues = [];
      for (const vertex of verts) {
         const p = vertex?.p;
         if (!Array.isArray(p) || p.length < 3) continue;
         const z = Number(p[2]);
         if (!Number.isFinite(z)) continue;
         zValues.push(z);
      }
      if (!zValues.length) return null;
      zValues.sort((a, b) => a - b);
      const mid = Math.floor(zValues.length / 2);
      if (zValues.length % 2 === 0) {
         return (zValues[mid - 1] + zValues[mid]) * 0.5;
      }
      return zValues[mid];
   }

   function edgeLengthAndPercent(edge, stoneWidth) {
      if (!edge) return null;
      const a = designPickCache.vertices[edge.aId]?.p;
      const b = designPickCache.vertices[edge.bId]?.p;
      if (!a || !b) return null;
      const length = len3(sub3(b, a));
      if (!Number.isFinite(length)) return null;
      const percent = Number.isFinite(stoneWidth) && stoneWidth > 0
         ? (length / stoneWidth) * 100
         : null;
      const lengthMm = Number.isFinite(designSizeOverlayWidthMm) && Number.isFinite(stoneWidth) && stoneWidth > 0
         ? (length / stoneWidth) * designSizeOverlayWidthMm
         : null;
      return { length, percent, lengthMm };
   }

   function buildSelectionMetric() {
      const result = {
         title: '',
         details: '',
         lines: [],
      };

      const stoneWidth = computeStoneWidthForSelection();

      if (designSelection.edgeIds.length === 1) {
         const edge = designPickCache.edges[designSelection.edgeIds[0]];
         const edgeMetric = edgeLengthAndPercent(edge, stoneWidth);
         if (!edgeMetric) return result;
         result.title = 'Edge';
         if (Number.isFinite(edgeMetric.lengthMm)) {
            result.details = `Length ${edgeMetric.lengthMm.toFixed(3)} mm`;
            result.lines = [
               'Edge',
               `Length: ${edgeMetric.lengthMm.toFixed(3)} mm`,
            ];
         } else {
            result.details = `Length ${edgeMetric.length.toFixed(5)} (mm n/a)`;
            result.lines = [
               'Edge',
               `Length: ${edgeMetric.length.toFixed(5)} (mm n/a)`,
            ];
         }
         return result;
      }

      if (designSelection.vertexIds.length === 1 && designSelection.edgeIds.length === 0) {
         const selectedVertexId = Number(designSelection.vertexIds[0]);
         const vertex = designPickCache.vertices[selectedVertexId];
         if (!vertex) return result;
         const dist = len3(vertex.p);

         const inputFacet = readCreateFacetFromInputs();
         const pivoted = Number.isInteger(selectedVertexId)
            ? buildFacetWithDistanceFromVertex(inputFacet, designFacets.length, selectedVertexId)
            : null;
         const facetNormal = computeFacetNormalFromDesignInputs();
         const fallbackDist = Math.abs(dot3(facetNormal, vertex.p));
         const planeDist = (pivoted?.facet && Number.isFinite(pivoted.facet.distance))
            ? Math.abs(Number(pivoted.facet.distance))
            : fallbackDist;

         if (Number.isFinite(planeDist)) {
            const keepNegativeFlat = Math.abs(Number(inputFacet.angleDeg) || 0) <= 1e-8 && Number(inputFacet.distance) < 0;
            const signedDistance = keepNegativeFlat ? -planeDist : planeDist;
            designDistanceEl.value = signedDistance.toFixed(5);
         }

         result.title = 'Vertex';
         result.details = `Origin dist ${dist.toFixed(5)}, facet dist ${planeDist.toFixed(5)} (autofill)`;
         result.lines = [
            'Vertex',
            `Origin Dist: ${dist.toFixed(5)}`,
            `Facet Dist: ${planeDist.toFixed(5)} (autofill)`,
         ];
         return result;
      }

      if (designSelection.vertexIds.length === 2 && designSelection.edgeIds.length === 0) {
         const v0 = designPickCache.vertices[designSelection.vertexIds[0]]?.p;
         const v1 = designPickCache.vertices[designSelection.vertexIds[1]]?.p;
         if (!v0 || !v1) return result;

         const midpoint = scale3(add3(v0, v1), 0.5);
         const gear = Math.max(1, parseInt(designGearEl.value, 10) || 96);
         const currentIndex = parseFloat(designStartIndexEl.value) || 0;
         const currentAngle = Math.max(-90, Math.min(90, parseFloat(designAngleEl.value) || 0));
         const stoneMidZ = computeStoneMidZForSelection();
         let desiredSign = currentAngle < 0 ? -1 : 1;
         if (Number.isFinite(stoneMidZ)) {
            const zDelta = midpoint[2] - stoneMidZ;
            const zEps = Math.max(1e-6, modelBoundsRadius * 0.03);
            if (zDelta > zEps) desiredSign = 1;
            else if (zDelta < -zEps) desiredSign = -1;
         }

         const solvedAngleDeg = Math.abs(currentAngle) * desiredSign;
         const centerXY = computeStoneCenterXYForSelection();
         const inferredIndex = centerXY
            ? inferIndexFromTwoVertices(v0, v1, centerXY, gear, currentIndex)
            : currentIndex;
         designAngleEl.value = Math.max(-90, Math.min(90, solvedAngleDeg)).toFixed(3);
         designStartIndexEl.value = String(inferredIndex);

         const angleAbsRad = Math.abs(solvedAngleDeg) * Math.PI / 180;
         const azi = ((inferredIndex % gear) / gear) * Math.PI * 2;
         let c = Math.cos(angleAbsRad);
         let s = Math.sin(angleAbsRad);
         if (solvedAngleDeg < 0) {
            c *= -1;
            s *= -1;
         }
         const solvedNormal = normalize3([s * Math.sin(azi), -s * Math.cos(azi), c]);
         const planeDist = Math.abs(0.5 * (dot3(solvedNormal, v0) + dot3(solvedNormal, v1)));
         designDistanceEl.value = Math.max(0, planeDist).toFixed(5);

         const edgeLength = len3(sub3(v1, v0));
         const edgeMm = Number.isFinite(designSizeOverlayWidthMm) && Number.isFinite(stoneWidth) && stoneWidth > 0
            ? (edgeLength / stoneWidth) * designSizeOverlayWidthMm
            : null;

         result.title = '2 Vertices';
         if (Number.isFinite(edgeMm)) {
            result.details = `Span ${edgeMm.toFixed(3)} mm, index ${inferredIndex}, dist ${planeDist.toFixed(5)} (autofill)`;
         } else {
            result.details = `Span ${edgeLength.toFixed(5)} (mm n/a), index ${inferredIndex}, dist ${planeDist.toFixed(5)} (autofill)`;
         }
         return result;
      }

      if (designSelection.vertexIds.length === 3 && designSelection.edgeIds.length === 0) {
         const v0 = designPickCache.vertices[designSelection.vertexIds[0]]?.p;
         const v1 = designPickCache.vertices[designSelection.vertexIds[1]]?.p;
         const v2 = designPickCache.vertices[designSelection.vertexIds[2]]?.p;
         if (!v0 || !v1 || !v2) return result;

         const e01 = sub3(v1, v0);
         const e02 = sub3(v2, v0);
         let planeNormal = normalize3(cross3(e01, e02));
         if (len3(planeNormal) <= 1e-8) return result;

         const midpoint = scale3(add3(add3(v0, v1), v2), 1 / 3);
         const stoneMidZ = computeStoneMidZForSelection();
         const currentAngle = parseFloat(designAngleEl.value);
         const defaultSign = Number.isFinite(currentAngle) && currentAngle < 0 ? -1 : 1;
         let desiredSign = defaultSign;
         if (Number.isFinite(stoneMidZ)) {
            const zDelta = midpoint[2] - stoneMidZ;
            const zEps = Math.max(1e-6, modelBoundsRadius * 0.03);
            if (zDelta > zEps) desiredSign = 1;
            else if (zDelta < -zEps) desiredSign = -1;
         }
         if ((planeNormal[2] >= 0 ? 1 : -1) !== desiredSign) {
            planeNormal = scale3(planeNormal, -1);
         }

         const gear = Math.max(1, parseInt(designGearEl.value, 10) || 96);
         const currentIndex = parseFloat(designStartIndexEl.value) || 0;
         const inferredIndex = computeDesignIndexFromNormal(planeNormal, gear, currentIndex);
         const tierAngle = computeSignedFacetAngleDeg(planeNormal);
         const planeDist = Math.abs(dot3(planeNormal, midpoint));

         designAngleEl.value = Math.max(-90, Math.min(90, tierAngle)).toFixed(3);
         designStartIndexEl.value = String(inferredIndex);
         designDistanceEl.value = Math.max(0, planeDist).toFixed(5);

         result.title = '3 Vertices';
         result.details = `Plane fit: index ${inferredIndex}, tier ${tierAngle.toFixed(3)}°, dist ${planeDist.toFixed(5)} (autofill)`;
         return result;
      }

      if (designSelection.edgeIds.length === 2) {
         const edgeA = designPickCache.edges[designSelection.edgeIds[0]];
         const edgeB = designPickCache.edges[designSelection.edgeIds[1]];
         if (!edgeA || !edgeB) return result;
         const edgeAMetric = edgeLengthAndPercent(edgeA, stoneWidth);
         const edgeBMetric = edgeLengthAndPercent(edgeB, stoneWidth);
         const a0 = designPickCache.vertices[edgeA.aId]?.p;
         const a1 = designPickCache.vertices[edgeA.bId]?.p;
         const b0 = designPickCache.vertices[edgeB.aId]?.p;
         const b1 = designPickCache.vertices[edgeB.bId]?.p;
         if (!a0 || !a1 || !b0 || !b1) return result;

         const dirA = normalize3(sub3(a1, a0));
         const dirB = normalize3(sub3(b1, b0));
         const gear = Math.max(1, parseInt(designGearEl.value, 10) || 96);
         const idx = parseFloat(designStartIndexEl.value) || 0;
         const azi = ((idx % gear) / gear) * Math.PI * 2;
         const indexAxis = normalize3([Math.sin(azi), -Math.cos(azi), 0]);

         const projectToIndexPlane = (v) => {
            const dv = dot3(v, indexAxis);
            return normalize3(sub3(v, scale3(indexAxis, dv)));
         };

         const projA = projectToIndexPlane(dirA);
         const projB = projectToIndexPlane(dirB);
         const projDot = Math.max(-1, Math.min(1, dot3(projA, projB)));
         const projectedEdgeAngleDeg = Math.acos(projDot) * 180 / Math.PI;

         let planeNormal = normalize3(cross3(projA, projB));
         if (len3(planeNormal) <= 1e-8) {
            planeNormal = normalize3(cross3(dirA, dirB));
         }

         const midA = scale3(add3(a0, a1), 0.5);
         const midB = scale3(add3(b0, b1), 0.5);
         const refPoint = scale3(add3(midA, midB), 0.5);
         const planeDist = Math.abs(dot3(planeNormal, refPoint));
         const tierAngle = computeSignedFacetAngleDeg(planeNormal);

         designAngleEl.value = Math.max(-90, Math.min(90, tierAngle)).toFixed(3);
         designDistanceEl.value = Math.max(0, planeDist).toFixed(5);

         result.title = '2 Edges';
         const lengthsText = (edgeAMetric && edgeBMetric && Number.isFinite(edgeAMetric.lengthMm) && Number.isFinite(edgeBMetric.lengthMm))
            ? `e1 ${edgeAMetric.lengthMm.toFixed(3)} mm, e2 ${edgeBMetric.lengthMm.toFixed(3)} mm`
            : (edgeAMetric && edgeBMetric
               ? `e1 ${edgeAMetric.length.toFixed(5)} (mm n/a), e2 ${edgeBMetric.length.toFixed(5)} (mm n/a)`
               : '');
         const lengthsPrefix = lengthsText ? `${lengthsText}; ` : '';
         result.details = `${lengthsPrefix}Proj angle ${projectedEdgeAngleDeg.toFixed(2)}°, tier ${tierAngle.toFixed(3)}°, dist ${planeDist.toFixed(5)} (autofill)`;
         return result;
      }

      if (designSelection.edgeIds.length > 2) {
         const edgeMetrics = designSelection.edgeIds
            .map((edgeId) => edgeLengthAndPercent(designPickCache.edges[edgeId], stoneWidth))
            .filter((metric) => metric && Number.isFinite(metric.length));
         if (!edgeMetrics.length) return result;

         const lengths = edgeMetrics.map((m) => m.length);
         const minLen = Math.min(...lengths);
         const maxLen = Math.max(...lengths);
         const avgLen = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;

         result.title = `${edgeMetrics.length} Edges`;
         if (edgeMetrics.every((m) => Number.isFinite(m.lengthMm))) {
            const mmLengths = edgeMetrics.map((m) => m.lengthMm);
            const minMm = Math.min(...mmLengths);
            const maxMm = Math.max(...mmLengths);
            const avgMm = mmLengths.reduce((sum, value) => sum + value, 0) / mmLengths.length;
            result.details = `Avg ${avgMm.toFixed(3)} mm (min ${minMm.toFixed(3)} mm, max ${maxMm.toFixed(3)} mm)`;
         } else {
            result.details = `Avg ${avgLen.toFixed(5)} (mm n/a; min ${minLen.toFixed(5)}, max ${maxLen.toFixed(5)})`;
         }
         return result;
      }

      return result;
   }

   function buildHoveredFaceTooltipLines() {
      if (designHover?.type !== 'face') return [];
      const face = designPickCache.faces[designHover.id];
      if (!face) return [];

      const sourceFacetOrder = Number.isFinite(Number(face.sourceFacetOrder))
         ? Math.max(0, Math.round(Number(face.sourceFacetOrder)))
         : null;

      const designFacet = sourceFacetOrder != null ? designFacets[sourceFacetOrder] : null;
      const stoneFacet = sourceFacetOrder != null ? currentStone?.facets?.[sourceFacetOrder] : null;
      const facet = designFacet ?? stoneFacet ?? null;

      const parseFacetIndexList = (value) => {
         if (Array.isArray(value)) {
            return [...new Set(
               value
                  .map((entry) => Number(entry))
                  .filter((entry) => Number.isFinite(entry))
                  .map((entry) => wrapDesignGearIndex(Math.round(entry), Math.max(1, parseInt(designGearEl.value, 10) || 96))),
            )];
         }
         if (typeof value !== 'string') return [];
         return [...new Set(
            value
               .split(/[^0-9]+/)
               .map((entry) => Number(entry))
               .filter((entry) => Number.isFinite(entry) && entry > 0)
               .map((entry) => wrapDesignGearIndex(Math.round(entry), Math.max(1, parseInt(designGearEl.value, 10) || 96))),
         )];
      };

      const allowedIndexes = parseFacetIndexList(facet?.indexes);
      const faceGearIndex = Number.isFinite(Number(face.sourceGearIndex))
         ? wrapDesignGearIndex(Number(face.sourceGearIndex), Math.max(1, parseInt(designGearEl.value, 10) || 96))
         : null;
      let displayIndex = faceGearIndex;
      if (allowedIndexes.length) {
         displayIndex = (faceGearIndex != null && allowedIndexes.includes(faceGearIndex))
            ? faceGearIndex
            : allowedIndexes[0];
      }
      if (displayIndex == null) {
         displayIndex = sourceFacetOrder ?? Math.max(0, Math.round(Number(face.id) || 0));
      }

      const rawName = String(facet?.name || '').trim();
      const name = rawName || `Facet #${displayIndex}`;

      return [
         'Facet Hover',
         `Facet Index: ${displayIndex}`,
         `Name: ${name}`,
      ];
   }

   function wrapTooltipLine(text, maxWidth) {
      const normalized = String(text || '').trim();
      if (!normalized) return [];
      if (selectionOverlayCtx.measureText(normalized).width <= maxWidth) return [normalized];

      const words = normalized.split(/\s+/).filter(Boolean);
      if (!words.length) return [normalized];

      const lines = [];
      let current = words[0];
      for (let i = 1; i < words.length; i++) {
         const next = `${current} ${words[i]}`;
         if (selectionOverlayCtx.measureText(next).width <= maxWidth) {
            current = next;
         } else {
            lines.push(current);
            current = words[i];
         }
      }
      if (current) lines.push(current);
      return lines;
   }

   function resolveTooltipLines() {
      const metric = buildSelectionMetric();
      if (Array.isArray(metric.lines) && metric.lines.length) return metric.lines;
      if (metric.title && metric.details) return [metric.title, metric.details];
      return buildHoveredFaceTooltipLines();
   }

   function modelPointToScreen(point) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const p = vec4.fromValues(point[0], point[1], point[2], 1);
      vec4.transformMat4(p, p, modelMat);
      vec4.transformMat4(p, p, viewMat);
      vec4.transformMat4(p, p, projMat);
      if (Math.abs(p[3]) <= 1e-8) return null;
      const ndcX = p[0] / p[3];
      const ndcY = p[1] / p[3];
      const ndcZ = p[2] / p[3];
      if (ndcZ < -1.2 || ndcZ > 1.2) return null;
      return {
         x: rect.left + ((ndcX + 1) * 0.5) * rect.width,
         y: rect.top + ((1 - (ndcY + 1) * 0.5) * rect.height),
      };
   }

   function drawDesignGearHalo() {
      if (currentGemTab !== 'design') return;
      const halo = getDesignHaloSpec();
      if (!halo) return;

      const gearInput = parseInt(designGearEl.value, 10);
      const sourceGear = parseInt(currentStone?.sourceGear, 10);
      const gear = Number.isFinite(gearInput) && gearInput > 0
         ? gearInput
         : (Number.isFinite(sourceGear) && sourceGear > 0 ? sourceGear : 96);

      const ringSamples = Math.max(96, gear * 3);
      selectionOverlayCtx.save();

      // Soft glow under halo line.
      selectionOverlayCtx.lineWidth = 5;
      selectionOverlayCtx.strokeStyle = 'rgba(120, 220, 255, 0.12)';
      selectionOverlayCtx.beginPath();
      let started = false;
      for (let i = 0; i <= ringSamples; i++) {
         const angle = (i / ringSamples) * Math.PI * 2;
         const world = [
            halo.radius * Math.sin(angle),
            -halo.radius * Math.cos(angle),
            halo.z,
         ];
         const screen = modelPointToScreen(world);
         if (!screen) {
            started = false;
            continue;
         }
         if (!started) {
            selectionOverlayCtx.moveTo(screen.x, screen.y);
            started = true;
         } else {
            selectionOverlayCtx.lineTo(screen.x, screen.y);
         }
      }
      selectionOverlayCtx.stroke();

      // Main halo line.
      selectionOverlayCtx.lineWidth = 1.5;
      selectionOverlayCtx.strokeStyle = 'rgba(120, 220, 255, 0.48)';
      selectionOverlayCtx.beginPath();
      started = false;
      for (let i = 0; i <= ringSamples; i++) {
         const angle = (i / ringSamples) * Math.PI * 2;
         const world = [
            halo.radius * Math.sin(angle),
            -halo.radius * Math.cos(angle),
            halo.z,
         ];
         const screen = modelPointToScreen(world);
         if (!screen) {
            started = false;
            continue;
         }
         if (!started) {
            selectionOverlayCtx.moveTo(screen.x, screen.y);
            started = true;
         } else {
            selectionOverlayCtx.lineTo(screen.x, screen.y);
         }
      }
      selectionOverlayCtx.stroke();

      const labelStep = computeGearLabelStep(gear);
      const labelRadius = halo.radius * 1.06;
      selectionOverlayCtx.font = '11px system-ui, sans-serif';
      selectionOverlayCtx.textAlign = 'center';
      selectionOverlayCtx.textBaseline = 'middle';
      selectionOverlayCtx.lineWidth = 3;
      selectionOverlayCtx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
      selectionOverlayCtx.fillStyle = 'rgba(205, 242, 255, 0.97)';

      for (let i = 0; i < gear; i += labelStep) {
         const angle = (i / gear) * Math.PI * 2;
         const world = [
            labelRadius * Math.sin(angle),
            -labelRadius * Math.cos(angle),
            halo.z,
         ];
         const screen = modelPointToScreen(world);
         if (!screen) continue;
         const label = String(i === 0 ? gear : i);
         selectionOverlayCtx.strokeText(label, screen.x, screen.y);
         selectionOverlayCtx.fillText(label, screen.x, screen.y);
      }

      selectionOverlayCtx.restore();
   }

   function drawDesignSelectionOverlay() {
      selectionOverlayCtx.clearRect(0, 0, selectionOverlayCssWidth, selectionOverlayCssHeight);
      const isDesignTab = currentGemTab === 'design';
      const showAnalyseFlatEdges = currentGemTab === 'controls' && ui.lightMode === 4;
      const showCutsEdges = currentGemTab === 'cuts';
      if (!isDesignTab && !showAnalyseFlatEdges && !showCutsEdges) return;

      buildDesignPickCacheIfNeeded();
      if (isDesignTab) drawDesignGearHalo();

      const drawVertex = (vertexId, radius) => {
         const vertex = designPickCache.vertices[vertexId];
         if (!vertex) return;
         const screen = modelPointToScreen(vertex.p);
         if (!screen) return;
         selectionOverlayCtx.beginPath();
         selectionOverlayCtx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
         selectionOverlayCtx.fillStyle = 'rgb(40,255,120)';
         selectionOverlayCtx.fill();
         selectionOverlayCtx.strokeStyle = 'rgba(20,160,80,0.95)';
         selectionOverlayCtx.lineWidth = 1.5;
         selectionOverlayCtx.stroke();
      };

      const drawEdge = (edgeId, width, color = '40,255,120') => {
         const edge = designPickCache.edges[edgeId];
         if (!edge) return;
         const a = designPickCache.vertices[edge.aId]?.p;
         const b = designPickCache.vertices[edge.bId]?.p;
         if (!a || !b) return;
         const sa = modelPointToScreen(a);
         const sb = modelPointToScreen(b);
         if (!sa || !sb) return;
         selectionOverlayCtx.beginPath();
         selectionOverlayCtx.moveTo(sa.x, sa.y);
         selectionOverlayCtx.lineTo(sb.x, sb.y);
         selectionOverlayCtx.strokeStyle = `rgb(${color})`;
         selectionOverlayCtx.lineWidth = width;
         selectionOverlayCtx.stroke();
      };

      const cameraModel4 = vec4.fromValues(cameraPos[0], cameraPos[1], cameraPos[2], 1);
      vec4.transformMat4(cameraModel4, cameraModel4, invModelMat);
      if (Math.abs(cameraModel4[3]) > 1e-8) {
         const cameraModel = [
            cameraModel4[0] / cameraModel4[3],
            cameraModel4[1] / cameraModel4[3],
            cameraModel4[2] / cameraModel4[3],
         ];
         const faceVisibility = designPickCache.faces.map((face) => {
            if (!face || !Array.isArray(face.normal) || len3(face.normal) <= 1e-8) return false;
            const toCamera = sub3(cameraModel, face.center);
            return dot3(face.normal, toCamera) > 1e-8;
         });
         const selectedEdgeIds = new Set(designSelection.edgeIds);
         for (const edge of designPickCache.edges) {
            if (!edge || selectedEdgeIds.has(edge.id)) continue;
            const isVisible = Array.isArray(edge.faceIds) && edge.faceIds.some((faceId) => faceVisibility[faceId]);
            if (!isVisible) continue;
            drawEdge(edge.id, 1, '0,0,0');
         }
      }

      if (!isDesignTab) return;

      for (const vertexId of designSelection.vertexIds) drawVertex(vertexId, 6);
      for (const edgeId of designSelection.edgeIds) drawEdge(edgeId, 3);

      if (designHover?.type === 'vertex') drawVertex(designHover.id, 4);
      if (designHover?.type === 'edge') drawEdge(designHover.id, 2);

      const rawLines = resolveTooltipLines();
      if (!Array.isArray(rawLines) || !rawLines.length) return;

      const x = Math.max(16, Math.min(window.innerWidth - 16, designPointerClientX + 14));
      const y = Math.max(16, Math.min(window.innerHeight - 16, designPointerClientY + 14));

      selectionOverlayCtx.font = '12px system-ui, sans-serif';
      const maxTextWidth = Math.max(150, Math.min(360, selectionOverlayCssWidth * 0.42));
      const lines = [];
      for (const line of rawLines) {
         lines.push(...wrapTooltipLine(line, maxTextWidth));
      }
      if (!lines.length) return;

      let textWidth = 0;
      for (const line of lines) {
         const width = selectionOverlayCtx.measureText(line).width;
         if (width > textWidth) textWidth = width;
      }

      const pad = 8;
      const boxW = textWidth + pad * 2;
      const lineHeight = 16;
      const boxH = pad * 2 + lines.length * lineHeight;
      const bx = Math.min(Math.max(8, selectionOverlayCssWidth - boxW - 8), x);
      const by = Math.min(Math.max(8, selectionOverlayCssHeight - boxH - 8), y);

      const cornerRadius = 8;
      const roundedRectPath = new Path2D();
      roundedRectPath.moveTo(bx + cornerRadius, by);
      roundedRectPath.lineTo(bx + boxW - cornerRadius, by);
      roundedRectPath.arcTo(bx + boxW, by, bx + boxW, by + cornerRadius, cornerRadius);
      roundedRectPath.lineTo(bx + boxW, by + boxH - cornerRadius);
      roundedRectPath.arcTo(bx + boxW, by + boxH, bx + boxW - cornerRadius, by + boxH, cornerRadius);
      roundedRectPath.lineTo(bx + cornerRadius, by + boxH);
      roundedRectPath.arcTo(bx, by + boxH, bx, by + boxH - cornerRadius, cornerRadius);
      roundedRectPath.lineTo(bx, by + cornerRadius);
      roundedRectPath.arcTo(bx, by, bx + cornerRadius, by, cornerRadius);
      roundedRectPath.closePath();

      selectionOverlayCtx.fillStyle = 'rgba(0,0,0,0.74)';
      selectionOverlayCtx.fill(roundedRectPath);
      selectionOverlayCtx.strokeStyle = 'rgba(40,255,120,0.75)';
      selectionOverlayCtx.lineWidth = 1;
      selectionOverlayCtx.stroke(roundedRectPath);
      selectionOverlayCtx.fillStyle = 'rgba(210,255,225,0.95)';
      selectionOverlayCtx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
         selectionOverlayCtx.fillText(lines[i], bx + pad, by + pad + i * lineHeight);
      }
   }

   function packUniformData(out, modelMatrix, projectionMatrix, time, lightMode, graphMode, flatShading) {
      out.set(modelMatrix, 0);
      out.set(viewMat, 16);
      out.set(projectionMatrix, 32);

      out[48] = cameraPos[0];
      out[49] = cameraPos[1];
      out[50] = cameraPos[2];
      out[51] = ui.clarity;

      out[52] = time;
      out[53] = ui.ri;
      out[54] = ui.cod;
      out[55] = lightMode;

      out[56] = ui.axisAColor[0];
      out[57] = ui.axisAColor[1];
      out[58] = ui.axisAColor[2];
      out[59] = graphMode;

      out[60] = ui.axisBColor[0];
      out[61] = ui.axisBColor[1];
      out[62] = ui.axisBColor[2];
      out[63] = ui.exitStrength;

      // 256: axisCColor vec3, 268: flatShading
      out[64] = ui.axisCColor[0];
      out[65] = ui.axisCColor[1];
      out[66] = ui.axisCColor[2];
      out[67] = flatShading;

      // 272: exitHighlight vec3, 284: convexFacetMode
      out[68] = ui.exitHighlight[0];
      out[69] = ui.exitHighlight[1];
      out[70] = ui.exitHighlight[2];
      out[71] = ui.convexFacetMode;

      // 288: headShadowColor vec3, 300: padding
      out[72] = ui.headShadowColor[0];
      out[73] = ui.headShadowColor[1];
      out[74] = ui.headShadowColor[2];
      out[75] = 0.0;

      // Compose local-space orientation quaternion q = qz * qy * qx from slider angles.
      let xRad = ui.axisTiltXDeg * Math.PI / 180.0;
      let yRad = ui.axisTiltYDeg * Math.PI / 180.0;
      let zRad = ui.axisTiltZDeg * Math.PI / 180.0;
      let hx = 0.5 * xRad;
      let hy = 0.5 * yRad;
      let hz = 0.5 * zRad;
      let sx = Math.sin(hx);
      let cx = Math.cos(hx);
      let sy = Math.sin(hy);
      let cy = Math.cos(hy);
      let sz = Math.sin(hz);
      let cz = Math.cos(hz);
      let qx = sx * cy * cz - cx * sy * sz;
      let qy = cx * sy * cz + sx * cy * sz;
      let qz = cx * cy * sz - sx * sy * cz;
      let qw = cx * cy * cz + sx * sy * sz;
      let qLenInv = 1.0 / Math.hypot(qx, qy, qz, qw);
      // 304: axisQuat vec4
      out[76] = qx * qLenInv;
      out[77] = qy * qLenInv;
      out[78] = qz * qLenInv;
      out[79] = qw * qLenInv;

   }

   function writeUniformsToBuffer(buffer, modelMatrix, projectionMatrix, time, lightMode, graphMode = 0.0) {
      packUniformData(uniformScratch, modelMatrix, projectionMatrix, time, lightMode, graphMode, 0.0);
      device.queue.writeBuffer(buffer, 0, uniformScratch);
   }

   function drawGraph(seriesList) {
      latestGraphSeries = seriesList;
      if (!graphSvgEl) return;
      graphSvgEl.setAttribute('viewBox', `0 0 ${graphCanvasWidth} ${graphCanvasHeight}`);
      graphSvgEl.innerHTML = buildGraphSvgInner(seriesList, graphCanvasWidth, graphCanvasHeight, GRAPH_THEME_DARK);
   }

   async function sampleGraphSweep(runId) {
      if (!renderBundle || runId !== graphRequestId) return null;
      const graphSweepStartMs = performance.now();

      // Graph renders at the currently selected focal length.
      const SENSOR_HALF = 5 * Math.tan(Math.PI / 8) * STONE_MARGIN_SCALE; // margin scales apparent framing
      const graphCamDist = ui.focalLength / 10;
      const graphFovY = 2 * Math.atan(SENSOR_HALF / graphCamDist);
      mat4.perspective(graphProjMat, graphFovY, GRAPH_SAMPLE_SIZE / GRAPH_SAMPLE_SIZE, 0.1, 200.0);

      // Temporarily set globals so writeUniformsToBuffer sends the correct view
      const savedViewMat = new Float32Array(viewMat);
      const savedCamPos = [cameraPos[0], cameraPos[1], cameraPos[2]];
      mat4.lookAt(viewMat, [0, 0, graphCamDist], [0, 0, 0], [0, 1, 0]);
      cameraPos[0] = 0; cameraPos[1] = 0; cameraPos[2] = graphCamDist;

      const { graphBindGroups, vertexBuffer, triCount } = renderBundle;
      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(graphReduceBuffer);

      const pass = encoder.beginRenderPass({
         colorAttachments: [{
            view: graphColorTexture.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
         }],
         depthStencilAttachment: {
            view: graphDepthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
         },
      });
      pass.setPipeline(graphPipeline);
      pass.setVertexBuffer(0, vertexBuffer);

      for (let modeIndex = 0; modeIndex < GRAPH_MODE_COUNT; modeIndex++) {
         const lightMode = GRAPH_MODES[modeIndex].mode;
         for (let tiltIndex = 0; tiltIndex < GRAPH_TILT_COUNT; tiltIndex++) {
            if (runId !== graphRequestId) {
               pass.end();
               viewMat.set(savedViewMat);
               cameraPos[0] = savedCamPos[0]; cameraPos[1] = savedCamPos[1]; cameraPos[2] = savedCamPos[2];
               return null;
            }

            const tiltDeg = GRAPH_TILT_VALUES[tiltIndex];
            const tileIndex = modeIndex * GRAPH_TILT_COUNT + tiltIndex;
            mat4.identity(graphModelMat);
            mat4.rotateX(graphModelMat, graphModelMat, tiltDeg * Math.PI / 180.0);
            writeUniformsToBuffer(graphUniformBuffers[tileIndex], graphModelMat, graphProjMat, 0, lightMode, 1.0);

            pass.setViewport(
               tiltIndex * GRAPH_SAMPLE_SIZE,
               modeIndex * GRAPH_SAMPLE_SIZE,
               GRAPH_SAMPLE_SIZE,
               GRAPH_SAMPLE_SIZE,
               0,
               1,
            );
            pass.setScissorRect(
               tiltIndex * GRAPH_SAMPLE_SIZE,
               modeIndex * GRAPH_SAMPLE_SIZE,
               GRAPH_SAMPLE_SIZE,
               GRAPH_SAMPLE_SIZE,
            );
            pass.setBindGroup(0, graphBindGroups[tileIndex]);
            pass.draw(triCount * 3);
         }
      }
      pass.end();

      const reducePass = encoder.beginComputePass();
      reducePass.setPipeline(graphReducePipeline);
      reducePass.setBindGroup(0, graphReduceBindGroup);
      reducePass.dispatchWorkgroups(
         Math.ceil(GRAPH_ATLAS_WIDTH / 8),
         Math.ceil(GRAPH_ATLAS_HEIGHT / 8),
         1,
      );
      reducePass.end();

      encoder.copyBufferToBuffer(
         graphReduceBuffer,
         0,
         graphReduceReadbackBuffer,
         0,
         GRAPH_TILE_COUNT * GRAPH_REDUCE_CELL_U32_COUNT * 4,
      );

      device.queue.submit([encoder.finish()]);
      await graphReduceReadbackBuffer.mapAsync(GPUMapMode.READ);
      const reduced = new Uint32Array(graphReduceReadbackBuffer.getMappedRange());

      const seriesList = GRAPH_MODES.flatMap((mode, modeIndex) => {
         const points = GRAPH_TILT_VALUES.map((tilt, tiltIndex) => {
            const tileIndex = modeIndex * GRAPH_TILT_COUNT + tiltIndex;
            const base = tileIndex * GRAPH_REDUCE_CELL_U32_COUNT;
            const valueSum = reduced[base + 0];
            const count = reduced[base + 1];
            const value = count > 0
               ? (valueSum / (count * GRAPH_REDUCE_SUM_SCALE)) * GRAPH_VALUE_SCALE
               : 0;
            return { tilt, value };
         });
         const output = [{ label: mode.label, color: mode.color, points }];
         if (modelHasTableFacet) {
            const tablePoints = GRAPH_TILT_VALUES.map((tilt, tiltIndex) => {
               const tileIndex = modeIndex * GRAPH_TILT_COUNT + tiltIndex;
               const base = tileIndex * GRAPH_REDUCE_CELL_U32_COUNT;
               const tableValueSum = reduced[base + 2];
               const tableCount = reduced[base + 3];
               const value = tableCount > 0
                  ? (tableValueSum / (tableCount * GRAPH_REDUCE_SUM_SCALE)) * GRAPH_VALUE_SCALE
                  : 0;
               return { tilt, value };
            });
            output.push({ label: `${mode.label} table`, color: mode.color, points: tablePoints, dashed: true });
         }
         return output;
      });

      graphReduceReadbackBuffer.unmap();

      const graphSweepMs = performance.now() - graphSweepStartMs;
      graphSweepMsSmoothed = graphSweepMsSmoothed * 0.8 + graphSweepMs * 0.2;

      // Restore main-camera globals
      viewMat.set(savedViewMat);
      cameraPos[0] = savedCamPos[0]; cameraPos[1] = savedCamPos[1]; cameraPos[2] = savedCamPos[2];

      return seriesList;
   }

   async function recomputeGraph(runId) {
      if (!renderBundle) return;

      const seriesList = await sampleGraphSweep(runId);
      if (!seriesList) return;

      if (runId !== graphRequestId) return;
      drawGraph(seriesList);
      setGraphStatus(`Updated for RI ${ui.ri.toFixed(3)}, COD ${ui.cod.toFixed(3)} · sweep ${GRAPH_TILT_MIN}°…${GRAPH_TILT_MAX}°`);
   }

   function scheduleGraphUpdate(reason = 'parameter change') {
      if (!renderBundle) return;
      graphRequestId++;
      const runId = graphRequestId;
      clearTimeout(graphUpdateTimer);
      setGraphStatus(`Updating graph… (${reason})`);
      graphUpdateTimer = setTimeout(async () => {
         if (graphBusy) {
            graphNeedsRerun = true;
            return;
         }
         graphBusy = true;
         try {
            await recomputeGraph(runId);
         } finally {
            graphBusy = false;
            if (graphNeedsRerun) {
               graphNeedsRerun = false;
               scheduleGraphUpdate('latest values');
            }
         }
      }, 150);
   }

   const orientationFrameCache = new Map();
   const orientationFrameCacheBytes = new Map();
   let orientationCacheTotalBytes = 0;
   let effectiveRenderRotX = 0;
   let effectiveRenderRotY = 0;
   const prewarmModelMat = mat4.create();
   let tiltCyclePrevPhase = null;
   let tiltCycleFrameCount = 0;
   let tiltCycleAccumSec = 0;
   let tiltCycleCompletedCount = 0;
   let tiltCycleAvgFps = 0;
   let tiltPreRenderRequested = false;
   let tiltPreRenderReady = false;
   let tiltPreRenderQueue = [];
   let tiltPreRenderIndex = 0;
   let tiltPreRenderBaseRotX = null;
   let tiltPreRenderBaseRotY = null;
   let prewarmOverlayEl = null;
   let prewarmOverlayLabelEl = null;
   let prewarmOverlayBarFillEl = null;
   let prewarmOverlayLastUiUpdateMs = 0;
   let prewarmOverlayLastDone = -1;
   let prewarmOverlayLastTotal = -1;
   let prewarmYieldFlip = false;

   function ensurePrewarmOverlayElements() {
      if (prewarmOverlayEl) return;
      prewarmOverlayEl = document.createElement('div');
      Object.assign(prewarmOverlayEl.style, {
         position: 'fixed',
         left: isMobileDevice ? '12px' : '16px',
         top: 'calc(env(safe-area-inset-top, 0px) + 16px)',
         width: '148px',
         padding: '7px 8px',
         borderRadius: '6px',
         background: 'rgba(0,0,0,0.62)',
         color: '#e8e8e8',
         font: '11px/1.2 system-ui, sans-serif',
         zIndex: '260',
         pointerEvents: 'none',
         display: 'none',
      });

      prewarmOverlayLabelEl = document.createElement('div');
      prewarmOverlayLabelEl.textContent = 'Prewarming';
      prewarmOverlayLabelEl.style.marginBottom = '5px';
      prewarmOverlayEl.appendChild(prewarmOverlayLabelEl);

      const barBgEl = document.createElement('div');
      Object.assign(barBgEl.style, {
         width: '100%',
         height: '6px',
         borderRadius: '4px',
         background: 'rgba(255,255,255,0.14)',
         overflow: 'hidden',
      });
      prewarmOverlayBarFillEl = document.createElement('div');
      Object.assign(prewarmOverlayBarFillEl.style, {
         width: '0%',
         height: '100%',
         borderRadius: '4px',
         background: '#7eb8f7',
      });
      barBgEl.appendChild(prewarmOverlayBarFillEl);
      prewarmOverlayEl.appendChild(barBgEl);
      document.body.appendChild(prewarmOverlayEl);
   }

   function updatePrewarmOverlay(force = false) {
      ensurePrewarmOverlayElements();
      if (!prewarmOverlayEl || !prewarmOverlayLabelEl || !prewarmOverlayBarFillEl) return;

      const active = tiltPreRenderRequested && !tiltPreRenderReady;
      if (!active) {
         prewarmOverlayEl.style.display = 'none';
         prewarmOverlayLastDone = -1;
         prewarmOverlayLastTotal = -1;
         return;
      }

      const total = Math.max(1, tiltPreRenderQueue.length);
      const done = Math.min(tiltPreRenderIndex, total);
      const nowMs = performance.now();
      const sameProgress = done === prewarmOverlayLastDone && total === prewarmOverlayLastTotal;
      if (!force && sameProgress && (nowMs - prewarmOverlayLastUiUpdateMs) < 100) {
         return;
      }

      const pct = (done / total) * 100;
      prewarmOverlayLabelEl.textContent = `Prewarming ${done}/${total} (${pct.toFixed(0)}%)`;
      prewarmOverlayBarFillEl.style.width = `${pct.toFixed(1)}%`;
      prewarmOverlayLastDone = done;
      prewarmOverlayLastTotal = total;
      prewarmOverlayLastUiUpdateMs = nowMs;

      if (fpsEl && perfStatsVisible) {
         prewarmOverlayEl.style.top = `calc(env(safe-area-inset-top, 0px) + ${16 + fpsEl.offsetHeight + 8}px)`;
      } else {
         prewarmOverlayEl.style.top = 'calc(env(safe-area-inset-top, 0px) + 16px)';
      }
      prewarmOverlayEl.style.display = 'block';
   }

   function invalidateOrientationCache() {
      for (const texture of orientationFrameCache.values()) {
         texture.destroy();
      }
      orientationFrameCache.clear();
      orientationFrameCacheBytes.clear();
      orientationCacheTotalBytes = 0;
      tiltPreRenderRequested = false;
      tiltPreRenderReady = false;
      tiltPreRenderQueue = [];
      tiltPreRenderIndex = 0;
      tiltPreRenderBaseRotX = null;
      tiltPreRenderBaseRotY = null;
      updatePrewarmOverlay();
   }

   function orientationCacheKey(rotX, rotY) {
      const xDeg = rotX * 180.0 / Math.PI;
      const yDeg = rotY * 180.0 / Math.PI;
      const qx = Math.round(xDeg / ORIENTATION_CACHE_ANGLE_STEP_DEG) * ORIENTATION_CACHE_ANGLE_STEP_DEG;
      const qy = Math.round(yDeg / ORIENTATION_CACHE_ANGLE_STEP_DEG) * ORIENTATION_CACHE_ANGLE_STEP_DEG;
      return `${qx.toFixed(2)}:${qy.toFixed(2)}`;
   }

   function quantizeOrientationAngle(angleRad) {
      return Math.round(angleRad / ORIENTATION_CACHE_ANGLE_STEP_RAD) * ORIENTATION_CACHE_ANGLE_STEP_RAD;
   }

   function sampleTiltAnimation(timeInCycleSec, ampRad) {
      const cycle = ((timeInCycleSec % TILT_ANIM_CYCLE_SEC) + TILT_ANIM_CYCLE_SEC) % TILT_ANIM_CYCLE_SEC;
      const step = Math.floor(cycle / TILT_ANIM_STEP_SEC);
      const frac = (cycle % TILT_ANIM_STEP_SEC) / TILT_ANIM_STEP_SEC;
      const norm = upDownBell(frac);
      // TODO: add animation switch
      const easingFunc = easingFuncs[ui.easingFuncName].func;
      const bell = easingFunc(norm);
      return {
         x: step === 0 ? bell * ampRad : 0,
         y: step === 1 ? bell * ampRad : 0,
      };
   }

   function buildTiltPreRenderQueue(baseRotX, baseRotY, ampRad) {
      const keys = new Set();
      const queue = [];
      const addFrame = (rotX, rotY) => {
         const qx = quantizeOrientationAngle(rotX);
         const qy = quantizeOrientationAngle(rotY);
         const key = orientationCacheKey(qx, qy);
         if (keys.has(key)) return;
         keys.add(key);
         queue.push({ key, rotX: qx, rotY: qy });
      };

      const frameCount = Math.max(1, Math.round(TILT_ANIM_CYCLE_SEC * tiltPreRenderSampleFps));
      for (let i = 0; i <= frameCount; i++) {
         const tCycle = (i / frameCount) * TILT_ANIM_CYCLE_SEC;
         const animSample = sampleTiltAnimation(tCycle, ampRad);
         addFrame(baseRotX + animSample.x, baseRotY + animSample.y);
      }

      return queue;
   }

   function requestTiltPreRender() {
      if (!renderBundle) return;
      const baseRotX = quantizeOrientationAngle(currentRotX);
      const baseRotY = quantizeOrientationAngle(currentRotY);
      tiltPreRenderBaseRotX = baseRotX;
      tiltPreRenderBaseRotY = baseRotY;
      const ampRad = ui.tiltAngleDeg * Math.PI / 180.0;
      const fullQueue = buildTiltPreRenderQueue(baseRotX, baseRotY, ampRad);
      const missingQueue = fullQueue.filter(item => !orientationFrameCache.has(item.key));
      tiltPreRenderQueue = missingQueue;
      tiltPreRenderIndex = 0;
      tiltPreRenderRequested = missingQueue.length > 0;
      tiltPreRenderReady = missingQueue.length === 0;
      prewarmYieldFlip = false;
      updatePrewarmOverlay(true);
      requestRender();
   }

   function writeUniformsForOrientation(rotX, rotY, time) {
      mat4.identity(prewarmModelMat);
      mat4.rotateX(prewarmModelMat, prewarmModelMat, rotX);
      mat4.rotateY(prewarmModelMat, prewarmModelMat, rotY);
      packUniformData(
         uniformScratch,
         prewarmModelMat,
         projMat,
         time,
         ui.lightMode,
         0.0,
         ui.lightMode === 4 ? 1.0 : 0.0,
      );
      device.queue.writeBuffer(uniformBuffer, 0, uniformScratch);
   }

   function renderOrientationToCache(cacheItem, bindGroup, vertexBuffer, triCount) {
      const cacheTexture = device.createTexture({
         size: [canvas.width, canvas.height],
         format: canvasFormat,
         usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const commandEncoder = device.createCommandEncoder();
      const renderPass = commandEncoder.beginRenderPass({
         colorAttachments: [{
            view: cacheTexture.createView(),
            clearValue: {
               r: ui.backgroundColor[0],
               g: ui.backgroundColor[1],
               b: ui.backgroundColor[2],
               a: 1.0,
            },
            loadOp: 'clear',
            storeOp: 'store',
         }],
         depthStencilAttachment: {
            view: depthTextureView,
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
         },
      });
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.draw(triCount * 3);
      renderPass.end();
      device.queue.submit([commandEncoder.finish()]);

      const cacheTextureBytes = estimateCacheTextureBytes(canvas.width, canvas.height, cacheBytesPerPixel);
      putOrientationCache(cacheItem.key, cacheTexture, cacheTextureBytes);
   }

   function advanceTiltPreRender(time, bindGroup, vertexBuffer, triCount) {
      if (!tiltPreRenderRequested || tiltPreRenderReady || !renderBundle) return;
      if (isMobileDevice) {
         prewarmYieldFlip = !prewarmYieldFlip;
         if (prewarmYieldFlip) {
            updatePrewarmOverlay();
            return;
         }
      }
      if (tiltPreRenderIndex >= tiltPreRenderQueue.length) {
         tiltPreRenderRequested = false;
         tiltPreRenderReady = true;
         updatePrewarmOverlay(true);
         return;
      }
      let renderedCount = 0;
      while (renderedCount < tiltPreRenderBudgetPerFrame && tiltPreRenderIndex < tiltPreRenderQueue.length) {
         const cacheItem = tiltPreRenderQueue[tiltPreRenderIndex++];
         if (orientationFrameCache.has(cacheItem.key)) continue;
         writeUniformsForOrientation(cacheItem.rotX, cacheItem.rotY, time);
         renderOrientationToCache(cacheItem, bindGroup, vertexBuffer, triCount);
         renderedCount++;
      }
      if (tiltPreRenderIndex >= tiltPreRenderQueue.length) {
         tiltPreRenderRequested = false;
         tiltPreRenderReady = true;
      }
      updatePrewarmOverlay();
   }

   function putOrientationCache(key, texture, bytes) {
      const existing = orientationFrameCache.get(key);
      if (existing) {
         existing.destroy();
         const prevBytes = orientationFrameCacheBytes.get(key) ?? 0;
         orientationCacheTotalBytes = Math.max(0, orientationCacheTotalBytes - prevBytes);
         orientationFrameCache.delete(key);
         orientationFrameCacheBytes.delete(key);
      }
      orientationFrameCache.set(key, texture);
      orientationFrameCacheBytes.set(key, bytes);
      orientationCacheTotalBytes += bytes;
      while (orientationFrameCache.size > orientationCacheMaxEntries) {
         const oldestKey = orientationFrameCache.keys().next().value;
         const oldestTex = orientationFrameCache.get(oldestKey);
         const oldestBytes = orientationFrameCacheBytes.get(oldestKey) ?? 0;
         if (oldestTex) oldestTex.destroy();
         orientationFrameCache.delete(oldestKey);
         orientationFrameCacheBytes.delete(oldestKey);
         orientationCacheTotalBytes = Math.max(0, orientationCacheTotalBytes - oldestBytes);
      }
   }

   async function applyStoneData(filename, stone, options = {}) {
      const syncDesignFromStone = options.syncDesignFromStone ?? true;
      const isDesign = options.isDesign ?? false;
      currentModelFilename = filename;

      const selectedVertexPosition = isDesign ? captureSingleSelectedVertexPosition() : null;

      currentStone = stone;
      designHaloCache = null;
      invalidateDesignPickState(true);
      modelBoundsRadius = Math.max(0.1, computeMeshBoundsRadius(stone.vertexData));
      console.debug(`Model bounds radius: ${modelBoundsRadius.toFixed(3)}`);

      function buildFacetsBuffer(facets) {
         /*struct Facet {
             normal: vec4<f32>, // xyz = outward normal, w = plane distance
             data: vec4<f32>,   // x = frosted/material/etc.
         };*/
         const bufferData = new Float32Array(facets.length * 8);
         facets.forEach((facet, i) => {
            const base = i * 8;
            bufferData[base + 0] = facet.normal[0];
            bufferData[base + 1] = facet.normal[1];
            bufferData[base + 2] = facet.normal[2];
            bufferData[base + 3] = facet.d;
            bufferData[base + 4] = facet.frosted ? 1 : 0;
            bufferData[base + 5] = 0; // padding for now, could be used for material ID or something
            bufferData[base + 6] = 0;
            bufferData[base + 7] = facets.length;
         });
         return bufferData;
      }

      const sentinelFacet = { normal: [0, 0, 0], d: 0, frosted: false };
      console.debug(stone);

      const facetsBuffer = buildFacetsBuffer(stone.facets.length > 0 ? stone.facets : [sentinelFacet]);

      const { nodeBuffer, triBuffer } = buildBVH(stone.vertexData, stone.triangleCount);

      const makeBuf = (data, usage) => {
         const buf = device.createBuffer({
            size: data.byteLength,
            usage: usage | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
         });
         new Float32Array(buf.getMappedRange()).set(data);
         buf.unmap();
         return buf;
      };

      const vertexBuffer = makeBuf(stone.vertexData, GPUBufferUsage.VERTEX);
      const triStorageBuffer = makeBuf(triBuffer, GPUBufferUsage.STORAGE);
      const bvhStorageBuffer = makeBuf(nodeBuffer, GPUBufferUsage.STORAGE);
      const facetsStorageBuffer = makeBuf(facetsBuffer, GPUBufferUsage.STORAGE);

      const bindGroup = device.createBindGroup({
         label: 'Main model bind group',
         layout: pipeline.getBindGroupLayout(0),
         entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: { buffer: triStorageBuffer } },
            { binding: 2, resource: { buffer: bvhStorageBuffer } },
            { binding: 3, resource: { buffer: facetsStorageBuffer } },
         ],
      });

      const graphBindGroups = graphUniformBuffers.map((graphUniformBuffer) => device.createBindGroup({
         label: 'Graph bind group',
         layout: graphPipeline.getBindGroupLayout(0),
         entries: [
            { binding: 0, resource: { buffer: graphUniformBuffer } },
            { binding: 1, resource: { buffer: triStorageBuffer } },
            { binding: 2, resource: { buffer: bvhStorageBuffer } },
            { binding: 3, resource: { buffer: facetsStorageBuffer } },
         ],
      }));

      renderBundle = { bindGroup, graphBindGroups, vertexBuffer, triCount: stone.triangleCount };
      invalidateOrientationCache();

      // Push RI and filename into the live panel
      if (stone.refractiveIndex && stone.refractiveIndex > 1.0) {
         uiControls.setRI(stone.refractiveIndex);
      }
      if (stone.dispersion != null) {
         uiControls.setCOD(stone.dispersion);
      }

      uiControls.setFileName(filename);
      modelHasTableFacet = hasUniqueTableFacet(stone.facets || []);
      if (Array.isArray(stone.facets) && stone.facets.length > 0) {
         renderFacetInfo(stone);
         setFacetStatus(
            isDesign
               ? `${stone.facets.length} generated facets from design`
               : `${stone.facets.length} facets parsed from ${filename}`,
         );
      } else {
         renderFacetInfo(null);
         if (isDesign) {
            setFacetStatus('Design produced no valid facets');
         } else {
            setFacetStatus(filename.toLowerCase().endsWith('.gem')
               ? `No named facets found in ${filename}`
               : `Facet notes are only available for .gem files`);
         }
      }

      if (!isDesign) {
         setCutsSequenceFromStone(stone);
      }

      if (syncDesignFromStone) {
         setDesignFromStoneFacets(
            Array.isArray(stone.facets) ? stone.facets : [],
            stone.sourceGear,
         );
         setMetadataToDesign(stone.metadata);
      }

      if (isDesign && selectedVertexPosition) {
         rebindSelectionToVertexPosition(selectedVertexPosition);
      }

      refreshDesignSizeCalculator();

      scheduleGraphUpdate('model load');
      resize();
      requestRender();
   }

   function syncCutsSequenceFromDesignFacets() {
      if (!designFacets.length) {
         cutsSourceStone = null;
         cutsSequence = [];
         cutsAngleIndex = 0;
         cutsIndexIndex = 0;
         updateCutsReadout();
         return;
      }

      try {
         const gear = parseInt(designGearEl.value, 10);
         const designDefinition = {
            gear,
            refractiveIndex: ui.ri,
            facets: designFacets.map((facet, idx) => normalizeDesignFacet(facet, idx)),
            metadata: getMetadataFromDesign(),
         };
         const designStone = buildStoneFromFacetDesign(designDefinition);
         setCutsSequenceFromStone(designStone);
      } catch (err) {
         console.warn('Cuts sequence sync failed from design facets:', err);
         if (currentStone) setCutsSequenceFromStone(currentStone);
      }
   }

   function applyDesignStone(geometryChanged = true) {
      if (!geometryChanged) {
         if (applyDesignMetadataToCurrentStone()) {
            setDesignStatus('Updated design metadata');
         }
         return;
      }

      try {
         const gear = parseInt(designGearEl.value, 10);
         const designDefinition = {
            gear: gear,
            refractiveIndex: ui.ri,
            facets: designFacets.map((facet, idx) => normalizeDesignFacet(facet, idx)),
            metadata: getMetadataFromDesign(),
         };
         const stone = buildStoneFromFacetDesign(designDefinition);
         applyStoneData(currentModelFilename, stone, { syncDesignFromStone: false, isDesign: true });
         setCutsSequenceFromStone(stone);
         setDesignStatus(designFacets.length
            ? `Applied ${designFacets.length} design facets`
            : 'Applied default cube (no facets yet)');
      } catch (err) {
         console.error(err);
         setDesignStatus(`Design failed: ${err?.message || 'invalid facets'}`);
      }
   }

   const designCrownRatioSlider = document.getElementById('designCrownRatioSlider');
   const designPavilionRatioSlider = document.getElementById('designPavilionRatioSlider');
   const designCrownRatio = document.getElementById('designCrownRatio');
   const designPavilionRatio = document.getElementById('designPavilionRatio');
   const designApplyScaleBtn = document.getElementById('designApplyScaleBtn');
   const designResetScaleBtn = document.getElementById('designResetScaleBtn');

   designSizeDriverTypeEl?.addEventListener('change', refreshDesignSizeCalculator);
   designSizeDriverValueEl?.addEventListener('input', refreshDesignSizeCalculator);
   designSizeGValueEl?.addEventListener('input', refreshDesignSizeCalculator);
   refreshDesignSizeCalculator();

   let suspendScaleAdjust = false;
   let pendingCrown = false;
   let pendingPavilion = false;

   const buildScaledDesignStone = (crownVal, pavVal) => {
      const gear = parseInt(designGearEl.value, 10);
      const designDefinition = {
         gear: gear,
         refractiveIndex: ui.ri,
         facets: designFacets.map((f, idx) => normalizeDesignFacet(f, idx)),
         metadata: getMetadataFromDesign(),
      };
      let stone = buildStoneFromFacetDesign(designDefinition);
      if (Math.abs(crownVal - 1.0) > 1e-6) stone = stretchStoneByVertices(stone, crownVal, true);
      if (Math.abs(pavVal - 1.0) > 1e-6) stone = stretchStoneByVertices(stone, pavVal, false);
      return { stone, gear };
   };

   const adjustRatio = (slider, label, crown = true) => {
      if (suspendScaleAdjust) return;
      if (crown) {
         pendingCrown = true;
      } else {
         pendingPavilion = true;
      }
      const movedVal = parseFloat(slider.value) || 1.0;
      label.textContent = movedVal.toFixed(3);
      const crownVal = parseFloat(designCrownRatioSlider.value) || 1.0;
      const pavVal = parseFloat(designPavilionRatioSlider.value) || 1.0;
      const { stone, gear } = buildScaledDesignStone(crownVal, pavVal);
      console.debug(`Gear ${gear} preview scales crown=${crownVal.toFixed(3)} pav=${pavVal.toFixed(3)} (moved ${crown ? 'crown' : 'pavilion'}=${movedVal.toFixed(3)})`);
      console.debug('Stretched stone', stone);
      applyStoneData(currentModelFilename, stone, { syncDesignFromStone: false, isDesign: true });
      setDesignStatus(`Scale preview crown=${crownVal.toFixed(3)} pav=${pavVal.toFixed(3)}`);
   };


   designCrownRatioSlider.addEventListener('input', () => {
      adjustRatio(designCrownRatioSlider, designCrownRatio, true);
   });

   designPavilionRatioSlider.addEventListener('input', () => {
      adjustRatio(designPavilionRatioSlider, designPavilionRatio, false);
   });

   if (designApplyScaleBtn) {
      designApplyScaleBtn.addEventListener('click', () => {
         const crownVal = parseFloat(designCrownRatioSlider.value) || 1.0;
         const pavVal = parseFloat(designPavilionRatioSlider.value) || 1.0;
         const historyBefore = snapshotDesignFacets();
         suspendScaleAdjust = true;
         try {
            const { stone, gear } = buildScaledDesignStone(crownVal, pavVal);
            console.log(`Applying scales crown=${crownVal.toFixed(3)} pav=${pavVal.toFixed(3)} for gear ${gear}`);
            applyStoneData(currentModelFilename, stone, { syncDesignFromStone: false, isDesign: true });
            // rebuild design facets table from new stone
            setDesignFromStoneFacets(stone.facets || [], stone.sourceGear, { resetHistory: false });
            commitDesignHistory(historyBefore);
            setDesignStatus(`Applied scales crown=${crownVal.toFixed(3)} pav=${pavVal.toFixed(3)}`);
         } catch (err) {
            console.error(err);
            setDesignStatus(`Apply scale failed: ${err?.message || 'error'}`);
         } finally {
            // reset sliders to 1.0 to avoid repeated application
            designCrownRatioSlider.value = '1.0';
            designPavilionRatioSlider.value = '1.0';
            designCrownRatio.textContent = '1.000';
            designPavilionRatio.textContent = '1.000';
            pendingCrown = false;
            pendingPavilion = false;
            suspendScaleAdjust = false;
         }
      });
   }

   designResetScaleBtn.addEventListener('click', () => {
      suspendScaleAdjust = true;
      designCrownRatioSlider.value = '1.0';
      designPavilionRatioSlider.value = '1.0';
      designCrownRatio.textContent = '1.000';
      designPavilionRatio.textContent = '1.000';
      pendingCrown = false;
      pendingPavilion = false;
      try {
         const { stone } = buildScaledDesignStone(1.0, 1.0);
         applyStoneData(currentModelFilename, stone, { syncDesignFromStone: false, isDesign: true });
         setDesignStatus('Scale reset');
      } catch (err) {
         console.error(err);
         setDesignStatus(`Scale reset failed: ${err?.message || 'error'}`);
      } finally {
         suspendScaleAdjust = false;
      }
   });

   // -------------------------------------------------------------------------
   // loadModel — swap mesh buffers; pipeline and UI are untouched.
   // -------------------------------------------------------------------------
   async function loadModel(filename, url) {
      console.log(`Loading ${filename}...`);

      const ext = filename.toLowerCase().match(/\.\w+$/)?.[0] ?? '';
      const response = await fetch(url);
      const data = await response.arrayBuffer();
      let stone;
      let convexFacetMode = 1;
      switch (ext) {
         case '.gem': stone = await loadGEM(data); break;
         case '.gcs': stone = await loadGCS(data); break;
         case '.asc': stone = await loadASC(data); break;
         default:
            stone = await loadSTL(data);
            convexFacetMode = 0;
            break;
      }

      ui.convexFacetMode = convexFacetMode;
      designGearEl.value = stone.sourceGear;

      normalizeStoneToUnitSphere(stone);

      await applyStoneData(filename, stone, { syncDesignFromStone: true, isDesign: false });

      // If a new model is loaded while Cuts is active, restore should target this model,
      // not the model that was active before entering Cuts.
      if (currentGemTab === 'cuts') {
         setCutsRestoreState(stone, filename, false);
      }
   }

   function shouldKeepRendering() {
      if (exportInProgress) return false;
      const designModeActive = currentGemTab === 'design';
      const rotSettling = Math.abs(targetRotX - currentRotX) > ROT_EPSILON
         || Math.abs(targetRotY - currentRotY) > ROT_EPSILON;
      const prewarmPending = tiltPreRenderRequested && !tiltPreRenderReady;
      return designModeActive || animating || dragPointerId !== null || rotSettling || prewarmPending;
   }

   uiControls = buildUI(ui, {
      onReset() {
         targetRotX = 0; targetRotY = 0;
         currentRotX = 0; currentRotY = 0;
         animating = false;
         tiltCyclePrevPhase = null;
         tiltCycleFrameCount = 0;
         tiltCycleAccumSec = 0;
         tiltCycleCompletedCount = 0;
         requestRender();
      },
      onTilt() {
         animating = !animating;
         if (animating) {
            animStartTime = performance.now() * 0.001;
            if (isMobileDevice) {
               requestTiltPreRender();
            }
         }
         requestRender();
         return animating;
      },
      onGraphParamsChanged() {
         resize();
         scheduleGraphUpdate();
         requestRender();
      },
      onRenderScaleChanged() {
         resize();
         requestRender();
      },
      onRenderOutputChanged() {
         invalidateOrientationCache();
         requestRender();
      },
      onGemTopTabChanged(tabName) {
         const prevTab = currentGemTab;
         currentGemTab = tabName;
         if (tabName !== 'design') {
            clearDesignSelection(true);
         }

         if (tabName === 'cuts' && prevTab !== 'cuts') {
            captureCutsRestoreState(prevTab);
         }

         if (prevTab === 'cuts' && tabName !== 'cuts') {
            queueRestoreAfterCuts();
         }

         if (tabName === 'cuts') {
            // Always rebuild from the current stone so Cuts reflects the latest design/model.
            setCutsSequenceFromStone(currentStone);
            updateCutsReadout();
            queueCutsNavigation('index', 0);
            requestRender();
            return;
         }

         if (prevTab === 'cuts') {
            updateCutsReadout();
         }

         if (tabName === 'design') {
            requestRender();
         }
      },
      onCutsNavigate(kind, direction) {
         if (!cutsSequence.length) {
            setCutsSequenceFromStone(currentStone);
         }
         if (!cutsSequence.length) {
            updateCutsReadout();
            return;
         }

         if (kind === 'angle') {
            moveCutsAngle(direction);
         } else if (kind === 'index') {
            moveCutsIndex(direction);
         } else {
            return;
         }

         updateCutsReadout();
         queueCutsNavigation(kind, 0);
      },
      onFileSelected(name, fileUrl) { loadModel(name, fileUrl); },
      async captureRaytracedStoneForPrint() {
         if (!renderBundle) return '';

         const prevBackground = [...ui.backgroundColor];
         const bgColorInput = panel.querySelector('#bgColor');

         ui.backgroundColor = [1, 1, 1];
         if (bgColorInput) bgColorInput.value = '#ffffff';
         applyBodyBackground(ui);
         invalidateOrientationCache();
         requestRender();

         await new Promise((resolve) => requestAnimationFrame(() => resolve()));
         const raytraceDataUrl = canvas.toDataURL('image/png');

         ui.backgroundColor = prevBackground;
         if (bgColorInput) bgColorInput.value = rgbToHex(prevBackground);
         applyBodyBackground(ui);
         invalidateOrientationCache();
         requestRender();

         return raytraceDataUrl;
      },
   });

   setupExporter(ui, () => ({
      renderBundle,
      device,
      canvas,
      canvasFormat,
      pipeline,
      uniformBuffer,
      mat4,
      currentModelFilename,
      currentRotX,
      currentRotY,
      quantizeOrientationAngle,
      sampleTiltAnimation,
      requestRender,
      clearTiltPrewarm() {
         if (!tiltPreRenderRequested) return;
         tiltPreRenderRequested = false;
         tiltPreRenderQueue = [];
         tiltPreRenderIndex = 0;
         updatePrewarmOverlay();
      },
      getAnimationState() {
         return {
            animating,
            animStartTime,
            tiltCyclePrevPhase,
            tiltCycleFrameCount,
            tiltCycleAccumSec,
            tiltCycleCompletedCount,
         };
      },
      setAnimationState(nextState) {
         animating = !!nextState.animating;
         animStartTime = Number(nextState.animStartTime) || 0;
         tiltCyclePrevPhase = nextState.tiltCyclePrevPhase ?? null;
         tiltCycleFrameCount = Number(nextState.tiltCycleFrameCount) || 0;
         tiltCycleAccumSec = Number(nextState.tiltCycleAccumSec) || 0;
         tiltCycleCompletedCount = Number(nextState.tiltCycleCompletedCount) || 0;
      },
      constants: {
         TILT_PRERENDER_SAMPLE_FPS,
         TILT_ANIM_CYCLE_SEC,
         STONE_MARGIN_SCALE,
      },
   }));

   // --- Pointer (canvas rotation) ---
   // setPointerCapture ensures move/up events are delivered even when the
   // finger slides off the canvas edge. touch-action:none (CSS) prevents
   // the browser from hijacking touches for scroll/zoom.
   let dragPointerId = null, lastX = 0, lastY = 0;
   let designClickStart = null;

   function updateDesignHoverFromPointer(clientX, clientY, forcePick = false) {
      designPointerClientX = clientX;
      designPointerClientY = clientY;
      if (currentGemTab !== 'design' || (!forcePick && dragPointerId !== null)) {
         designHover = null;
         return;
      }
      designHover = pickDesignEntity(clientX, clientY);
   }

   gpuCanvas.addEventListener('pointerdown', (e) => {
      if (dragPointerId !== null) return;          // ignore extra fingers
      dragPointerId = e.pointerId;
      lastX = e.clientX; lastY = e.clientY;
      designClickStart = {
         pointerId: e.pointerId,
         x: e.clientX,
         y: e.clientY,
         moved: false,
      };
      gpuCanvas.setPointerCapture(e.pointerId);
      requestRender();
   });

   function endDrag(e) {
      if (e.pointerId !== dragPointerId) return;
      if (currentGemTab === 'design' && designClickStart && designClickStart.pointerId === e.pointerId && !designClickStart.moved) {
         updateDesignHoverFromPointer(e.clientX, e.clientY, true);
         if (designHover) {
            // Design mode always accumulates selection; no modifier key needed.
            setSelectionFromHover(true);
         } else {
            // Tap/click outside picked geometry clears all selection.
            clearDesignSelection(true);
         }
      }
      dragPointerId = null;
      designClickStart = null;
      requestRender();
   }
   gpuCanvas.addEventListener('pointerup', endDrag);
   gpuCanvas.addEventListener('pointercancel', endDrag);

   gpuCanvas.addEventListener('pointermove', (e) => {
      updateDesignHoverFromPointer(e.clientX, e.clientY);

      if (e.pointerId !== dragPointerId) return;
      if (designClickStart && designClickStart.pointerId === e.pointerId) {
         if (Math.abs(e.clientX - designClickStart.x) > 3 || Math.abs(e.clientY - designClickStart.y) > 3) {
            designClickStart.moved = true;
         }
      }
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ev of events) {
         const dx = ((ev.clientX - lastX) / 500) * Math.PI;
         const dy = ((ev.clientY - lastY) / 500) * Math.PI * 0.5;
         targetRotY = quantizeOrientationAngle(targetRotY + dx);
         targetRotX = quantizeOrientationAngle(targetRotX + dy);
         lastX = ev.clientX; lastY = ev.clientY;
      }
      if (animating) {
         const vTiltEl = panel.querySelector('#vTilt');
         vTiltEl.click();
      }
      requestRender();
   });

   gpuCanvas.addEventListener('pointerleave', () => {
      designHover = null;
      requestRender();
   });

   window.addEventListener('keydown', (e) => {
      const key = String(e.key || '').toLowerCase();
      const isMac = /mac/i.test(navigator.platform);
      const hasUndoModifier = isMac ? e.metaKey : e.ctrlKey;

      if (hasUndoModifier && key === 'z') {
         e.preventDefault();
         const changed = e.shiftKey ? redoDesignHistory() : undoDesignHistory();
         if (!changed) setDesignStatus(e.shiftKey ? 'Nothing to redo.' : 'Nothing to undo.');
         return;
      }

      if (!isMac && e.ctrlKey && key === 'y') {
         e.preventDefault();
         if (!redoDesignHistory()) setDesignStatus('Nothing to redo.');
         return;
      }

      if (e.key === 'Escape') {
         clearDesignSelection(true);
         requestRender();
      }
   });

   // --- Axis indicator (created once) ---
   const axisCanvas = document.createElement('canvas');
   axisCanvas.id = 'axisCanvas';
   Object.assign(axisCanvas.style, {
      position: 'fixed', bottom: '16px', left: '16px',
      width: '120px', height: '120px',
      borderRadius: '8px', background: 'rgba(0,0,0,0)', pointerEvents: 'none',
   });
   document.body.appendChild(axisCanvas);
   const axCtx = axisCanvas.getContext('2d');
   const dpr = window.devicePixelRatio || 1;
   axisCanvas.width = 120 * dpr;
   axisCanvas.height = 120 * dpr;
   axCtx.scale(dpr, dpr);

   function drawAxes() {
      const cx = 60, cy = 60, len = 40;
      axCtx.clearRect(0, 0, 120, 120);
      const axes = [
         { label: 'X', color: '#f55', dx: modelMat[0], dy: modelMat[1] },
         { label: 'Y', color: '#5f5', dx: modelMat[4], dy: modelMat[5] },
         { label: 'Z', color: '#58f', dx: modelMat[8], dy: modelMat[9] },
      ];
      axes.sort((a, b) => a.dy - b.dy);
      axCtx.font = 'bold 11px system-ui';
      axCtx.textAlign = 'center';
      axCtx.textBaseline = 'middle';
      for (const ax of axes) {
         const ex = cx + ax.dx * len;
         const ey = cy - ax.dy * len;
         axCtx.beginPath(); axCtx.moveTo(cx, cy); axCtx.lineTo(ex, ey);
         axCtx.strokeStyle = ax.color; axCtx.lineWidth = 2; axCtx.stroke();
         axCtx.beginPath(); axCtx.arc(ex, ey, 3, 0, Math.PI * 2);
         axCtx.fillStyle = ax.color; axCtx.fill();
         axCtx.fillText(ax.label, cx + ax.dx * (len + 11), cy - ax.dy * (len + 11));
      }
      axCtx.beginPath(); axCtx.arc(cx, cy, 3, 0, Math.PI * 2);
      axCtx.fillStyle = '#fff'; axCtx.fill();
   }

   // --- FPS overlay (debug only) ---
   const fpsEl = document.getElementById('fpsOverlay');
   const FRAME_PLOT_WINDOW_SEC = 5.0;
   const FRAME_PLOT_WIDTH = 180;
   const FRAME_PLOT_HEIGHT = 48;
   let perfStatsVisible = false;
   let perfStatsTextEl = null;
   let perfStatsPlotCanvas = null;
   let perfStatsPlotCtx = null;
   // Ring buffer — no per-frame heap alloc, no O(n) shift
   const FRAME_HIST_CAP = 1024; // covers 5 s @ 200 fps
   const frameHistT = new Float64Array(FRAME_HIST_CAP); // timestamps (s)
   const frameHistMs = new Float32Array(FRAME_HIST_CAP); // frame deltas (ms)
   let frameHistHead = 0; // next-write slot
   let frameHistCount = 0; // valid entries (≤ FRAME_HIST_CAP)

   let fpsSmoothed = 60, lastFpsUpdate = 0, lastFrameTime = performance.now() * 0.001;
   let frameCpuTotalMsSmoothed = 0;
   let frameCpuUpdateMsSmoothed = 0;
   let frameCpuDrawMsSmoothed = 0;
   let frameCpuSubmitMsSmoothed = 0;
   let cachePresentSubmitMsSmoothed = 0;
   let shaderSubmitMsSmoothed = 0;
   let graphSweepMsSmoothed = 0;
   let frameGpuMsSmoothed = 0;
   let frameGpuReadPending = false;
   let lastGpuSampleTime = 0;
   let refreshHzEstimate = 60;

   function setPerfStatsVisible(visible) {
      perfStatsVisible = visible;
      if (!fpsEl) return;
      ensurePerfOverlayElements();
      fpsEl.style.display = perfStatsVisible ? 'block' : 'none';
      if (!perfStatsVisible) {
         if (perfStatsTextEl) perfStatsTextEl.textContent = '';
         if (perfStatsPlotCtx) {
            perfStatsPlotCtx.clearRect(0, 0, FRAME_PLOT_WIDTH, FRAME_PLOT_HEIGHT);
         }
      }
      updatePrewarmOverlay();
      lastFpsUpdate = performance.now() * 0.001;
   }

   function ensurePerfOverlayElements() {
      if (!fpsEl) return;
      if (!perfStatsTextEl) {
         perfStatsTextEl = document.createElement('div');
         fpsEl.appendChild(perfStatsTextEl);
      }
      if (!perfStatsPlotCanvas) {
         perfStatsPlotCanvas = document.createElement('canvas');
         perfStatsPlotCanvas.width = FRAME_PLOT_WIDTH;
         perfStatsPlotCanvas.height = FRAME_PLOT_HEIGHT;
         perfStatsPlotCanvas.style.display = 'block';
         perfStatsPlotCanvas.style.marginTop = '6px';
         perfStatsPlotCanvas.style.width = `${FRAME_PLOT_WIDTH}px`;
         perfStatsPlotCanvas.style.height = `${FRAME_PLOT_HEIGHT}px`;
         perfStatsPlotCanvas.style.borderRadius = '3px';
         perfStatsPlotCanvas.style.background = 'rgba(255,255,255,0.04)';
         fpsEl.appendChild(perfStatsPlotCanvas);
         perfStatsPlotCtx = perfStatsPlotCanvas.getContext('2d');
      }
   }

   function pushFrameTimeSample(timeSec, deltaSec) {
      frameHistT[frameHistHead] = timeSec;
      frameHistMs[frameHistHead] = deltaSec * 1000.0;
      frameHistHead = (frameHistHead + 1) % FRAME_HIST_CAP;
      if (frameHistCount < FRAME_HIST_CAP) frameHistCount++;
   }

   function drawFrameTimePlot(nowSec) {
      if (!perfStatsPlotCtx || !perfStatsPlotCanvas) return;
      if (frameHistCount < 2) return;

      const w = FRAME_PLOT_WIDTH;
      const h = FRAME_PLOT_HEIGHT;
      const ctx = perfStatsPlotCtx;
      ctx.clearRect(0, 0, w, h);

      const cutoff = nowSec - FRAME_PLOT_WINDOW_SEC;
      const tail = (frameHistHead - frameHistCount + FRAME_HIST_CAP) % FRAME_HIST_CAP;

      // Find first entry inside the window
      let startJ = 0;
      for (let j = 0; j < frameHistCount; j++) {
         if (frameHistT[(tail + j) % FRAME_HIST_CAP] >= cutoff) { startJ = j; break; }
      }
      if (frameHistCount - startJ < 2) return;

      let maxMs = 0;
      for (let j = startJ; j < frameHistCount; j++) {
         const ms = frameHistMs[(tail + j) % FRAME_HIST_CAP];
         if (ms > maxMs) maxMs = ms;
      }
      const yMax = Math.max(16.7, Math.min(80.0, maxMs * 1.1));

      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      const ms16 = 16.7, ms33 = 33.3;
      if (ms16 <= yMax) {
         const y16 = h - (ms16 / yMax) * h;
         ctx.beginPath(); ctx.moveTo(0, y16); ctx.lineTo(w, y16); ctx.stroke();
      }
      if (ms33 <= yMax) {
         const y33 = h - (ms33 / yMax) * h;
         ctx.beginPath(); ctx.moveTo(0, y33); ctx.lineTo(w, y33); ctx.stroke();
      }

      const minT = nowSec - FRAME_PLOT_WINDOW_SEC;
      ctx.lineWidth = 1.5;
      // 3 batched paths by color — all x/y computed inline, zero per-sample heap alloc
      const path0 = new Path2D(); // green  < 17 ms
      const path1 = new Path2D(); // yellow 17–33 ms
      const path2 = new Path2D(); // red    > 33 ms
      for (let j = startJ + 1; j < frameHistCount; j++) {
         const pi = (tail + j - 1) % FRAME_HIST_CAP;
         const ci = (tail + j) % FRAME_HIST_CAP;
         const prevX = ((frameHistT[pi] - minT) / FRAME_PLOT_WINDOW_SEC) * w;
         const prevY = h - (Math.min(frameHistMs[pi], yMax) / yMax) * h;
         const currX = ((frameHistT[ci] - minT) / FRAME_PLOT_WINDOW_SEC) * w;
         const currMs = frameHistMs[ci];
         const currY = h - (Math.min(currMs, yMax) / yMax) * h;
         const p = currMs < 17 ? path0 : currMs < 34 ? path1 : path2;
         p.moveTo(prevX, prevY);
         p.lineTo(currX, currY);
      }
      ctx.strokeStyle = '#59e35f'; ctx.beginPath(); ctx.stroke(path0);
      ctx.strokeStyle = '#f5c842'; ctx.beginPath(); ctx.stroke(path1);
      ctx.strokeStyle = '#ff5f5f'; ctx.beginPath(); ctx.stroke(path2);
   }

   if (DEBUG) {
      setPerfStatsVisible(false);
      const perfStatsToggle = document.getElementById('perfStatsToggle');
      if (perfStatsToggle instanceof HTMLInputElement) {
         perfStatsToggle.checked = false;
         perfStatsToggle.addEventListener('change', () => {
            setPerfStatsVisible(perfStatsToggle.checked);
            requestRender();
         });
      }
   }
   updatePrewarmOverlay();

   // --- Uniforms ---
   function updateUniforms(time) {
      let animX = 0, animY = 0;
      if (animating) {
         let elapsed = time - animStartTime;
         if (tiltPreRenderReady) {
            elapsed = Math.round(elapsed * tiltPreRenderSampleFps) / tiltPreRenderSampleFps;
         }
         const animSample = sampleTiltAnimation(elapsed, ui.tiltAngleDeg * Math.PI / 180.0);
         const amp = ui.tiltAngleDeg * Math.PI / 180.0;
         animX = Math.min(Math.max(animSample.x, 0), amp);
         animY = Math.min(Math.max(animSample.y, 0), amp);
      }

      currentRotX += (targetRotX - currentRotX) * 0.1;
      currentRotY += (targetRotY - currentRotY) * 0.1;

      const baseRotX = (animating && tiltPreRenderReady && tiltPreRenderBaseRotX !== null)
         ? tiltPreRenderBaseRotX
         : currentRotX;
      const baseRotY = (animating && tiltPreRenderReady && tiltPreRenderBaseRotY !== null)
         ? tiltPreRenderBaseRotY
         : currentRotY;

      effectiveRenderRotX = quantizeOrientationAngle(baseRotX + animX);
      effectiveRenderRotY = quantizeOrientationAngle(baseRotY + animY);

      mat4.identity(modelMat);
      mat4.rotateX(modelMat, modelMat, effectiveRenderRotX);
      mat4.rotateY(modelMat, modelMat, effectiveRenderRotY);
      // mat4.rotateZ(modelMat, modelMat, Math.PI);

      const aspect = canvas.width / canvas.height;
      // Focal length: maintain stone size by scaling camera distance proportionally.
      // Reference: fl=50mm → d=5 units, fov=45°. For other focal lengths:
      //   d = fl/10  (same angular size because fov narrows as d grows)
      //   fov = 2·atan(SENSOR_HALF / d)  where SENSOR_HALF = d_ref·tan(fov_ref/2)
      const SENSOR_HALF = 5 * Math.tan(Math.PI / 8) * STONE_MARGIN_SCALE; // margin scales apparent framing
      const camDist = ui.focalLength / 10;
      cameraPos[2] = camDist;
      mat4.lookAt(viewMat, [0, 0, camDist], [0, 0, 0], [0, 1, 0]);
      const fovY = 2 * Math.atan(SENSOR_HALF / camDist);
      mat4.perspective(projMat, fovY, aspect, 0.1, 200.0);

      packUniformData(
         uniformScratch,
         modelMat,
         projMat,
         time,
         ui.lightMode,
         0.0,
         ui.lightMode === 4 ? 1.0 : 0.0,
      );
      device.queue.writeBuffer(uniformBuffer, 0, uniformScratch);
   }

   // --- Render loop ---
   frame = function render() {
      framePending = false;
      const frameStartMs = performance.now();
      const time = performance.now() * 0.001;

      const dt = time - lastFrameTime;
      lastFrameTime = time;
      if (perfStatsVisible) pushFrameTimeSample(time, dt);
      const instantFps = dt > 0 ? (1 / dt) : refreshHzEstimate;
      const clampedFps = Math.min(240, Math.max(10, instantFps));
      fpsSmoothed = fpsSmoothed * 0.9 + clampedFps * 0.1;
      refreshHzEstimate = Math.max(clampedFps, refreshHzEstimate * 0.995);

      if (animating) {
         const elapsed = time - animStartTime;
         const phase = ((elapsed % TILT_ANIM_CYCLE_SEC) + TILT_ANIM_CYCLE_SEC) % TILT_ANIM_CYCLE_SEC;
         if (tiltCyclePrevPhase !== null && phase < tiltCyclePrevPhase) {
            tiltCycleCompletedCount += 1;
            if (tiltCycleAccumSec > 0 && tiltCycleCompletedCount >= 2) {
               tiltCycleAvgFps = tiltCycleFrameCount / tiltCycleAccumSec;
               if (tiltCycleAvgFps < TILT_PRERENDER_FPS_THRESHOLD && !tiltPreRenderRequested && !tiltPreRenderReady) {
                  requestTiltPreRender();
               }
            }
            tiltCycleFrameCount = 0;
            tiltCycleAccumSec = 0;
         }
         tiltCyclePrevPhase = phase;
         tiltCycleFrameCount += 1;
         tiltCycleAccumSec += Math.max(dt, 0);
      } else {
         tiltCyclePrevPhase = null;
         tiltCycleCompletedCount = 0;
      }

      const useTiltCache = animating && tiltPreRenderReady;

      const updateStartMs = performance.now();
      updateUniforms(time);
      mat4.multiply(invViewProjMat, projMat, viewMat);
      mat4.invert(invViewProjMat, invViewProjMat);
      mat4.invert(invModelMat, modelMat);
      const updateEndMs = performance.now();

      const drawStartMs = performance.now();
      drawAxes();
      drawDesignSelectionOverlay();
      const drawEndMs = performance.now();

      if (renderBundle) {
         const { bindGroup, vertexBuffer, triCount } = renderBundle;
         const canvasTexture = context.getCurrentTexture();
         const cacheKey = useTiltCache ? orientationCacheKey(effectiveRenderRotX, effectiveRenderRotY) : null;
         const cachedTexture = cacheKey ? orientationFrameCache.get(cacheKey) : null;

         if (cachedTexture) {
            const copyEncoder = device.createCommandEncoder();
            copyEncoder.copyTextureToTexture(
               { texture: cachedTexture },
               { texture: canvasTexture },
               [canvas.width, canvas.height, 1],
            );
            const submitStartMs = performance.now();
            device.queue.submit([copyEncoder.finish()]);
            const submitEndMs = performance.now();
            const submitMs = submitEndMs - submitStartMs;
            frameCpuSubmitMsSmoothed = frameCpuSubmitMsSmoothed * 0.8 + submitMs * 0.2;
            cachePresentSubmitMsSmoothed = cachePresentSubmitMsSmoothed * 0.8 + submitMs * 0.2;
         } else {
            const commandEncoder = device.createCommandEncoder();
            const useGpuTimestampSample = perfStatsVisible && hasGpuTimestamps
               && !frameGpuReadPending
               && (time - lastGpuSampleTime) >= 0.25;
            const renderPassDescriptor = {
               colorAttachments: [{
                  view: canvasTexture.createView(),
                  clearValue: {
                     r: ui.backgroundColor[0],
                     g: ui.backgroundColor[1],
                     b: ui.backgroundColor[2],
                     a: 1.0,
                  },
                  loadOp: 'clear',
                  storeOp: 'store',
               }],
               depthStencilAttachment: {
                  view: depthTextureView,
                  depthClearValue: 1.0,
                  depthLoadOp: 'clear',
                  depthStoreOp: 'discard',
               },
            };
            if (useGpuTimestampSample && frameTimestampQuerySet) {
               renderPassDescriptor.timestampWrites = {
                  querySet: frameTimestampQuerySet,
                  beginningOfPassWriteIndex: 0,
                  endOfPassWriteIndex: 1,
               };
            }
            const renderPass = commandEncoder.beginRenderPass(renderPassDescriptor);
            renderPass.setPipeline(pipeline);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.setVertexBuffer(0, vertexBuffer);
            renderPass.draw(triCount * 3);
            renderPass.end();

            if (cacheKey) {
               const cacheTexture = device.createTexture({
                  size: [canvas.width, canvas.height],
                  format: canvasFormat,
                  usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
               });
               const cacheTextureBytes = estimateCacheTextureBytes(canvas.width, canvas.height, cacheBytesPerPixel);
               commandEncoder.copyTextureToTexture(
                  { texture: canvasTexture },
                  { texture: cacheTexture },
                  [canvas.width, canvas.height, 1],
               );
               putOrientationCache(cacheKey, cacheTexture, cacheTextureBytes);
            }

            if (useGpuTimestampSample && frameTimestampQuerySet && frameTimestampResolveBuffer && frameTimestampReadbackBuffer) {
               commandEncoder.resolveQuerySet(frameTimestampQuerySet, 0, 2, frameTimestampResolveBuffer, 0);
               commandEncoder.copyBufferToBuffer(frameTimestampResolveBuffer, 0, frameTimestampReadbackBuffer, 0, 16);
            }

            const submitStartMs = performance.now();
            device.queue.submit([commandEncoder.finish()]);
            const submitEndMs = performance.now();
            const submitMs = submitEndMs - submitStartMs;
            frameCpuSubmitMsSmoothed = frameCpuSubmitMsSmoothed * 0.8 + submitMs * 0.2;
            shaderSubmitMsSmoothed = shaderSubmitMsSmoothed * 0.8 + submitMs * 0.2;

            if (useGpuTimestampSample && frameTimestampReadbackBuffer) {
               frameGpuReadPending = true;
               lastGpuSampleTime = time;
               frameTimestampReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
                  const data = new BigUint64Array(frameTimestampReadbackBuffer.getMappedRange());
                  const deltaTicks = Number(data[1] - data[0]);
                  frameTimestampReadbackBuffer.unmap();
                  const gpuMs = (deltaTicks * queueTimestampPeriod) / 1e6;
                  frameGpuMsSmoothed = frameGpuMsSmoothed * 0.8 + gpuMs * 0.2;
                  frameGpuReadPending = false;
               }).catch(() => {
                  frameGpuReadPending = false;
               });
            }
         }

         advanceTiltPreRender(time, bindGroup, vertexBuffer, triCount);

         packUniformData(
            uniformScratch,
            modelMat,
            projMat,
            time,
            ui.lightMode,
            0.0,
            ui.lightMode === 4 ? 1.0 : 0.0,
         );
         device.queue.writeBuffer(uniformBuffer, 0, uniformScratch);
      }

      if (perfStatsVisible) {
         frameCpuUpdateMsSmoothed = frameCpuUpdateMsSmoothed * 0.8 + (updateEndMs - updateStartMs) * 0.2;
         frameCpuDrawMsSmoothed = frameCpuDrawMsSmoothed * 0.8 + (drawEndMs - drawStartMs) * 0.2;
         frameCpuTotalMsSmoothed = frameCpuTotalMsSmoothed * 0.8 + (performance.now() - frameStartMs) * 0.2;
      }

      if (perfStatsVisible && fpsEl && (time - lastFpsUpdate > 0.2)) {
         const gpuLabel = hasGpuTimestamps
            ? `${frameGpuMsSmoothed.toFixed(2)} ms`
            : 'n/a';
         const cacheFill = (orientationFrameCache.size / orientationCacheMaxEntries) * 100;
         const cacheMiB = orientationCacheTotalBytes / (1024 * 1024);
         const cssW = Math.max(1, Math.round(canvas.clientWidth || parseFloat(canvas.style.width) || 0));
         const cssH = Math.max(1, Math.round(canvas.clientHeight || parseFloat(canvas.style.height) || 0));
         const effectiveDpr = cssW > 0 ? (canvas.width / cssW) : 1;
         ensurePerfOverlayElements();
         perfStatsTextEl.innerHTML = [
            `FPS: ${Math.round(fpsSmoothed)}`,
            `Refresh est: ${Math.round(refreshHzEstimate)}`,
            `Render res: ${canvas.width}×${canvas.height} (${effectiveDpr.toFixed(2)}x DPR, CSS ${cssW}×${cssH})`,
            `CPU total: ${frameCpuTotalMsSmoothed.toFixed(2)} ms`,
            `CPU update: ${frameCpuUpdateMsSmoothed.toFixed(2)} ms`,
            `CPU axes: ${frameCpuDrawMsSmoothed.toFixed(2)} ms`,
            `CPU submit: ${frameCpuSubmitMsSmoothed.toFixed(2)} ms`,
            `Cache present: ${cachePresentSubmitMsSmoothed.toFixed(2)} ms`,
            `Shader submit: ${shaderSubmitMsSmoothed.toFixed(2)} ms`,
            `GPU render: ${gpuLabel}`,
            `Graph sweep: ${graphSweepMsSmoothed.toFixed(1)} ms`,
            `Cache fill: ${orientationFrameCache.size}/${orientationCacheMaxEntries} (${cacheFill.toFixed(1)}%)`,
            `Cache memory (raw est.): ${cacheMiB.toFixed(1)} MiB`,
            `Tilt cycle avg: ${tiltCycleAvgFps.toFixed(1)} FPS`,
            `Tilt prewarm: ${tiltPreRenderReady ? 'ready' : (tiltPreRenderRequested ? `${tiltPreRenderIndex}/${tiltPreRenderQueue.length}` : 'idle')}`,
         ].join('<br>');
         drawFrameTimePlot(time);
         lastFpsUpdate = time;
      }

      if (shouldKeepRendering()) {
         requestRender();
      }
   }

   // --- Resize ---
   function computeCanvasHorizontalBounds(viewportWidth) {
      if (window.innerWidth <= 960) {
         return { left: 0, width: viewportWidth };
      }
      const controlsLeft = panel?.getBoundingClientRect?.().left;
      if (!Number.isFinite(controlsLeft)) {
         return { left: 0, width: viewportWidth };
      }
      const gapPx = 8;
      const usableRight = Math.max(2, Math.floor(controlsLeft - gapPx));
      return {
         left: 0,
         width: Math.max(2, Math.min(viewportWidth, usableRight)),
      };
   }

   function computeFitCanvasCssSize(viewportWidth, viewportHeight) {
      const horizontal = computeCanvasHorizontalBounds(viewportWidth);
      const side = Math.max(2, Math.floor(Math.min(horizontal.width, viewportHeight)));
      const left = Math.round(horizontal.left + (horizontal.width - side) * 0.5);
      return { width: side, height: side, left };
   }

   function resize() {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const fitCss = computeFitCanvasCssSize(viewportWidth, viewportHeight);

      canvas.style.position = 'fixed';
      canvas.style.width = `${fitCss.width}px`;
      canvas.style.height = `${fitCss.height}px`;
      canvas.style.left = `${fitCss.left}px`;
      canvas.style.top = `${Math.round((viewportHeight - fitCss.height) * 0.5)}px`;

      const maxRenderScale = getRenderScaleUpperBound();
      ui.renderScaleMax = maxRenderScale;
      uiControls?.setRenderScaleMax(maxRenderScale);
      const dpr = clampRenderScale(ui.renderScale, maxRenderScale);
      ui.renderScale = dpr;
      const cssWidth = Math.max(1, fitCss.width);
      const cssHeight = Math.max(1, fitCss.height);
      let nextWidth = Math.max(1, Math.round(cssWidth * dpr));
      let nextHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (nextWidth % 2 !== 0) nextWidth -= 1;
      if (nextHeight % 2 !== 0) nextHeight -= 1;
      nextWidth = Math.max(2, nextWidth);
      nextHeight = Math.max(2, nextHeight);

      if (canvas.width === nextWidth && canvas.height === nextHeight) {
         return;
      }

      canvas.width = nextWidth;
      canvas.height = nextHeight;
      invalidateOrientationCache();
      depthTexture = device.createTexture({
         size: [canvas.width, canvas.height],
         format: 'depth24plus',
         usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      depthTextureView = depthTexture.createView();
      requestRender();
   }
   window.addEventListener('resize', resize);
   window.addEventListener('resize', resizeSelectionOverlay);
   window.visualViewport?.addEventListener('resize', resizeSelectionOverlay);
   window.visualViewport?.addEventListener('scroll', resizeSelectionOverlay);
   resizeSelectionOverlay();
   resize();
   requestRender();

   return { loadModel };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function getStartupModelFromLocation(defaultName, defaultUrl) {
   const params = new URLSearchParams(window.location.search || '');
   let candidate = params.get('url') || params.get('file') || params.get('model');
   if (!candidate) {
      return { name: defaultName, url: defaultUrl, fromQuery: false };
   }

   candidate = candidate.trim();
   if (!candidate) {
      return { name: defaultName, url: defaultUrl, fromQuery: false };
   }

   let resolvedUrl = defaultUrl;
   try {
      resolvedUrl = new URL(candidate, window.location.href).href;
   } catch (err) {
      console.warn('Startup model URL is invalid, using default model.', err);
      return { name: defaultName, url: defaultUrl, fromQuery: false };
   }

   let derivedName = defaultName;
   try {
      const parsed = new URL(resolvedUrl);
      const leaf = parsed.pathname.split('/').filter(Boolean).pop();
      if (leaf) derivedName = decodeURIComponent(leaf);
   } catch {
      // Keep default filename when URL parsing fails.
   }

   return { name: derivedName, url: resolvedUrl, fromQuery: true };
}

const app = await setupApp();
if (app) {
   const defaultName = 'Eye_of_Zul.asc';
   const defaultUrl = './models/Eye_of_Zul.asc';
   const startupModel = getStartupModelFromLocation(defaultName, defaultUrl);

   try {
      await app.loadModel(startupModel.name, startupModel.url);
   } catch (err) {
      console.error(`Failed to load startup model from ${startupModel.url}`, err);
      if (startupModel.fromQuery) {
         await app.loadModel(defaultName, defaultUrl);
      }
   }
}

"use strict";

const exportTiltBtn = document.getElementById('exportTiltBtn');
const exportStatusEl = document.getElementById('exportStatus');
const exportProgressEl = document.getElementById('exportProgress');
const exportProgressFillEl = document.getElementById('exportProgressFill');
const exportQualitySelect = document.getElementById('exportQualitySelect');
let exportInProgress = false;
let exporterUiState = null;
let getExporterRuntime = null;
let exporterUiBound = false;

const EXPORT_QUALITY_PRESETS = {
   400: { maxLongEdge: 400, bitrate: 2_000_000 },
   800: { maxLongEdge: 800, bitrate: 4_000_000 },
   1080: { maxLongEdge: 1080, bitrate: 16_000_000 },
   2160: { maxLongEdge: 2160, bitrate: 24_000_000 },
};

function setupExporter(ui, runtimeSource) {
   exporterUiState = ui;
   getExporterRuntime = typeof runtimeSource === 'function'
      ? runtimeSource
      : () => runtimeSource;

   if (exportQualitySelect && exporterUiState) {
      exportQualitySelect.value = String(exporterUiState.exportQualityPx);
   }

   if (exporterUiBound) return;
   exporterUiBound = true;

   exportTiltBtn.addEventListener('click', async () => {
      if (exportTiltBtn.dataset.busy === '1') return;
      exportTiltBtn.dataset.busy = '1';
      exportTiltBtn.style.pointerEvents = 'none';
      exportTiltBtn.textContent = 'Exporting…';
      if (exportStatusEl) exportStatusEl.textContent = 'Preparing export…';
      setExportProgress(0.02, { visible: true });
      try {
         const runtime = getExporterRuntime?.();
         const ok = await exportTiltLoop((progress, statusText) => {
            setExportProgress(progress, { visible: true });
            if (exportStatusEl && statusText) exportStatusEl.textContent = statusText;
         }, exporterUiState, runtime);
         if (exportStatusEl) {
            exportStatusEl.textContent = ok ? 'Export complete.' : 'Export failed.';
            setExportProgress(ok ? 1 : 0, { visible: true });
            setTimeout(() => {
               if (exportStatusEl.textContent === 'Export complete.' || exportStatusEl.textContent === 'Export failed.') {
                  exportStatusEl.textContent = '';
               }
               setExportProgress(0, { visible: false });
            }, 2500);
         }
      } catch (error) {
         if (exportStatusEl) exportStatusEl.textContent = error?.message || 'Export failed.';
         setExportProgress(0, { visible: false });
      } finally {
         exportTiltBtn.dataset.busy = '0';
         exportTiltBtn.style.pointerEvents = '';
         exportTiltBtn.textContent = 'Export Video';
      }
   });

   exportQualitySelect?.addEventListener('change', () => {
      if (!exporterUiState) return;
      const parsed = parseInt(exportQualitySelect.value, 10);
      if (EXPORT_QUALITY_PRESETS[parsed]) {
         exporterUiState.exportQualityPx = parsed;
      }
   });
}


function setExportProgress(progress, { visible = true } = {}) {
   if (!exportProgressEl || !exportProgressFillEl) return;
   if (!visible) {
      exportProgressEl.style.display = 'none';
      exportProgressFillEl.style.width = '0%';
      return;
   }
   const clamped = Math.max(0, Math.min(1, progress));
   exportProgressEl.style.display = 'block';
   exportProgressFillEl.style.width = `${(clamped * 100).toFixed(1)}%`;
}

function makeMp4Box(type, ...payloads) {
   let payloadSize = 0;
   for (const payload of payloads) payloadSize += payload.byteLength;
   const out = new Uint8Array(8 + payloadSize);
   const view = new DataView(out.buffer);
   view.setUint32(0, out.byteLength, false);
   out[4] = type.charCodeAt(0);
   out[5] = type.charCodeAt(1);
   out[6] = type.charCodeAt(2);
   out[7] = type.charCodeAt(3);
   let offset = 8;
   for (const payload of payloads) {
      out.set(payload, offset);
      offset += payload.byteLength;
   }
   return out;
}

function makeMp4U8(size) {
   return new Uint8Array(size);
}

function makeMp4Ftyp() {
   const payload = makeMp4U8(24);
   payload.set([0x69, 0x73, 0x6f, 0x6d], 0); // isom
   payload.set([0, 0, 0, 1], 4);
   payload.set([0x69, 0x73, 0x6f, 0x6d], 8);
   payload.set([0x69, 0x73, 0x6f, 0x36], 12);
   payload.set([0x61, 0x76, 0x63, 0x31], 16);
   payload.set([0x6d, 0x70, 0x34, 0x31], 20);
   return makeMp4Box('ftyp', payload);
}

function makeMp4Mvhd(timescale, duration, creationTime) {
   const payload = makeMp4U8(100);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, creationTime, false);
   view.setUint32(8, creationTime, false);
   view.setUint32(12, timescale >>> 0, false);
   view.setUint32(16, duration >>> 0, false);
   view.setUint32(20, 0x00010000, false);
   view.setUint16(24, 0x0100, false);
   view.setUint16(26, 0, false);
   view.setUint32(28, 0, false);
   view.setUint32(32, 0, false);
   view.setInt32(36, 0x00010000, false);
   view.setInt32(40, 0, false);
   view.setInt32(44, 0, false);
   view.setInt32(48, 0, false);
   view.setInt32(52, 0x00010000, false);
   view.setInt32(56, 0, false);
   view.setInt32(60, 0, false);
   view.setInt32(64, 0, false);
   view.setInt32(68, 0x40000000, false);
   view.setUint32(72, 0, false);
   view.setUint32(76, 0, false);
   view.setUint32(80, 0, false);
   view.setUint32(84, 0, false);
   view.setUint32(88, 0, false);
   view.setUint32(92, 0, false);
   view.setUint32(96, 2, false);
   return makeMp4Box('mvhd', payload);
}

function makeMp4Tkhd(trackId, duration, width, height, creationTime) {
   const payload = makeMp4U8(84);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0x00000007, false);
   view.setUint32(4, creationTime, false);
   view.setUint32(8, creationTime, false);
   view.setUint32(12, trackId >>> 0, false);
   view.setUint32(16, 0, false);
   view.setUint32(20, duration >>> 0, false);
   view.setUint32(24, 0, false);
   view.setUint32(28, 0, false);
   view.setUint16(32, 0, false);
   view.setUint16(34, 0, false);
   view.setUint16(36, 0, false);
   view.setUint16(38, 0, false);
   view.setInt32(40, 0x00010000, false);
   view.setInt32(44, 0, false);
   view.setInt32(48, 0, false);
   view.setInt32(52, 0, false);
   view.setInt32(56, 0x00010000, false);
   view.setInt32(60, 0, false);
   view.setInt32(64, 0, false);
   view.setInt32(68, 0, false);
   view.setInt32(72, 0x40000000, false);
   view.setUint32(76, (width << 16) >>> 0, false);
   view.setUint32(80, (height << 16) >>> 0, false);
   return makeMp4Box('tkhd', payload);
}

function makeMp4Mdhd(timescale, duration, creationTime) {
   const payload = makeMp4U8(24);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, creationTime, false);
   view.setUint32(8, creationTime, false);
   view.setUint32(12, timescale >>> 0, false);
   view.setUint32(16, duration >>> 0, false);
   view.setUint16(20, 0x55c4, false); // und
   view.setUint16(22, 0, false);
   return makeMp4Box('mdhd', payload);
}

function makeMp4Hdlr() {
   const name = new TextEncoder().encode('VideoHandler\u0000');
   const payload = makeMp4U8(24 + name.byteLength);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, 0, false);
   payload.set([0x76, 0x69, 0x64, 0x65], 8); // vide
   view.setUint32(12, 0, false);
   view.setUint32(16, 0, false);
   view.setUint32(20, 0, false);
   payload.set(name, 24);
   return makeMp4Box('hdlr', payload);
}

function makeMp4Vmhd() {
   const payload = makeMp4U8(12);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0x00000001, false);
   view.setUint16(4, 0, false);
   view.setUint16(6, 0, false);
   view.setUint16(8, 0, false);
   view.setUint16(10, 0, false);
   return makeMp4Box('vmhd', payload);
}

function makeMp4Dinf() {
   const urlPayload = makeMp4U8(4);
   new DataView(urlPayload.buffer).setUint32(0, 0x00000001, false);
   const url = makeMp4Box('url ', urlPayload);

   const drefPayload = makeMp4U8(8);
   const drefView = new DataView(drefPayload.buffer);
   drefView.setUint32(0, 0, false);
   drefView.setUint32(4, 1, false);
   const dref = makeMp4Box('dref', drefPayload, url);
   return makeMp4Box('dinf', dref);
}

function makeMp4Avc1(width, height, avcC) {
   const payload = makeMp4U8(78);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint16(4, 0, false);
   view.setUint16(6, 1, false);
   view.setUint16(8, 0, false);
   view.setUint16(10, 0, false);
   view.setUint32(12, 0, false);
   view.setUint32(16, 0, false);
   view.setUint32(20, 0, false);
   view.setUint16(24, width, false);
   view.setUint16(26, height, false);
   view.setUint32(28, 0x00480000, false);
   view.setUint32(32, 0x00480000, false);
   view.setUint32(36, 0, false);
   view.setUint16(40, 1, false);
   payload[42] = 0;
   for (let i = 43; i < 74; i++) payload[i] = 0;
   view.setUint16(74, 0x0018, false);
   view.setUint16(76, 0xffff, false);
   const avcCBox = makeMp4Box('avcC', avcC);
   return makeMp4Box('avc1', payload, avcCBox);
}

function makeMp4Stts(sampleCount, sampleDuration) {
   const payload = makeMp4U8(16);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, 1, false);
   view.setUint32(8, sampleCount >>> 0, false);
   view.setUint32(12, sampleDuration >>> 0, false);
   return makeMp4Box('stts', payload);
}

function makeMp4Stsc(sampleCount) {
   const payload = makeMp4U8(20);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, 1, false);
   view.setUint32(8, 1, false);
   view.setUint32(12, sampleCount >>> 0, false);
   view.setUint32(16, 1, false);
   return makeMp4Box('stsc', payload);
}

function makeMp4Stsz(sampleSizes) {
   const payload = makeMp4U8(12 + sampleSizes.length * 4);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, 0, false);
   view.setUint32(8, sampleSizes.length >>> 0, false);
   let offset = 12;
   for (const size of sampleSizes) {
      view.setUint32(offset, size >>> 0, false);
      offset += 4;
   }
   return makeMp4Box('stsz', payload);
}

function makeMp4Stco(dataOffset) {
   const payload = makeMp4U8(12);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, 1, false);
   view.setUint32(8, dataOffset >>> 0, false);
   return makeMp4Box('stco', payload);
}

function makeMp4Stss(syncSampleNumbers) {
   const payload = makeMp4U8(8 + syncSampleNumbers.length * 4);
   const view = new DataView(payload.buffer);
   view.setUint32(0, 0, false);
   view.setUint32(4, syncSampleNumbers.length >>> 0, false);
   let offset = 8;
   for (const sampleNumber of syncSampleNumbers) {
      view.setUint32(offset, sampleNumber >>> 0, false);
      offset += 4;
   }
   return makeMp4Box('stss', payload);
}

function makeMp4Moov({ width, height, timescale, duration, sampleCount, sampleDuration, sampleSizes, syncSampleNumbers, avcC, mdatDataOffset, creationTime }) {
   const mvhd = makeMp4Mvhd(timescale, duration, creationTime);
   const tkhd = makeMp4Tkhd(1, duration, width, height, creationTime);
   const mdhd = makeMp4Mdhd(timescale, duration, creationTime);
   const hdlr = makeMp4Hdlr();
   const vmhd = makeMp4Vmhd();
   const dinf = makeMp4Dinf();

   const stsdHeader = makeMp4U8(8);
   const stsdView = new DataView(stsdHeader.buffer);
   stsdView.setUint32(0, 0, false);
   stsdView.setUint32(4, 1, false);
   const avc1 = makeMp4Avc1(width, height, avcC);
   const stsd = makeMp4Box('stsd', stsdHeader, avc1);
   const stts = makeMp4Stts(sampleCount, sampleDuration);
   const stsc = makeMp4Stsc(sampleCount);
   const stsz = makeMp4Stsz(sampleSizes);
   const stco = makeMp4Stco(mdatDataOffset);
   const stss = makeMp4Stss(syncSampleNumbers);

   const stbl = makeMp4Box('stbl', stsd, stts, stsc, stsz, stco, stss);
   const minf = makeMp4Box('minf', vmhd, dinf, stbl);
   const mdia = makeMp4Box('mdia', mdhd, hdlr, minf);
   const trak = makeMp4Box('trak', tkhd, mdia);
   return makeMp4Box('moov', mvhd, trak);
}

function makeMp4FromAvcSamples({ width, height, timescale, sampleDuration, sampleData, syncSampleNumbers, avcC }) {
   const sampleCount = sampleData.length;
   const sampleSizes = sampleData.map(s => s.byteLength);
   const totalSampleBytes = sampleSizes.reduce((sum, size) => sum + size, 0);

   const creationTime = Math.floor((Date.now() / 1000) + 2082844800);
   const duration = (sampleCount * sampleDuration) >>> 0;
   const ftyp = makeMp4Ftyp();

   let moov = makeMp4Moov({
      width,
      height,
      timescale,
      duration,
      sampleCount,
      sampleDuration,
      sampleSizes,
      syncSampleNumbers,
      avcC,
      mdatDataOffset: 0,
      creationTime,
   });

   const mdatDataOffset = ftyp.byteLength + moov.byteLength + 8;
   moov = makeMp4Moov({
      width,
      height,
      timescale,
      duration,
      sampleCount,
      sampleDuration,
      sampleSizes,
      syncSampleNumbers,
      avcC,
      mdatDataOffset,
      creationTime,
   });

   const mdat = makeMp4U8(8 + totalSampleBytes);
   const mdatView = new DataView(mdat.buffer);
   mdatView.setUint32(0, mdat.byteLength, false);
   mdat[4] = 0x6d; // m
   mdat[5] = 0x64; // d
   mdat[6] = 0x61; // a
   mdat[7] = 0x74; // t
   let mdatOffset = 8;
   for (const sample of sampleData) {
      mdat.set(sample, mdatOffset);
      mdatOffset += sample.byteLength;
   }

   return new Blob([ftyp, moov, mdat], { type: 'video/mp4' });
}

function validateExporterRuntime(runtime) {
   if (!runtime) throw new Error('Exporter runtime unavailable.');
   const requiredKeys = [
      'renderBundle',
      'device',
      'canvas',
      'canvasFormat',
      'pipeline',
      'uniformBuffer',
      'mat4',
      'currentModelFilename',
      'currentRotX',
      'currentRotY',
      'quantizeOrientationAngle',
      'sampleTiltAnimation',
      'requestRender',
      'packUniformDataForExport',
      'clearTiltPrewarm',
      'getAnimationState',
      'setAnimationState',
      'constants',
   ];
   for (const key of requiredKeys) {
      if (!(key in runtime)) {
         throw new Error(`Exporter runtime missing: ${key}`);
      }
   }
}

async function exportTiltLoop(onProgress, uiState, runtime) {
   if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      return false;
   }
   if (!uiState) {
      throw new Error('Exporter UI state unavailable.');
   }
   validateExporterRuntime(runtime);

   const { renderBundle } = runtime;
   if (!renderBundle) {
      throw new Error('No model loaded for export.');
   }

   const {
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
      packUniformDataForExport,
      clearTiltPrewarm,
      getAnimationState,
      setAnimationState,
      constants,
   } = runtime;

   const {
      TILT_PRERENDER_SAMPLE_FPS,
      TILT_ANIM_CYCLE_SEC,
      STONE_MARGIN_SCALE,
   } = constants;

   const reportProgress = (progress, statusText = '') => {
      onProgress?.(progress, statusText);
   };

   const exportLoopCount = 3;
   const RENDER_PROGRESS_START = 0.05;
   const RENDER_PROGRESS_END = 0.90;
   reportProgress(RENDER_PROGRESS_START, 'Preparing export…');

   // Export renders every frame directly to the export canvas; orientation
   // prewarm is for interactive viewport playback and only adds startup lag.
   clearTiltPrewarm();

   const prevAnimState = getAnimationState();

   const desiredExportFps = TILT_PRERENDER_SAMPLE_FPS;
   const exportQuality = getExportQualityPreset(uiState.exportQualityPx);
   const maxTexDim = device?.limits?.maxTextureDimension2D ?? exportQuality.maxLongEdge;
   const targetLongEdge = Math.min(exportQuality.maxLongEdge, maxTexDim);
   const exportSize = fitEvenSize(canvas.width, canvas.height, targetLongEdge);
   const targetBitrate = exportQuality.bitrate;
   reportProgress(RENDER_PROGRESS_START, `Rendering ${exportSize.width}×${exportSize.height} frames…`);
   const encoderSelection = await pickVideoEncoderConfig(
      exportSize.width,
      exportSize.height,
      desiredExportFps,
      targetBitrate,
   );
   if (!encoderSelection) {
      throw new Error('No supported H.264 profile/fps for this export size.');
   }
   const encoderConfig = encoderSelection.config;
   const exportFps = encoderSelection.framerate;
   reportProgress(
      RENDER_PROGRESS_START,
      `Rendering ${exportSize.width}×${exportSize.height} @ ${exportFps}fps · ${(encoderSelection.bitrate / 1_000_000).toFixed(1)} Mbps`,
   );

   const exportCanvas = document.createElement('canvas');
   exportCanvas.width = exportSize.width;
   exportCanvas.height = exportSize.height;
   const exportContext = exportCanvas.getContext('webgpu');
   if (!exportContext) return false;
   exportContext.configure({
      device,
      format: canvasFormat,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
   });
   const exportDepthTexture = device.createTexture({
      size: [exportCanvas.width, exportCanvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
   });

   const sampleData = [];
   const syncSampleNumbers = [];
   let avcDecoderDescription = null;
   let encodedChunkCount = 0;
   let renderedFrameCount = 0;

   const exportStartMs = performance.now();
   const formatDuration = (seconds) => {
      if (!isFinite(seconds) || seconds < 0) return '--:--';
      const totalSec = Math.max(0, Math.round(seconds));
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
   };

   const updateRenderStatus = (progress) => {
      const elapsedSec = Math.max(0.001, (performance.now() - exportStartMs) / 1000);
      const frameFrac = renderedFrames > 0 ? (renderedFrameCount / renderedFrames) : 0;
      const encodeFps = renderedFrameCount / elapsedSec;
      const etaSec = encodeFps > 0.001
         ? Math.max(0, (renderedFrames - renderedFrameCount) / encodeFps)
         : Infinity;
      const pct = Math.round(Math.max(0, Math.min(1, frameFrac)) * 100);
      reportProgress(
         progress,
         `Rendering frame ${renderedFrameCount}/${renderedFrames} (${pct}%) · ${encodeFps.toFixed(1)} fps · ETA ${formatDuration(etaSec)} · queue ${encoder.encodeQueueSize} · packets ${encodedChunkCount}`,
      );
   };

   const frameDurationUs = Math.round(1_000_000 / exportFps);
   const renderedLoopCount = 1;
   const renderedFrames = Math.max(1, Math.round(renderedLoopCount * TILT_ANIM_CYCLE_SEC * exportFps));

   const exportModelMat = mat4.create();
   const exportViewMat = mat4.create();
   const exportProjMat = mat4.create();
   const exportUniformScratch = new Float32Array(320 / 4);

   const encodeErrorState = { error: null };
   const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
         const out = new Uint8Array(chunk.byteLength);
         chunk.copyTo(out);
         sampleData.push(out);
         encodedChunkCount += 1;
         if (chunk.type === 'key') {
            syncSampleNumbers.push(sampleData.length);
         }
         const desc = metadata?.decoderConfig?.description;
         if (desc && !avcDecoderDescription) {
            avcDecoderDescription = new Uint8Array(desc.slice(0));
         }
      },
      error: (error) => {
         encodeErrorState.error = error;
      },
   });

   try {
      exportInProgress = true;
      setAnimationState({ ...prevAnimState, animating: false });
      // Reset tilt cycle
      encoder.configure(encoderConfig);

      const SENSOR_HALF = 5 * Math.tan(Math.PI / 8) * STONE_MARGIN_SCALE;
      const camDist = uiState.focalLength / 10;
      const isCircleTiltStyle = uiState.easingFuncName === 'circleClockwise';
      const baseCameraPos = [0, 0, camDist];
      mat4.lookAt(exportViewMat, baseCameraPos, [0, 0, 0], [0, 1, 0]);
      const exportFovY = 2 * Math.atan(SENSOR_HALF / camDist);
      mat4.perspective(exportProjMat, exportFovY, exportCanvas.width / exportCanvas.height, 0.1, 200.0);

      const baseRotX = quantizeOrientationAngle(currentRotX);
      const baseRotY = quantizeOrientationAngle(currentRotY);
      const ampRad = uiState.tiltAngleDeg * Math.PI / 180.0;
      const { bindGroup, vertexBuffer, triCount } = renderBundle;

      for (let frameIndex = 0; frameIndex < renderedFrames; frameIndex++) {
         if (encodeErrorState.error) throw encodeErrorState.error;

         const elapsed = (frameIndex / renderedFrames) * TILT_ANIM_CYCLE_SEC;
         const animSample = sampleTiltAnimation(elapsed, ampRad);
         const rotX = isCircleTiltStyle
            ? baseRotX
            : quantizeOrientationAngle(baseRotX + Math.min(Math.max(animSample.x, 0), ampRad));
         const rotY = isCircleTiltStyle
            ? baseRotY
            : quantizeOrientationAngle(baseRotY + Math.min(Math.max(animSample.y, 0), ampRad));

         mat4.identity(exportModelMat);
         mat4.rotateX(exportModelMat, exportModelMat, rotX);
         mat4.rotateY(exportModelMat, exportModelMat, rotY);

         const frameCameraPos = isCircleTiltStyle
            ? [
               camDist * Math.sin(ampRad) * Math.sin((elapsed / TILT_ANIM_CYCLE_SEC) * Math.PI * 2.0),
               -camDist * Math.sin(ampRad) * Math.cos((elapsed / TILT_ANIM_CYCLE_SEC) * Math.PI * 2.0),
               camDist * Math.cos(ampRad),
            ]
            : baseCameraPos;
         if (isCircleTiltStyle) {
            mat4.lookAt(exportViewMat, frameCameraPos, [0, 0, 0], [0, 1, 0]);
         }

         packUniformDataForExport(
            exportUniformScratch,
            exportModelMat,
            exportViewMat,
            exportProjMat,
            elapsed,
            uiState.lightMode,
            0.0,
            uiState.lightMode === 4 ? 1.0 : 0.0,
            frameCameraPos,
         );
         device.queue.writeBuffer(uniformBuffer, 0, exportUniformScratch);

         const commandEncoder = device.createCommandEncoder();
         const frameTexture = exportContext.getCurrentTexture();
         const bgColor = uiState.backgroundColor || [0.05, 0.05, 0.05];
         const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
               view: frameTexture.createView(),
               clearValue: { r: bgColor[0], g: bgColor[1], b: bgColor[2], a: 1.0 },
               loadOp: 'clear',
               storeOp: 'store',
            }],
            depthStencilAttachment: {
               view: exportDepthTexture.createView(),
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
         await device.queue.onSubmittedWorkDone();

         const vf = new VideoFrame(exportCanvas, {
            timestamp: frameIndex * frameDurationUs,
            duration: frameDurationUs,
         });
         const forceKeyframe = frameIndex === 0 || (frameIndex % exportFps) === 0;
         encoder.encode(vf, { keyFrame: forceKeyframe });
         vf.close();
         renderedFrameCount = frameIndex + 1;
         const frac = renderedFrameCount / renderedFrames;
         const progress = RENDER_PROGRESS_START + frac * (RENDER_PROGRESS_END - RENDER_PROGRESS_START);
         updateRenderStatus(progress);
      }

      const flushStartMs = performance.now();
      reportProgress(0.92, `Flushing encoder… queue ${encoder.encodeQueueSize} · packets ${encodedChunkCount}`);
      const flushPromise = encoder.flush();
      while (encoder.encodeQueueSize > 0) {
         const flushElapsedSec = Math.max(0.001, (performance.now() - flushStartMs) / 1000);
         reportProgress(
            0.92,
            `Flushing encoder… queue ${encoder.encodeQueueSize} · packets ${encodedChunkCount} · ${flushElapsedSec.toFixed(1)}s`,
         );
         await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await flushPromise;
      reportProgress(0.96, `Finalizing video… packets ${encodedChunkCount}`);
      if (!avcDecoderDescription || sampleData.length === 0) return false;

      const loopSampleData = sampleData;
      const loopSyncSampleNumbers = syncSampleNumbers.length > 0 ? syncSampleNumbers : [1];
      const repeatedSampleData = new Array(loopSampleData.length * exportLoopCount);
      const repeatedSyncSampleNumbers = [];
      for (let loopIndex = 0; loopIndex < exportLoopCount; loopIndex++) {
         const baseSample = loopIndex * loopSampleData.length;
         for (let i = 0; i < loopSampleData.length; i++) {
            repeatedSampleData[baseSample + i] = loopSampleData[i];
         }
         for (const syncSample of loopSyncSampleNumbers) {
            repeatedSyncSampleNumbers.push(baseSample + syncSample);
         }
      }

      const blob = makeMp4FromAvcSamples({
         width: exportCanvas.width,
         height: exportCanvas.height,
         timescale: 1_000_000,
         sampleDuration: frameDurationUs,
         sampleData: repeatedSampleData,
         syncSampleNumbers: repeatedSyncSampleNumbers,
         avcC: avcDecoderDescription,
      });
      if (blob.size === 0) return false;
      reportProgress(0.98, 'Saving file…');

      const baseName = makeExportBaseName(currentModelFilename);
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `${baseName}-tilt-${exportLoopCount}loops-${Date.now()}.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
      reportProgress(1.0, 'Export complete.');
      return true;
   } finally {
      try { encoder.close(); } catch { }
      exportDepthTexture.destroy();
      setAnimationState(prevAnimState);
      exportInProgress = false;
      requestRender();
   }
}

async function pickVideoEncoderConfig(width, height, fps, bitrate) {
   if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      return null;
   }
   const codecCandidates = [
      'avc1.640034',
      'avc1.640033',
      'avc1.640032',
      'avc1.640028',
      'avc1.4d4028',
      'avc1.4d401f',
      'avc1.42e01f',
   ];
   const fpsCandidates = Array.from(new Set([
      Math.max(1, Math.round(fps)),
      30,
      24,
   ]));
   const bitrateCandidates = Array.from(new Set([
      Math.max(600_000, Math.round(bitrate)),
      Math.max(600_000, Math.round(bitrate * 0.8)),
      Math.max(600_000, Math.round(bitrate * 0.65)),
   ]));

   for (const framerate of fpsCandidates) {
      for (const targetBitrate of bitrateCandidates) {
         for (const codec of codecCandidates) {
            const baseConfig = {
               codec,
               width,
               height,
               bitrate: targetBitrate,
               framerate,
               hardwareAcceleration: 'prefer-hardware',
               latencyMode: 'realtime',
               avc: { format: 'avc' },
            };
            try {
               const support = await VideoEncoder.isConfigSupported(baseConfig);
               if (support?.supported) {
                  return {
                     config: support.config,
                     framerate,
                     bitrate: targetBitrate,
                     codec,
                  };
               }
            } catch {
            }
         }
      }
   }
   return null;
}

function makeExportBaseName(filename) {
   const safe = String(filename || 'stone.gem')
      .trim()
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-');
   return safe || 'stone';
}

function fitEvenSize(width, height, targetLongEdge = 1280) {
   const srcW = Math.max(1, Math.floor(width));
   const srcH = Math.max(1, Math.floor(height));
   const target = Math.max(2, Math.floor(targetLongEdge));
   let outW = srcW >= srcH
      ? target
      : Math.max(2, Math.round(target * (srcW / srcH)));
   let outH = srcH > srcW
      ? target
      : Math.max(2, Math.round(target * (srcH / srcW)));
   if (outW % 2 !== 0) outW -= 1;
   if (outH % 2 !== 0) outH -= 1;
   return { width: Math.max(2, outW), height: Math.max(2, outH) };
}

function getExportQualityPreset(qualityPx) {
   return EXPORT_QUALITY_PRESETS[qualityPx] || EXPORT_QUALITY_PRESETS[1080];
}

export { exportInProgress, setupExporter };

import {
   buildStoneFromFacetDesign,
   buildDesignAscText,
   buildDesignGcsText,
   buildDesignGemBuffer,
   buildDesignStlBuffer,
   computeNormalFromPolar,
   groupExternalFacetsForDesign,
   normalizeDesignFacet,
   normalizeStoneToUnitSphere,
   stretchStoneByVertices,
   computeFacetNotesSummary,
} from '../loaders.js';

function el(id) {
   return document.getElementById(id);
}

function value(id, fallback = '') {
   return el(id)?.value ?? fallback;
}

function number(id, fallback = 0) {
   const next = Number.parseFloat(value(id));
   return Number.isFinite(next) ? next : fallback;
}

function setStatus(text) {
   const status = el('designStatus');
   if (status) status.textContent = text;
}

function escapeHtml(text) {
   const node = document.createElement('span');
   node.textContent = String(text ?? '');
   return node.innerHTML;
}

function download(name, content, type) {
   const url = URL.createObjectURL(new Blob([content], { type }));
   const anchor = document.createElement('a');
   anchor.href = url;
   anchor.download = name;
   anchor.click();
   URL.revokeObjectURL(url);
}

function writeNumber(id, result) {
   const output = el(id);
   if (output) output.value = Number.isFinite(result) ? result.toFixed(3) : '';
}

function meshWidth(stone) {
   const data = stone?.vertexData;
   if (!(data instanceof Float32Array)) return null;
   let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
   for (let i = 0; i + 2 < data.length; i += 7) {
      minX = Math.min(minX, data[i]); maxX = Math.max(maxX, data[i]);
      minY = Math.min(minY, data[i + 1]); maxY = Math.max(maxY, data[i + 1]);
   }
   const width = Math.min(maxX - minX, maxY - minY);
   return Number.isFinite(width) && width > 0 ? width : null;
}

function meshVolume(stone) {
   const data = stone?.vertexData;
   if (!(data instanceof Float32Array)) return null;
   let center = [0, 0, 0];
   let count = 0;
   for (let i = 0; i + 20 < data.length; i += 21) {
      for (const offset of [0, 7, 14]) {
         center[0] += data[i + offset];
         center[1] += data[i + offset + 1];
         center[2] += data[i + offset + 2];
         count++;
      }
   }
   if (!count) return null;
   center = center.map((component) => component / count);
   let volume = 0;
   for (let i = 0; i + 20 < data.length; i += 21) {
      let ax = data[i], ay = data[i + 1], az = data[i + 2];
      let bx = data[i + 7], by = data[i + 8], bz = data[i + 9];
      let cx = data[i + 14], cy = data[i + 15], cz = data[i + 16];
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (nx * ((ax + bx + cx) / 3 - center[0]) + ny * ((ay + by + cy) / 3 - center[1]) + nz * ((az + bz + cz) / 3 - center[2]) < 0) {
         [bx, cx] = [cx, bx];
         [by, cy] = [cy, by];
         [bz, cz] = [cz, bz];
      }
      volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
   }
   return Math.abs(volume / 6) || null;
}

/**
 * The facet authoring UI is independent of the drawing API.  Its only renderer
 * dependency is the app's setStone() hook, so an authored mesh follows the
 * exact same load path in WebGPU, WebGL, and software renderers.
 */
export function createFacetDesignController({ app, ui, overlay, onDesignChanged }) {
   if (!app?.setStone || !app?.getStone) throw new TypeError('Facet design requires setStone() and getStone().');

   let filename = 'design.gem';
   let facets = [];
   let selectedVertices = [];
   let applyTimer = null;
   let sourceStone = null;
   let disposed = false;
   const listeners = [];
   let history = [];
   let historyIndex = -1;

   const metadata = () => ({ title: value('designHeader'), comments: value('designFooter') });
   const gear = () => Math.max(1, Math.round(number('designGear', 96)));
   const definition = () => ({
      gear: gear(),
      refractiveIndex: ui.ri,
      facets: facets.map((facet, index) => normalizeDesignFacet(facet, index)),
      metadata: metadata(),
   });
   const snapshot = () => ({
      facets: facets.map((facet) => ({ ...facet })),
      header: value('designHeader'),
      footer: value('designFooter'),
   });
   const notify = () => onDesignChanged?.(definition());
   const commitHistory = () => {
      history.splice(historyIndex + 1);
      history.push(snapshot());
      historyIndex = history.length - 1;
   };
   const restoreHistory = (next) => {
      facets = next.facets.map((facet, index) => normalizeDesignFacet(facet, index));
      el('designHeader').value = next.header;
      el('designFooter').value = next.footer;
      renderList();
      notify();
      scheduleApply();
   };

   function renderList() {
      const root = el('designFacetList');
      if (!root) return;
      if (!facets.length) {
         root.innerHTML = '<div class="designFacetEmpty">No facets in design. Add from Create tab.</div>';
         return;
      }
      root.innerHTML = `<table class="designFacetTable"><colgroup>
         <col class="colPreview"><col class="colName"><col class="colSym"><col class="colMirror">
         <col class="colAngle"><col class="colStart"><col class="colDist"><col class="colInst"><col class="colDel">
      </colgroup><thead><tr>
         <th>Off</th><th>Name</th><th>Sym</th><th>Mirror</th><th>Angle</th><th>Index</th><th>Dist</th><th>Notes</th><th>Del</th>
      </tr></thead><tbody>${facets.map((facet, index) => `
         <tr data-id="${escapeHtml(facet.id)}">
            <td class="cellMirror"><label class="check"><input data-field="previewDisabled" type="checkbox" ${facet.previewDisabled ? 'checked' : ''}></label></td>
            <td class="cellName"><input data-field="name" type="text" value="${escapeHtml(facet.name || `F${index + 1}`)}"></td>
            <td class="cellNum"><input data-field="symmetry" type="number" min="1" max="96" step="1" value="${facet.symmetry}"></td>
            <td class="cellMirror"><label class="check"><input data-field="mirror" type="checkbox" ${facet.mirror ? 'checked' : ''}></label></td>
            <td class="cellNum"><input data-field="angleDeg" type="number" min="-90" max="90" step=".001" value="${Number(facet.angleDeg).toFixed(4)}"></td>
            <td class="cellNum"><input data-field="startIndex" type="number" min="0" max="360" step="1" value="${facet.startIndex}"></td>
            <td class="cellNum"><input data-field="distance" type="number" min="-5" max="5" step=".00001" value="${Number(facet.distance).toFixed(5)}"></td>
            <td class="cellInst"><input data-field="instructions" type="text" value="${escapeHtml(facet.instructions)}"></td>
            <td class="cellRemove"><button class="designFacetRemove" type="button" data-remove="${index}">X</button></td>
         </tr>`).join('')}</tbody></table>`;
   }

   function setStone(stone, status) {
      sourceStone = stone;
      app.setStone(filename, stone);
      overlay?.setModel(stone);
      app.requestGraphUpdate?.();
      app.requestRender?.();
      if (status) setStatus(status);
   }

   function applyDesign() {
      if (disposed) return;
      try {
         setStone(buildStoneFromFacetDesign(definition()), facets.length
            ? `Applied ${facets.length} design facets`
            : 'Applied default cube (no facets yet)');
      } catch (error) {
         setStatus(`Design failed: ${error?.message || 'invalid facets'}`);
      }
   }

   function scheduleApply() {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(applyDesign, 20);
   }

   function selectedVertex() {
      return selectedVertices.length === 1 ? selectedVertices[0] : null;
   }

   function autofillDistance() {
      const vertex = selectedVertex();
      if (!vertex) return;
      const normal = computeNormalFromPolar(number('designAngle', 90), number('designStartIndex', 0), gear(), 0);
      if (!normal) return;
      const distance = normal[0] * vertex[0] + normal[1] * vertex[1] + normal[2] * vertex[2];
      const input = el('designDistance');
      if (input) input.value = distance.toFixed(5);
   }

   function pivotFacetToSelectedVertex(facet, index) {
      const vertex = selectedVertex();
      if (!vertex) return facet;
      const count = gear();
      const wrap = (value) => ((Math.round(value) % count) + count) % count;
      const symmetry = Math.max(1, Math.round(Number(facet.symmetry) || 1));
      const indexes = new Set();
      for (let step = 0; step < symmetry; step++) {
         const indexAtStep = wrap(Number(facet.startIndex) + step * count / symmetry);
         indexes.add(indexAtStep);
         if (facet.mirror) indexes.add(wrap(count - indexAtStep));
      }
      const vertexIndex = wrap(Math.atan2(vertex[0], -vertex[1]) / (Math.PI * 2) * count);
      const circularDistance = (a, b) => Math.min(Math.abs(a - b), count - Math.abs(a - b));
      const selectedIndex = [...indexes].sort((a, b) => circularDistance(a, vertexIndex) - circularDistance(b, vertexIndex))[0];
      const normal = computeNormalFromPolar(facet.angleDeg, selectedIndex, count, 0);
      if (!normal) return facet;
      const distance = Math.abs(normal[0] * vertex[0] + normal[1] * vertex[1] + normal[2] * vertex[2]);
      return normalizeDesignFacet({
         ...facet,
         distance: Math.abs(Number(facet.angleDeg)) <= 1e-8 && Number(facet.distance) < 0 ? -distance : distance,
      }, index);
   }

   function addFacet() {
      autofillDistance();
      commitHistory();
      facets.push(normalizeDesignFacet({
         name: value('designName', `G${facets.length + 1}`),
         instructions: value('designInstructions'),
         symmetry: Math.max(1, Math.round(number('designSymmetry', 1))),
         mirror: Boolean(el('designMirror')?.checked),
         angleDeg: number('designAngle', 90),
         startIndex: Math.round(number('designStartIndex', 0)),
         distance: number('designDistance', .7),
      }, facets.length));
      const name = el('designName');
      if (name) name.value = name.value.replace(/(\d+)$/, (_, n) => String(Number(n) + 1)) || `G${facets.length + 1}`;
      renderList();
      notify();
      scheduleApply();
   }

   function syncFromStone(stone, nextFilename = filename) {
      filename = nextFilename || filename;
      sourceStone = stone;
      const nextGear = Number(stone?.sourceGear);
      if (Number.isFinite(nextGear) && nextGear > 0) {
         el('designGear').value = String(Math.round(nextGear));
         facets = groupExternalFacetsForDesign(stone.facets || [], Math.round(nextGear))
            .map((facet, index) => normalizeDesignFacet(facet, index));
      }
      if (stone?.metadata) {
         el('designHeader').value = stone.metadata.title || '';
         el('designFooter').value = stone.metadata.comments || '';
      }
      renderList();
      overlay?.setModel(stone);
      history = [snapshot()];
      historyIndex = 0;
      notify();
   }

   function scale(preview) {
      const base = sourceStone || app.getStone();
      if (!base) return;
      const crown = number('designCrownRatioSlider', 1);
      const pavilion = number('designPavilionRatioSlider', 1);
      let stone = base;
      if (Math.abs(crown - 1) > 1e-6) stone = stretchStoneByVertices(stone, crown, true);
      if (Math.abs(pavilion - 1) > 1e-6) stone = stretchStoneByVertices(stone, pavilion, false);
      setStone(stone, preview
         ? `Scale preview crown=${crown.toFixed(3)} pavilion=${pavilion.toFixed(3)}`
         : `Applied scales crown=${crown.toFixed(3)} pavilion=${pavilion.toFixed(3)}`);
      if (!preview) {
         sourceStone = stone;
         el('designCrownRatioSlider').value = '1';
         el('designPavilionRatioSlider').value = '1';
         updateScaleLabels();
         syncFromStone(stone, filename);
      }
   }

   function updateScaleLabels() {
      const crown = number('designCrownRatioSlider', 1);
      const pavilion = number('designPavilionRatioSlider', 1);
      if (el('designCrownRatio')) el('designCrownRatio').textContent = crown.toFixed(3);
      if (el('designPavilionRatio')) el('designPavilionRatio').textContent = pavilion.toFixed(3);
   }

   function refreshSizeCalculator() {
      const stone = app.getStone();
      const summary = computeFacetNotesSummary(stone);
      const driver = value('designSizeDriverType') === 'L' ? 'L' : 'W';
      const entered = number('designSizeDriverValue', NaN);
      const girdle = number('designSizeGValue', NaN);
      const status = el('designSizeCalcStatus');
      if (!summary?.lw || !(entered > 0) || !(girdle >= 0)) {
         for (const id of ['designSizeW', 'designSizeL', 'designSizeP', 'designSizeC', 'designSizeU', 'designSizeT', 'designSizeH', 'designSizeV', 'designSizeCt']) writeNumber(id, NaN);
         if (status) status.textContent = !summary?.lw ? 'Dimensions unavailable for current stone.' : 'Enter a positive W or L and non-negative G value.';
         return;
      }
      const width = driver === 'L' ? entered / summary.lw : entered;
      const result = {
         designSizeW: width,
         designSizeL: summary.lw * width,
         designSizeP: summary.pw * width,
         designSizeC: summary.cw * width,
         designSizeU: summary.uw * width,
         designSizeT: summary.tw * width,
         designSizeH: (summary.cw + summary.pw) * width + girdle,
      };
      const widthUnits = meshWidth(stone), volumeUnits = meshVolume(stone);
      const volume = widthUnits && volumeUnits ? volumeUnits * (width / widthUnits) ** 3 : NaN;
      result.designSizeV = volume;
      const sg = number('designSizeSgValue', NaN);
      result.designSizeCt = Number.isFinite(volume) && sg > 0 ? volume * sg / 200 : NaN;
      Object.entries(result).forEach(([id, result]) => writeNumber(id, result));
      if (status) status.textContent = `Solved from ${driver} = ${entered.toFixed(3)} mm`;
   }

   function recenter() {
      const stone = buildStoneFromFacetDesign(definition());
      const data = stone.vertexData;
      let min = Infinity, max = -Infinity;
      for (let i = 2; i < data.length; i += 7) { min = Math.min(min, data[i]); max = Math.max(max, data[i]); }
      const delta = -(min + max) / 2;
      facets = facets.map((facet, index) => {
         const normal = computeNormalFromPolar(facet.angleDeg, facet.startIndex, gear(), 0);
         return normalizeDesignFacet({ ...facet, distance: Number(facet.distance) + normal[2] * delta }, index);
      });
      renderList();
      scheduleApply();
      setStatus(`Recentered stone by z=${delta.toFixed(4)}`);
   }

   function save() {
      if (!facets.length) return setStatus('Add at least one facet before save.');
      const design = definition();
      const base = filename.replace(/\.[^.]+$/, '') || 'design';
      const extension = (filename.split('.').pop() || 'gem').toLowerCase();
      if (extension === 'asc') download(`${base}.asc`, buildDesignAscText(design), 'text/plain;charset=utf-8');
      else if (extension === 'gcs') download(`${base}.gcs`, buildDesignGcsText(design), 'application/xml');
      else if (extension === 'stl') download(`${base}.stl`, buildDesignStlBuffer(design), 'model/stl');
      else download(`${base}.gem`, buildDesignGemBuffer(design), 'application/octet-stream');
      setStatus(`Saved ${base}.${['asc', 'gcs', 'stl'].includes(extension) ? extension : 'gem'}`);
   }

   const listen = (target, type, handler) => {
      if (!target) return;
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
   };
   listen(el('designAddFacetBtn'), 'click', addFacet);
   listen(el('designClearBtn'), 'click', () => {
      commitHistory();
      facets = [];
      renderList();
      notify();
      scheduleApply();
   });
   listen(el('designRecenterBtn'), 'click', () => { try { recenter(); } catch (error) { setStatus(`Recenter failed: ${error.message}`); } });
   listen(el('designUnitSphereBtn'), 'click', () => {
      try { const stone = buildStoneFromFacetDesign(definition()); normalizeStoneToUnitSphere(stone); setStone(stone, 'Rescaled design to unit sphere.'); syncFromStone(stone, filename); }
      catch (error) { setStatus(`Unit-sphere rescale failed: ${error.message}`); }
   });
   listen(el('designSaveGemBtn'), 'click', save);
   for (const id of ['designGear', 'designAngle', 'designStartIndex', 'designSymmetry', 'designMirror']) {
      listen(el(id), id === 'designMirror' ? 'change' : 'input', autofillDistance);
   }
   for (const id of ['designHeader', 'designFooter']) listen(el(id), 'input', scheduleApply);
   for (const id of ['designSizeDriverType', 'designSizeDriverValue', 'designSizeGValue', 'designSizeSgValue']) {
      listen(el(id), id === 'designSizeDriverType' ? 'change' : 'input', refreshSizeCalculator);
   }
   for (const id of ['designCrownRatioSlider', 'designPavilionRatioSlider']) listen(el(id), 'input', () => { updateScaleLabels(); scale(true); });
   listen(el('designApplyScaleBtn'), 'click', () => scale(false));
   listen(el('designResetScaleBtn'), 'click', () => {
      el('designCrownRatioSlider').value = '1'; el('designPavilionRatioSlider').value = '1';
      updateScaleLabels(); if (sourceStone) setStone(sourceStone, 'Scale reset');
   });
   listen(el('designFacetList'), 'input', (event) => {
      const row = event.target.closest('tr[data-id]');
      const index = facets.findIndex((facet) => facet.id === row?.dataset.id);
      const field = event.target.dataset.field;
      if (index < 0 || !field) return;
      const next = { ...facets[index] };
      next[field] = field === 'mirror' || field === 'previewDisabled'
         ? Boolean(event.target.checked)
         : ['name', 'instructions'].includes(field) ? event.target.value : numberFromElement(event.target, next[field]);
      let normalized = normalizeDesignFacet(next, index);
      if (['angleDeg', 'startIndex', 'symmetry', 'mirror'].includes(field)) {
         normalized = pivotFacetToSelectedVertex(normalized, index);
         const distance = row.querySelector('[data-field="distance"]');
         if (distance) distance.value = Number(normalized.distance).toFixed(5);
      }
      if (!numberScrub?.active) commitHistory();
      facets[index] = normalized;
      notify();
      scheduleApply();
   });
   listen(el('designFacetList'), 'click', (event) => {
      const index = Number(event.target.closest('[data-remove]')?.dataset.remove);
      if (Number.isInteger(index)) {
         commitHistory();
         facets.splice(index, 1);
         renderList();
         notify();
         scheduleApply();
      }
      const row = event.target.closest('tr[data-id]');
      if (row && event.target.closest('[data-field="distance"]')) {
         const facetIndex = facets.findIndex((facet) => facet.id === row.dataset.id);
         if (facetIndex >= 0 && selectedVertex()) {
            facets[facetIndex] = pivotFacetToSelectedVertex(facets[facetIndex], facetIndex);
            row.querySelector('[data-field="distance"]').value = Number(facets[facetIndex].distance).toFixed(5);
            scheduleApply();
         }
      }
   });
   let numberScrub = null;
   listen(el('designFacetList'), 'pointerdown', (event) => {
      const input = event.target.closest('input[type="number"]');
      if (!input || event.button !== 0) return;
      const step = Number.parseFloat(input.step);
      numberScrub = {
         input,
         pointerId: event.pointerId,
         startX: event.clientX,
         startY: event.clientY,
         startValue: Number.parseFloat(input.value) || 0,
         step: Number.isFinite(step) && step > 0 ? step : 1,
         active: false,
         velocity: 0,
         historyRecorded: false,
      };
   });
   listen(el('designFacetList'), 'pointermove', (event) => {
      if (!numberScrub || event.pointerId !== numberScrub.pointerId) return;
      const dx = event.clientX - numberScrub.startX;
      const dy = event.clientY - numberScrub.startY;
      if (!numberScrub.active) {
         if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
         if (Math.abs(dy) > Math.abs(dx)) {
            numberScrub = null;
            return;
         }
         numberScrub.active = true;
         numberScrub.input.setPointerCapture(event.pointerId);
         commitHistory();
         numberScrub.historyRecorded = true;
      }
      event.preventDefault();
      const min = Number.parseFloat(numberScrub.input.min);
      const max = Number.parseFloat(numberScrub.input.max);
      numberScrub.velocity = numberScrub.velocity * .9 + dx * .1;
      let next = numberScrub.startValue
         + dx * numberScrub.step * Math.max(.1, .8 * Math.abs(numberScrub.velocity));
      if (Number.isFinite(min)) next = Math.max(min, next);
      if (Number.isFinite(max)) next = Math.min(max, next);
      const decimals = (String(numberScrub.step).split('.')[1] || '').length;
      numberScrub.input.value = next.toFixed(decimals);
      numberScrub.input.dispatchEvent(new Event('input', { bubbles: true }));
   });
   const endNumberScrub = (event) => {
      if (!numberScrub || event.pointerId !== numberScrub.pointerId) return;
      if (numberScrub.input.hasPointerCapture?.(event.pointerId)) numberScrub.input.releasePointerCapture(event.pointerId);
      numberScrub = null;
   };
   listen(el('designFacetList'), 'pointerup', endNumberScrub);
   listen(el('designFacetList'), 'pointercancel', endNumberScrub);
   let draggedFacetId = null;
   listen(el('designFacetList'), 'dragstart', (event) => {
      if (event.target.closest('input, select, textarea, button, label')) {
         event.preventDefault();
         return;
      }
      draggedFacetId = event.target.closest('tr[data-id]')?.dataset.id || null;
      event.dataTransfer.effectAllowed = 'move';
   });
   listen(el('designFacetList'), 'dragover', (event) => {
      if (draggedFacetId && event.target.closest('tr[data-id]')) event.preventDefault();
   });
   listen(el('designFacetList'), 'drop', (event) => {
      event.preventDefault();
      const targetId = event.target.closest('tr[data-id]')?.dataset.id;
      const from = facets.findIndex((facet) => facet.id === draggedFacetId);
      const to = facets.findIndex((facet) => facet.id === targetId);
      if (from >= 0 && to >= 0 && from !== to) {
         commitHistory();
         const [facet] = facets.splice(from, 1);
         facets.splice(to, 0, facet);
         renderList();
         notify();
         scheduleApply();
      }
      draggedFacetId = null;
   });

   updateScaleLabels();
   renderList();
   listen(window, 'keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && !(event.ctrlKey && key === 'y')) return;
      event.preventDefault();
      const target = (event.shiftKey || key === 'y') ? historyIndex + 1 : historyIndex - 1;
      if (target < 0 || target >= history.length) return;
      historyIndex = target;
      restoreHistory(history[historyIndex]);
   });
   return Object.freeze({
      onStoneLoaded: syncFromStone,
      onSelectionChanged(selection) {
         selectedVertices = selection.vertices || [];
         if (selectedVertices.length === 1) autofillDistance();
         const parts = [];
         if (selection.vertexIds?.length) parts.push(`${selection.vertexIds.length} vertex${selection.vertexIds.length === 1 ? '' : 'es'}`);
         if (selection.edgeIds?.length) parts.push(`${selection.edgeIds.length} edge${selection.edgeIds.length === 1 ? '' : 's'}`);
         setStatus(parts.length ? `Selected ${parts.join(', ')}` : 'Selection cleared');
      },
      dispose() {
         disposed = true;
         clearTimeout(applyTimer);
         listeners.splice(0).forEach((remove) => remove());
      },
      getDesignDefinition: definition,
   });
}

function numberFromElement(element, fallback) {
   const result = Number.parseFloat(element.value);
   return Number.isFinite(result) ? result : fallback;
}

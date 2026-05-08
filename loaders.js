"use strict";

import {
   isNegativeZero as geometryIsNegativeZero,
   isFlatFacetAngleDeg as geometryIsFlatFacetAngleDeg,
   resolveFlatFacetNormalZ as geometryResolveFlatFacetNormalZ,
   computeNormalFromPolar as geometryComputeNormalFromPolar,
   computeSignedFacetAngleDeg as geometryComputeSignedFacetAngleDeg,
   stretchStoneByVertices as geometryStretchStoneByVertices,
} from './geometry.js';
import CSG from './cgs/csg.js';

let XMLParser = null;

if (typeof window === 'undefined') {
   const { DOMParser } = await import('@xmldom/xmldom');
   XMLParser = DOMParser;
} else {
   XMLParser = window.DOMParser;
}

const TABLE_FACET_MAX_ANGLE_DEG = 1.5;
const EPS = 1e-9;
const VERTEX_EPS = 1e-6;
const FLAT_FACET_ANGLE_EPS_DEG = 1e-8;
const CONCAVE_TOOL_RADIUS = 2.5;
const CONCAVE_DEBUG_POINT_CLOUD_MAX_POINTS = 1200;

let concaveToolStone = null;
let concaveToolScale = 1;
let concaveToolLoadError = null;

function cloneArrayBufferView(view) {
   if (view instanceof ArrayBuffer) {
      return view.slice(0);
   }
   if (ArrayBuffer.isView(view)) {
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
   }
   throw new Error('Unsupported buffer type');
}

async function readConcaveToolBuffer() {
   if (typeof window === 'undefined') {
      const fs = await import('node:fs');
      const url = new URL('./tool_lp.stl', import.meta.url);
      const fileData = fs.readFileSync(url);
      return cloneArrayBufferView(fileData);
   }

   const response = await fetch('./tool_lp.stl');
   if (!response.ok) {
      throw new Error(`Failed to fetch tool_lp.stl (${response.status})`);
   }
   return response.arrayBuffer();
}

function measureToolRadialExtent(stone) {
   const data = stone?.vertexData;
   if (!(data instanceof Float32Array) || data.length < 3) return 1;
   let maxRadius = 0;
   for (let i = 0; i < data.length; i += 7) {
      const x = data[i + 0];
      const y = data[i + 1];
      const radius = Math.hypot(x, y);
      if (radius > maxRadius) maxRadius = radius;
   }
   return Math.max(1e-6, maxRadius);
}

async function initConcaveToolMesh() {
   try {
      const buffer = await readConcaveToolBuffer();
      concaveToolStone = await loadSTL(buffer);
      const toolRadius = measureToolRadialExtent(concaveToolStone);
      concaveToolScale = CONCAVE_TOOL_RADIUS / toolRadius;
   } catch (error) {
      concaveToolLoadError = error;
      console.warn('Concave tool mesh unavailable:', error);
   }
}

function isNegativeZero(value) {
   return geometryIsNegativeZero(value);
}

function isFlatFacetAngleDeg(angleDeg) {
   return geometryIsFlatFacetAngleDeg(angleDeg);
}

function resolveFlatFacetNormalZ(angleDeg, distance) {
   return geometryResolveFlatFacetNormalZ(angleDeg, distance);
}

class StoneData {
   constructor(vertexData, triangleCount, facets = [], refractiveIndex = null, dispersion = null, sourceGear, metadata = {}) {
      this.vertexData = vertexData;
      this.triangleCount = triangleCount;
      this.facets = facets;
      this.refractiveIndex = refractiveIndex;
      this.dispersion = dispersion;
      this.sourceGear = sourceGear;
      this.metadata = metadata;
      // console.debug('StoneData created:', this);
   }
}

async function loadSTL(buffer) {

   const countView = new DataView(buffer, 80, 4);
   const triangleCount = countView.getUint32(0, true);

   const entrySize = 50;
   const verticesPerTriangle = 3;
   const floatsPerVertex = 7;

   const vertexData = new Float32Array(triangleCount * verticesPerTriangle * floatsPerVertex);
   const dataView = new DataView(buffer, 84);

   for (let i = 0; i < triangleCount; i++) {
      const offset = i * entrySize;
      const nx = dataView.getFloat32(offset + 0, true);
      const ny = dataView.getFloat32(offset + 4, true);
      const nz = dataView.getFloat32(offset + 8, true);

      for (let v = 0; v < 3; v++) {
         const vOffset = offset + 12 + (v * 12);
         const writeIdx = (i * 3 + v) * floatsPerVertex;
         vertexData[writeIdx + 0] = dataView.getFloat32(vOffset + 0, true);
         vertexData[writeIdx + 1] = dataView.getFloat32(vOffset + 4, true);
         vertexData[writeIdx + 2] = dataView.getFloat32(vOffset + 8, true);
         vertexData[writeIdx + 3] = nx;
         vertexData[writeIdx + 4] = ny;
         vertexData[writeIdx + 5] = nz;
         vertexData[writeIdx + 6] = 0.0;
      }
   }

   return new StoneData(vertexData, triangleCount);
}

await initConcaveToolMesh();

function normalizeFacetMetadata(name, instructions) {
   const rawName = String(name || '').trim();
   const rawInstructions = String(instructions || '').trim();
   const hasFrostedInstruction = /\bfrosted\b/i.test(rawInstructions);
   const trailingFMatch = rawName.match(/^(.*\d)f$/i);
   const normalizedName = trailingFMatch ? trailingFMatch[1] : rawName;
   const frosted = hasFrostedInstruction || Boolean(trailingFMatch);
   const normalizedInstructions = frosted && !hasFrostedInstruction
      ? (rawInstructions ? `${rawInstructions} FROSTED` : 'FROSTED')
      : rawInstructions;
   return {
      name: normalizedName,
      instructions: normalizedInstructions,
      frosted,
   };
}

// ---------------------------------------------------------------------------
// GemCut Studio .gcs XML format loader
//
// Structure:
//   <GemCutStudio version="...">
//     <index gear="..." symmetry="..." mirror="..."/>
//     <tier angle="..." depth="..." name="T1" instructions="..." ...>
//       <facet nx="..." ny="..." nz="..." index_angle="...">
//         <vertex x="..." y="..." z="..."/>
//         ...
//       </facet>
//       ...
//     </tier>
//     ...
//     <render material="..." refractive_index="1.76" dispersion="0.044" ...>
//       <color r="1" g="1" b="1"/>
//     </render>
//   </GemCutStudio>
//
// Vertices are pre-computed — no plane intersection needed.
// Facets with < 3 vertices are skipped. Fan triangulation from vertex 0.
// Y axis uses the same coordinate convention as the renderer (Z = table = up).
// ---------------------------------------------------------------------------
async function loadGCS(data) {
   const decoder = new TextDecoder('utf-8');
   const text = decoder.decode(data);
   const parser = new XMLParser();
   const doc = parser.parseFromString(text, 'application/xml');
   let metadata = {};

   if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('GCS: XML parse error');
   }

   // Refractive index + dispersion
   let refractiveIndex = 1.76;
   let dispersion = 0.044;
   const renderEl = doc.getElementsByTagName('render')[0];
   if (renderEl) {
      const ri = parseFloat(renderEl.getAttribute('refractive_index'));
      if (isFinite(ri)) refractiveIndex = ri;
      const disp = parseFloat(renderEl.getAttribute('dispersion'));
      if (isFinite(disp)) dispersion = disp;
   }

   const infoEl = doc.getElementsByTagName('info')[0];
   if (infoEl) {
      const title = infoEl.getAttribute('title') || '';
      const author = infoEl.getAttribute('author') || '';
      const date = infoEl.getAttribute('date') || '';
      const header2 = infoEl.getAttribute('header2') || '';
      const riMin = parseFloat(infoEl.getAttribute('ri_min'));
      const riMax = parseFloat(infoEl.getAttribute('ri_max'));
      const sizeMin = parseFloat(infoEl.getAttribute('size_min'));
      const sizeMax = parseFloat(infoEl.getAttribute('size_max'));
      const shape = infoEl.getAttribute('shape') || '';
      const footer1 = infoEl.getAttribute('footer1') || '';
      const footer2 = infoEl.getAttribute('footer2') || '';
      const header = [title, author, date, header2].filter(s => s).join('\n');
      const comments = [footer1, footer2].filter(s => s).join('\n');

      if (header) metadata.title = header;
      if (comments) metadata.comments = comments;
      if (shape) metadata.shape = shape;
      if (footer1 || footer2) metadata.comments = [footer1, footer2].filter(s => s).join('\n');
      if (isFinite(riMin) && isFinite(riMax)) metadata.riRange = [riMin, riMax];
      if (isFinite(sizeMin) && isFinite(sizeMax)) metadata.sizeRange = [sizeMin, sizeMax];
   }


   const sourceGear = parseInt(doc.getElementsByTagName('index')[0]?.getAttribute('gear'), 10);

   const floatsPerVertex = 7;
   const triangles = [];
   const facets = [];

   for (const tierEl of doc.getElementsByTagName('tier')) {
      const tierName = (tierEl.getAttribute('name') || '').trim();
      const tierInst = (tierEl.getAttribute('instructions') || '').trim();

      for (const facetEl of tierEl.getElementsByTagName('facet')) {
         const nx = parseFloat(facetEl.getAttribute('nx') || '0');
         const ny = parseFloat(facetEl.getAttribute('ny') || '0');
         const nz = parseFloat(facetEl.getAttribute('nz') || '0');
         // Re-normalise (tiny floating-point noise in source)
         const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
         const normal = [nx / len, ny / len, nz / len];

         const vertEls = facetEl.getElementsByTagName('vertex');
         if (vertEls.length < 3) continue;

         // GCS vertices are in CW order from outside — swap v1↔v2 in the fan
         // to restore CCW (front-face) winding. No Y-flip needed: GCS uses the
         // same coordinate convention as the renderer (Z = table = up).
         const verts = Array.from(vertEls).map(v => [
            parseFloat(v.getAttribute('x') || '0'),
            parseFloat(v.getAttribute('y') || '0'),
            parseFloat(v.getAttribute('z') || '0'),
         ]);
         const planeDistanceSamples = verts.map(([x, y, z]) => x * normal[0] + y * normal[1] + z * normal[2]);
         const finitePlaneDistanceSamples = planeDistanceSamples.filter((value) => Number.isFinite(value));
         const meanPlaneDistance = finitePlaneDistanceSamples.length
            ? (finitePlaneDistanceSamples.reduce((sum, value) => sum + value, 0) / finitePlaneDistanceSamples.length)
            : null;
         const facetDistance = Number.isFinite(meanPlaneDistance) ? Math.abs(meanPlaneDistance) : null;

         const normalized = normalizeFacetMetadata(tierName, tierInst);

         const triangleCount = verts.length - 2;
         facets.push({
            name: normalized.name,
            instructions: normalized.instructions,
            frosted: normalized.frosted,
            normal,
            d: facetDistance,
            vertexCount: verts.length,
            triangleCount,
         });

         // GCS vertices are listed CW from outside; swap v1↔v2 to get CCW (front face).
         for (let i = 1; i < verts.length - 1; i++) {
            triangles.push({
               v0: verts[0],
               v1: verts[i + 1], // swapped
               v2: verts[i],     // swapped
               normal,
               frosted: normalized.frosted,
            });
         }
      }
   }

   const triCount = triangles.length;
   const vertexData = new Float32Array(triCount * 3 * floatsPerVertex);

   for (let i = 0; i < triCount; i++) {
      const { v0, v1, v2, normal, frosted } = triangles[i];
      const vs = [v0, v1, v2];
      for (let v = 0; v < 3; v++) {
         const idx = (i * 3 + v) * floatsPerVertex;
         vertexData[idx + 0] = vs[v][0];
         vertexData[idx + 1] = vs[v][1];
         vertexData[idx + 2] = vs[v][2];
         vertexData[idx + 3] = normal[0];
         vertexData[idx + 4] = normal[1];
         vertexData[idx + 5] = normal[2];
         vertexData[idx + 6] = frosted ? 1.0 : 0.0;
      }
   }

   return new StoneData(vertexData, triCount, facets, refractiveIndex, dispersion, sourceGear, metadata);
}

function buildFacetInfo(stone, summary = null) {
   if (!stone || !stone.facets || stone.facets.length === 0) {
      return '<div class="facetEmpty">No facet notes were found for this model.</div>';
   }
   const facets = stone.facets.filter((facet) => {
      const tag = String(facet?.instructions || '').trim().toUpperCase();
      return tag !== 'BOOTSTRAP';
   });
   if (!facets.length) {
      return '<div class="facetEmpty">No facet notes were found for this model.</div>';
   }

   function escapeHtml(text) {
      return String(text)
         .replaceAll('&', '&amp;')
         .replaceAll('<', '&lt;')
         .replaceAll('>', '&gt;')
         .replaceAll('"', '&quot;')
         .replaceAll('\n', '<br>')
         .replaceAll("'", '&#39;');
   }

   if (!summary) {
      summary = computeFacetNotesSummary(stone);
   }
   if (!summary) {
      summary = {
         lw: 0,
         pw: 0,
         cw: 0,
         uw: 0,
         tw: 0,
         gearUsed: Number.isFinite(parseInt(stone?.sourceGear, 10)) ? parseInt(stone.sourceGear, 10) : 96,
      };
   }
   const groupedSections = groupFacetInfo(facets, summary.gearUsed);
   const sectionOrder = ['PAVILION', 'CROWN', 'OTHER'];
   const html = [];

   for (const sectionName of sectionOrder) {
      const entries = groupedSections.get(sectionName) || [];
      if (!entries.length) continue;

      html.push(`
            <div class="facetSection">
               <div class="facetSectionTitle">${sectionName}</div>
               ${entries.map((entry) => {
         const instruction = entry.instructions ? escapeHtml(entry.instructions) : '—';
         return `
                     <div class="facetGroup">
                        <div class="facetGroupName">${escapeHtml(entry.name)}</div>
                        <div class="facetGroupAngle">${escapeHtml(entry.angleLabel)}</div>
                        <div class="facetGroupIndexes">${escapeHtml(formatFacetIndexLines(entry.indexes))}</div>
                        <div class="facetGroupInst">${instruction}</div>
                     </div>
                  `;
      }).join('')}
            </div>
         `);
   }

   const displayedGirdleCount = facets.filter((facet) => isGirdleFacet(facet)).length;
   const displayedTotalCount = facets.length;
   const displayedNonGirdleCount = Math.max(0, displayedTotalCount - displayedGirdleCount);

   const summaryHtml = `
<div class="facetSummaryCompact">
<div class="facetSectionTitle" style="width:100%">STONE INFO</div>
<span><strong>L/W</strong> ${escapeHtml(summary.lw.toFixed(4))}</span>
<span><strong>P/W</strong> ${escapeHtml(summary.pw.toFixed(4))}</span>
<span><strong>C/W</strong> ${escapeHtml(summary.cw.toFixed(4))}</span>
<span><strong>U/W</strong> ${escapeHtml(summary.uw.toFixed(4))}</span>
<span><strong>T/W</strong> ${escapeHtml(summary.tw.toFixed(4))}</span>
<span><strong>Gear</strong> ${escapeHtml(String(summary.gearUsed))}</span>
<span><strong>Facets</strong> ${escapeHtml(`${displayedNonGirdleCount}+${displayedGirdleCount}=${displayedTotalCount}`)}</span>
</div>`;

   const header = stone.metadata?.title ? `
<div class="facetSummaryCompact">
<div class="facetSectionTitle" style="width:100%">DESCRIPTION</div>
<div class="facetHeader">${escapeHtml(stone.metadata.title)}</div>
</div>` : '';
   const comments = stone.metadata?.comments ? `
<div class="facetSummaryCompact facetSummeryComments">
<div class="facetSectionTitle" style="width:100%">NOTES</div>
<div class="facetComments">${escapeHtml(stone.metadata.comments)}</div>
</div>` : '';

   return (header + summaryHtml + html.join('') + comments) || '<div class="facetEmpty">No facet notes were found for this model.</div>';
}

function convertGCSTextToGEMBuffer(gcsText) {
   const parser = new XMLParser();
   const doc = parser.parseFromString(String(gcsText || ''), 'application/xml');
   if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('GCS: XML parse error');
   }

   class BinaryWriter {
      constructor(initialSize = 1024) {
         this.buffer = new ArrayBuffer(initialSize);
         this.view = new DataView(this.buffer);
         this.offset = 0;
      }

      ensure(size) {
         if (this.offset + size <= this.buffer.byteLength) return;
         let nextSize = this.buffer.byteLength;
         while (this.offset + size > nextSize) nextSize *= 2;
         const nextBuffer = new ArrayBuffer(nextSize);
         new Uint8Array(nextBuffer).set(new Uint8Array(this.buffer));
         this.buffer = nextBuffer;
         this.view = new DataView(this.buffer);
      }

      writeFloat64(v) {
         this.ensure(8);
         this.view.setFloat64(this.offset, v, true);
         this.offset += 8;
      }

      writeInt32(v) {
         this.ensure(4);
         this.view.setInt32(this.offset, v, true);
         this.offset += 4;
      }

      writeUint8(v) {
         this.ensure(1);
         this.view.setUint8(this.offset, v);
         this.offset += 1;
      }

      writeBytes(bytes) {
         this.ensure(bytes.length);
         new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
         this.offset += bytes.length;
      }

      finish() {
         return this.buffer.slice(0, this.offset);
      }
   }

   const writer = new BinaryWriter();
   const encoder = new TextEncoder();
   const SILLY = -99999.0;

   const indexEl = doc.getElementsByTagName('index')[0];
   const symmetry = parseInt(indexEl?.getAttribute('symmetry') || '0', 10) || 0;
   const mirror = parseInt(indexEl?.getAttribute('mirror') || '0', 10) || 0;
   const gear = parseInt(indexEl?.getAttribute('gear') || '0', 10) || 0;

   const metadata = {};
   const infoEl = doc.getElementsByTagName('info')[0];
   if (infoEl) {
      const title = infoEl.getAttribute('title') || '';
      const author = infoEl.getAttribute('author') || '';
      const date = infoEl.getAttribute('date') || '';
      const header2 = infoEl.getAttribute('header2') || '';
      const footer1 = infoEl.getAttribute('footer1') || '';
      const footer2 = infoEl.getAttribute('footer2') || '';
      const header = [title, author, date, header2].filter(s => s).join('\n');
      const comments = [footer1, footer2].filter(s => s).join('\n');

      if (header) metadata.title = header;
      if (comments) metadata.comments = comments;
   }

   let refractiveIndex = 1.76;
   const renderEl = doc.getElementsByTagName('render')[0];
   if (renderEl) {
      const ri = parseFloat(renderEl.getAttribute('refractive_index'));
      if (isFinite(ri)) refractiveIndex = ri;
   }

   for (const tierEl of doc.getElementsByTagName('tier')) {
      const tierName = (tierEl.getAttribute('name') || '').trim();
      const tierInst = (tierEl.getAttribute('instructions') || '').trim();
      const normalizedTier = normalizeFacetMetadata(tierName, tierInst);

      for (const facetEl of tierEl.getElementsByTagName('facet')) {
         const vertEls = Array.from(facetEl.getElementsByTagName('vertex'));
         if (vertEls.length < 3) continue;

         const verts = vertEls.map((v) => [
            parseFloat(v.getAttribute('x') || '0'),
            parseFloat(v.getAttribute('y') || '0'),
            parseFloat(v.getAttribute('z') || '0'),
         ]);

         let nx = parseFloat(facetEl.getAttribute('nx') || '0');
         let ny = parseFloat(facetEl.getAttribute('ny') || '0');
         let nz = parseFloat(facetEl.getAttribute('nz') || '0');
         const nLen = Math.hypot(nx, ny, nz);
         if (!isFinite(nLen) || nLen < EPS) continue;
         nx /= nLen;
         ny /= nLen;
         nz /= nLen;

         let cx = 0;
         let cy = 0;
         let cz = 0;
         for (const [x, y, z] of verts) {
            cx += x;
            cy += y;
            cz += z;
         }
         cx /= verts.length;
         cy /= verts.length;
         cz /= verts.length;

         let d0 = nx * cx + ny * cy + nz * cz;
         if (d0 < 0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
            d0 = -d0;
         }
         if (!isFinite(d0) || d0 < EPS) continue;

         const rawLen = 0.9 / d0;
         const aRaw = nx * rawLen;
         const bRaw = ny * rawLen;
         const cRaw = nz * rawLen;

         writer.writeFloat64(aRaw);
         // Flip Y component of the normal to match Y-flipped vertices
         writer.writeFloat64(-bRaw);
         writer.writeFloat64(cRaw);
         writer.writeInt32(0);

         const labelParts = [];
         if (normalizedTier.name) labelParts.push(normalizedTier.name);
         let label = labelParts.join('');
         if (normalizedTier.instructions) label = `${label}\t${normalizedTier.instructions}`;
         const labelBytes = encoder.encode(label);
         const safeLabelBytes = labelBytes.length > 255 ? labelBytes.slice(0, 255) : labelBytes;
         writer.writeUint8(safeLabelBytes.length);
         writer.writeBytes(safeLabelBytes);
         // console.log(`${label},${aRaw.toFixed(6)},${bRaw.toFixed(6)},${cRaw.toFixed(6)},${d0.toFixed(6)}`);

         for (const [x, y, z] of verts) {
            writer.writeInt32(1);
            writer.writeFloat64(x);
            // Flip Y axis when writing vertices
            writer.writeFloat64(-y);
            writer.writeFloat64(z);
         }
         writer.writeInt32(0);
      }
   }

   writer.writeFloat64(SILLY);
   writer.writeInt32(symmetry);
   writer.writeInt32(mirror);
   writer.writeInt32(gear);
   writer.writeFloat64(refractiveIndex);
   writer.writeInt32(0); // Gear offset

   function writeMetadata(string) {
      for (let j = 0; j < 4; j++) {
         const line = string[j] || '';
         const bytes = encoder.encode(line);
         const safeBytes = bytes.length > 255 ? bytes.slice(0, 255) : bytes;
         writer.writeUint8(safeBytes.length);
         if (safeBytes.length > 0) {
            writer.writeBytes(safeBytes);
         }
      }
   }

   const header = metadata.title ? metadata.title.split('\n') : [];
   const comments = metadata.comments ? metadata.comments.split('\n') : [];

   writeMetadata(header);
   writeMetadata(comments);

   return writer.finish();
}

function mirrorIndex(index, gear) {
   const idx = wrapGearIndex(index, gear);
   if (idx === gear) return gear;
   return wrapGearIndex(gear - idx, gear);
}


function intersect3Planes(p0, p1, p2) {
   const { a: a0, b: b0, c: c0, d: d0 } = p0;
   const { a: a1, b: b1, c: c1, d: d1 } = p1;
   const { a: a2, b: b2, c: c2, d: d2 } = p2;

   const det = a0 * (b1 * c2 - b2 * c1) - b0 * (a1 * c2 - a2 * c1) + c0 * (a1 * b2 - a2 * b1);
   if (Math.abs(det) < EPS) return null;

   const x = (d0 * (b1 * c2 - b2 * c1) - b0 * (d1 * c2 - d2 * c1) + c0 * (d1 * b2 - d2 * b1)) / det;
   const y = (a0 * (d1 * c2 - d2 * c1) - d0 * (a1 * c2 - a2 * c1) + c0 * (a1 * d2 - a2 * d1)) / det;
   const z = (a0 * (b1 * d2 - b2 * d1) - b0 * (a1 * d2 - a2 * d1) + d0 * (a1 * b2 - a2 * b1)) / det;
   return [x, y, z];
}

function insideAllPlanes(pt, planes) {
   const [x, y, z] = pt;
   for (const p of planes) {
      if (p.a * x + p.b * y + p.c * z > p.d + EPS) return false;
   }
   return true;
}

function orderFacetVerts(planeIdx, vindices, planes, allVerts) {
   if (vindices.length < 3) return vindices;
   const p = planes[planeIdx];
   const normal = [p.a, p.b, p.c];

   let cx = 0, cy = 0, cz = 0;
   for (const vi of vindices) {
      cx += allVerts[vi][0];
      cy += allVerts[vi][1];
      cz += allVerts[vi][2];
   }
   cx /= vindices.length;
   cy /= vindices.length;
   cz /= vindices.length;

   let t0 = [1, 0, 0];
   if (Math.abs(normal[0]) > 0.9) t0 = [0, 1, 0];
   const t1 = [
      normal[1] * t0[2] - normal[2] * t0[1],
      normal[2] * t0[0] - normal[0] * t0[2],
      normal[0] * t0[1] - normal[1] * t0[0],
   ];
   const tu = [
      t1[1] * normal[2] - t1[2] * normal[1],
      t1[2] * normal[0] - t1[0] * normal[2],
      t1[0] * normal[1] - t1[1] * normal[0],
   ];

   const angles = vindices.map(vi => {
      const dx = allVerts[vi][0] - cx;
      const dy = allVerts[vi][1] - cy;
      const dz = allVerts[vi][2] - cz;
      const u = dx * tu[0] + dy * tu[1] + dz * tu[2];
      const v = dx * t1[0] + dy * t1[1] + dz * t1[2];
      return { vi, angle: Math.atan2(v, u) };
   });

   angles.sort((a, b) => a.angle - b.angle);
   return angles.map(a => a.vi);
}

function createBootstrapCubePlanes(size = 1.0) {
   const d = Math.abs(size) || 1.0;
   return [
      { a: 1, b: 0, c: 0, d, name: 'PX', instructions: 'BOOTSTRAP', frosted: false },
      { a: -1, b: 0, c: 0, d, name: 'NX', instructions: 'BOOTSTRAP', frosted: false },
      { a: 0, b: 1, c: 0, d, name: 'PY', instructions: 'BOOTSTRAP', frosted: false },
      { a: 0, b: -1, c: 0, d, name: 'NY', instructions: 'BOOTSTRAP', frosted: false },
      { a: 0, b: 0, c: 1, d, name: 'PZ', instructions: 'BOOTSTRAP', frosted: false },
      { a: 0, b: 0, c: -1, d, name: 'NZ', instructions: 'BOOTSTRAP', frosted: false },
   ];
}

function buildStoneFromHalfSpacePlanes(planes, refractiveIndex = null, sourceGear, metadata = {}) {

   const allVerts = [];
   function addVertex(pt) {
      for (let i = 0; i < allVerts.length; i++) {
         const v = allVerts[i];
         if (Math.abs(v[0] - pt[0]) + Math.abs(v[1] - pt[1]) + Math.abs(v[2] - pt[2]) < VERTEX_EPS)
            return i;
      }
      allVerts.push(pt);
      return allVerts.length - 1;
   }

   const n = planes.length;
   const facetVerts = planes.map(() => []);

   for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
         for (let k = j + 1; k < n; k++) {
            const pt = intersect3Planes(planes[i], planes[j], planes[k]);
            if (!pt || !insideAllPlanes(pt, planes)) continue;
            const vi = addVertex(pt);
            for (const pi of [i, j, k]) {
               if (!facetVerts[pi].includes(vi)) facetVerts[pi].push(vi);
            }
         }
      }
   }

   const triangles = [];
   const facets = [];


   for (let pi = 0; pi < n; pi++) {
      const verts = orderFacetVerts(pi, facetVerts[pi], planes, allVerts);
      if (verts.length < 3) continue;

      const p = planes[pi];
      const triangleCount = verts.length - 2;
      facets.push({
         index: pi + 1,
         name: p.name || '',
         instructions: p.instructions || '',
         frosted: Boolean(p.frosted),
         normal: [p.a, p.b, p.c],
         d: p.d,
         vertexCount: verts.length,
         triangleCount,
      });

      for (let i = 1; i < verts.length - 1; i++) {
         triangles.push({
            v0: allVerts[verts[0]],
            v1: allVerts[verts[i]],
            v2: allVerts[verts[i + 1]],
            normal: [p.a, p.b, p.c],
            frosted: Boolean(p.frosted),
         });
      }
   }

   // Generate keys for facets without names
   let nameMap = new Map();
   let tiers = {
      'P': 0,
      'C': 0,
      'G': 0,
      'T': 0,
   };

   function getSection(angle) {
      if (Math.abs(angle) < TABLE_FACET_MAX_ANGLE_DEG) return 'T';
      if (Math.abs(angle) > 89) return 'G';
      if (angle > 0) return 'C';
      return 'P';
   }

   for (const facet of facets) {
      const key = makeKeyFromFacet(facet);
      const section = getSection(computeSignedFacetAngleDeg(facet.normal));
      if (!nameMap.has(key)) nameMap.set(key, `${section}${section === 'T' ? '' : ++tiers[section]}`);
   }
   for (const facet of facets) {
      const key = makeKeyFromFacet(facet);
      if (facet.name) continue;
      facet.name = nameMap.get(key);
   }


   const triCount = triangles.length;
   const floatsPerVertex = 7;
   const vertexData = new Float32Array(triCount * 3 * floatsPerVertex);

   for (let i = 0; i < triCount; i++) {
      const { v0, v1, v2, normal, frosted } = triangles[i];
      const vs = [v0, v1, v2];
      for (let v = 0; v < 3; v++) {
         const idx = (i * 3 + v) * floatsPerVertex;
         vertexData[idx + 0] = vs[v][0];
         vertexData[idx + 1] = vs[v][1];
         vertexData[idx + 2] = vs[v][2];
         vertexData[idx + 3] = normal[0];
         vertexData[idx + 4] = normal[1];
         vertexData[idx + 5] = normal[2];
         vertexData[idx + 6] = frosted ? 1.0 : 0.0;
      }
   }

   return new StoneData(vertexData, triCount, facets, refractiveIndex, null, sourceGear, metadata);
}

function stretchStoneByVertices(stone, scaleFactor, crown = true) {
   return geometryStretchStoneByVertices(stone, scaleFactor, crown, {
      isGirdleFacet,
      rebuildFromPlanes: (planes, refractiveIndex, sourceGear) => buildStoneFromHalfSpacePlanes(planes, refractiveIndex, sourceGear),
   });
}

const polarPlane = (angle, index, gear, gearOff = 0) => {
   const incl = angle * Math.PI / 180;
   const azi = (index - gearOff) * 2 * Math.PI / gear;
   let c = Math.cos(incl);
   let s = Math.sin(incl);
   if (angle < 0) {
      c *= -1;
      s *= -1;
   }
   const a = s * Math.sin(azi);
   const b = -s * Math.cos(azi);
   return [a, b, c];
};

async function loadASC(data) {
   const decoder = new TextDecoder('utf-8');
   const text = decoder.decode(data);

   // Pre-process: join continuation lines (lines that start with whitespace)
   // back onto the previous non-empty line. This handles the pc01006 pattern
   // where " G First" appears on its own line after an `a` line.
   const rawLines = text.split(/\r?\n/);
   const lines = [];
   for (const raw of rawLines) {
      // A continuation line starts with whitespace and is not blank
      if (raw.length > 0 && /^\s/.test(raw) && lines.length > 0) {
         lines[lines.length - 1] += ' ' + raw.trim();
      } else {
         lines.push(raw);
      }
   }

   let igear = 96;
   let gearOff = 0;
   let refractiveIndex = 1.54;

   const planes = [];
   let sawHeader = false;
   let metadata = {};

   for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (line.startsWith(';') || line.startsWith('#') || line.startsWith('//')) continue;

      const parts = line.split(/\s+/);
      if (!parts.length || !parts[0]) continue;

      // ── Header ──────────────────────────────────────────────────────────────
      if (!sawHeader) {
         if (parts[0] !== 'GemCad') throw new Error('ASC: missing GemCad header');
         sawHeader = true;
         continue;
      }

      const ch = parts[0];

      // ── g  gear <count> <offset> ────────────────────────────────────────────
      // Gear count may be negative (e.g. "g -64 32.0"); use Math.abs for igear.
      if (ch === 'g') {
         const raw = parseInt(parts[1], 10);
         if (isFinite(raw) && raw !== 0) igear = Math.abs(raw);
         const nextOff = parseFloat(parts[2]);
         if (isFinite(nextOff)) gearOff = nextOff;
         continue;
      }

      // ── I  refractive index ─────────────────────────────────────────────────
      if (ch === 'I') {
         const ri = parseFloat(parts[1]);
         if (isFinite(ri) && ri > 1.0) refractiveIndex = ri;
         continue;
      }

      // ── H / F / y  — title / footnote ──────────────────────────────────────
      if (ch === 'H') {
         if (!metadata.title) metadata.title = '';
         metadata.title += (metadata.title ? "\n" : "") + parts.slice(1).join(' ');
         continue;
      }

      if (ch === 'F') {
         if (!metadata.comments) metadata.comments = '';
         metadata.comments += (metadata.comments ? "\n" : "") + parts.slice(1).join(' ');
         continue;
      }

      // ──  y — symmetry — skip ───────────────────────────────────────────────
      if (ch === 'y') continue;

      // ── a  facet line ──────────────────────────────────────────────────────
      if (ch !== 'a') continue;

      const angle = parseFloat(parts[1]);
      const rho = parseFloat(parts[2]);
      if (!isFinite(angle) || !isFinite(rho)) continue;

      // Scan tokens from index 3 onwards, collecting:
      //   - numeric index tokens (before, between, or after name segments)
      //   - name (last `n <token>` pair wins, matching GemCad behaviour)
      //   - instructions (everything after the first `G` token)
      const gearIndices = [];  // all numeric gear index tokens
      let currentName = '';
      let instructions = '';
      let awaitingName = false;

      for (let i = 3; i < parts.length; i++) {
         const tok = parts[i];

         // `G` ends index/name scanning; everything after is the instruction text
         if (tok === 'G') {
            if (awaitingName) {
               currentName = tok;
               awaitingName = false;
               continue;
            }
            instructions = parts.slice(i + 1).join(' ');
            break;
         }

         // `n` signals that the very next token is a facet name
         if (tok === 'n') {
            awaitingName = true;
            continue;
         }

         if (awaitingName) {
            currentName = tok;
            awaitingName = false;
            continue;
         }

         // Numeric token — gear index (may be negative, e.g. -64)
         const idx = parseFloat(tok);
         if (isFinite(idx)) {
            gearIndices.push(idx);
         }
      }

      // Emit one half-space plane per gear index.
      // If there are no gear indices at all (e.g. `a 0.000000 0.201 96 n T`)
      // the single index is already consumed as part of rho — GemCad convention
      // is that `a <angle> <rho> <singleIndex> n <name>` with no further indices
      // still produces one plane.  Handle that by rechecking parts[3] when the
      // index list is empty after the scan.
      let indicesToProcess = gearIndices;
      if (indicesToProcess.length === 0) {
         // parts[3] might be the sole index that was skipped because we started
         // scanning at 3 but immediately hit 'n'.  Re-check explicitly.
         const sole = parseFloat(parts[3]);
         if (isFinite(sole) && parts[3] !== 'n' && parts[3] !== 'G') {
            indicesToProcess = [sole];
         } else {
            // e.g. `a 0.000000 0.418 64 n D` — index is parts[3], name skipped it
            // already handled above; just skip this plane.
            continue;
         }
      }

      for (const rawIdx of indicesToProcess) {
         // Negative indices are a GemCad notation for "offset by gearOff";
         // the physical position is the absolute value.
         const index = Math.abs(rawIdx);

         let normal;
         let d;

         if (isFlatFacetAngleDeg(angle)) {
            // Flat table / culet
            normal = [0, 0, resolveFlatFacetNormalZ(angle, rho)];
            d = Math.abs(rho);
         } else {
            normal = polarPlane(Math.abs(angle), index, igear);
            d = Math.abs(rho);
            // Negative angle → pavilion (below girdle) → flip Z
            if (angle < 0) normal[2] = -normal[2];
         }

         const len = Math.hypot(normal[0], normal[1], normal[2]);
         if (!isFinite(len) || len < 1e-9 || !isFinite(d) || Math.abs(d) <= 1e-12) continue;

         const normalizedFacet = normalizeFacetMetadata(currentName, instructions);
         planes.push({
            a: normal[0] / len,
            b: normal[1] / len,
            c: normal[2] / len,
            d,
            name: normalizedFacet.name,
            instructions: normalizedFacet.instructions,
            frosted: normalizedFacet.frosted,
         });
      }
   }

   if (!sawHeader) throw new Error('ASC: missing GemCad header');
   if (!planes.length) throw new Error('ASC: no facets found');

   return buildStoneFromHalfSpacePlanes(planes, refractiveIndex, igear, metadata);
}

function computeNormalFromPolar(angleDeg, index, gear, gearOffset = 0) {
   return geometryComputeNormalFromPolar(angleDeg, index, gear, gearOffset);
};

function isConcaveFacetInstructions(instructions) {
   return /\bconcave\b/i.test(String(instructions || ''));
}

function computeFacetIndexSet(facet, gear) {
   const symmetryValue = parseInt(facet?.symmetry, 10);
   const symmetry = Math.max(1, Number.isFinite(symmetryValue) ? symmetryValue : 1);
   const mirror = Boolean(facet?.mirror);
   const step = gear / symmetry;
   const indexSet = new Set();

   const explicitIndexes = Array.isArray(facet?.indexes)
      ? [...new Set(
         facet.indexes
            .map((value) => parseInt(value, 10))
            .filter((value) => Number.isFinite(value) && value >= 0)
            .map((value) => (value === 0 ? gear : value))
            .map((value) => wrapGearIndex(value, gear)),
      )]
      : [];

   if (explicitIndexes.length > 0) {
      explicitIndexes.forEach((value) => indexSet.add(value));
      return indexSet;
   }

   const startRaw = parseFloat(facet?.startIndex);
   const startIndex = Number.isFinite(startRaw) ? wrapGearIndex(startRaw, gear) : 1;
   for (let i = 0; i < symmetry; i++) {
      const offset = i * step;
      const primary = wrapGearIndex(startIndex + offset, gear);
      indexSet.add(primary);
      if (mirror) {
         indexSet.add(mirrorIndex(primary, gear));
      }
   }
   return indexSet;
}

function orientTriangleByNormal(p0, p1, p2, normal) {
   const ux = p1[0] - p0[0];
   const uy = p1[1] - p0[1];
   const uz = p1[2] - p0[2];
   const vx = p2[0] - p0[0];
   const vy = p2[1] - p0[1];
   const vz = p2[2] - p0[2];
   const cx = uy * vz - uz * vy;
   const cy = uz * vx - ux * vz;
   const cz = ux * vy - uy * vx;
   const dot = cx * normal[0] + cy * normal[1] + cz * normal[2];
   if (!Number.isFinite(dot) || dot >= 0) {
      return [p0, p1, p2];
   }
   return [p0, p2, p1];
}

function stoneDataToCSG(stone) {
   const polygons = [];
   const data = stone.vertexData;
   for (let tri = 0; tri < stone.triangleCount; tri++) {
      const base = tri * 21;
      const p0 = [data[base + 0], data[base + 1], data[base + 2]];
      const p1 = [data[base + 7], data[base + 8], data[base + 9]];
      const p2 = [data[base + 14], data[base + 15], data[base + 16]];
      const normal = [data[base + 3], data[base + 4], data[base + 5]];
      const [o0, o1, o2] = orientTriangleByNormal(p0, p1, p2, normal);

      const v0 = new CSG.Vertex(new CSG.Vector(o0), new CSG.Vector(normal));
      const v1 = new CSG.Vertex(new CSG.Vector(o1), new CSG.Vector(normal));
      const v2 = new CSG.Vertex(new CSG.Vector(o2), new CSG.Vector(normal));
      polygons.push(new CSG.Polygon([v0, v1, v2]));
   }
   return CSG.fromPolygons(polygons);
}

function computeTriangleArea(p0, p1, p2) {
   const ux = p1[0] - p0[0];
   const uy = p1[1] - p0[1];
   const uz = p1[2] - p0[2];
   const vx = p2[0] - p0[0];
   const vy = p2[1] - p0[1];
   const vz = p2[2] - p0[2];
   const cx = uy * vz - uz * vy;
   const cy = uz * vx - ux * vz;
   const cz = ux * vy - uy * vx;
   return 0.5 * Math.hypot(cx, cy, cz);
}

function stitchTinyBoundaryHoles(triangles, options = {}) {
   const weldTolerance = Number.isFinite(options.weldTolerance) ? options.weldTolerance : 1e-4;
   const areaTolerance = Number.isFinite(options.areaTolerance) ? options.areaTolerance : 1e-10;
   const maxHoleEdges = Number.isFinite(options.maxHoleEdges) ? options.maxHoleEdges : 24;
   const maxHolePerimeter = Number.isFinite(options.maxHolePerimeter) ? options.maxHolePerimeter : 0.2;

   const quant = (v) => Math.round(v / weldTolerance);
   const points = [];
   const pointMap = new Map();

   function pointKey(p) {
      return `${quant(p[0])}|${quant(p[1])}|${quant(p[2])}`;
   }

   function getPointIndex(p) {
      const key = pointKey(p);
      const existing = pointMap.get(key);
      if (existing !== undefined) return existing;
      const idx = points.length;
      points.push([p[0], p[1], p[2]]);
      pointMap.set(key, idx);
      return idx;
   }

   const triIdx = [];
   for (const tri of triangles) {
      const i0 = getPointIndex(tri[0]);
      const i1 = getPointIndex(tri[1]);
      const i2 = getPointIndex(tri[2]);
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      const area = computeTriangleArea(points[i0], points[i1], points[i2]);
      if (!Number.isFinite(area) || area <= areaTolerance) continue;
      triIdx.push([i0, i1, i2]);
   }

   const undirectedCounts = new Map();
   const directedBoundary = [];
   const makeUndirectedKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
   for (const [a, b, c] of triIdx) {
      const edges = [[a, b], [b, c], [c, a]];
      for (const [u, v] of edges) {
         const key = makeUndirectedKey(u, v);
         undirectedCounts.set(key, (undirectedCounts.get(key) || 0) + 1);
         directedBoundary.push([u, v, key]);
      }
   }

   const boundaryEdges = directedBoundary.filter(([, , key]) => undirectedCounts.get(key) === 1);
   const outgoing = new Map();
   boundaryEdges.forEach(([a, b], edgeId) => {
      if (!outgoing.has(a)) outgoing.set(a, []);
      outgoing.get(a).push({ b, edgeId });
   });

   const used = new Set();
   const loops = [];
   for (let i = 0; i < boundaryEdges.length; i++) {
      if (used.has(i)) continue;
      const [startA, startB] = boundaryEdges[i];
      const loop = [startA, startB];
      used.add(i);
      let current = startB;
      let guard = 0;
      while (guard++ < 2048) {
         const nextEdges = (outgoing.get(current) || []).filter((edge) => !used.has(edge.edgeId));
         if (!nextEdges.length) break;
         const next = nextEdges[0];
         used.add(next.edgeId);
         current = next.b;
         if (current === loop[0]) {
            loops.push(loop.slice());
            break;
         }
         if (loop.includes(current)) break;
         loop.push(current);
      }
   }

   let stitchedHoles = 0;
   for (const loop of loops) {
      if (loop.length < 3 || loop.length > maxHoleEdges) continue;

      let perimeter = 0;
      for (let i = 0; i < loop.length; i++) {
         const a = points[loop[i]];
         const b = points[loop[(i + 1) % loop.length]];
         perimeter += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      }
      if (!Number.isFinite(perimeter) || perimeter > maxHolePerimeter) continue;

      let cx = 0; let cy = 0; let cz = 0;
      for (const idx of loop) {
         cx += points[idx][0];
         cy += points[idx][1];
         cz += points[idx][2];
      }
      cx /= loop.length;
      cy /= loop.length;
      cz /= loop.length;
      const centerIdx = points.length;
      points.push([cx, cy, cz]);

      let nx = 0; let ny = 0; let nz = 0;
      for (let i = 0; i < loop.length; i++) {
         const p = points[loop[i]];
         const q = points[loop[(i + 1) % loop.length]];
         nx += (p[1] - q[1]) * (p[2] + q[2]);
         ny += (p[2] - q[2]) * (p[0] + q[0]);
         nz += (p[0] - q[0]) * (p[1] + q[1]);
      }
      const nLen = Math.hypot(nx, ny, nz);
      const loopNormal = nLen > 1e-10 ? [nx / nLen, ny / nLen, nz / nLen] : [0, 0, 1];

      for (let i = 0; i < loop.length; i++) {
         const a = loop[i];
         const b = loop[(i + 1) % loop.length];
         const pa = points[a];
         const pb = points[b];
         const pc = points[centerIdx];
         const [o0, o1, o2] = orientTriangleByNormal(pa, pb, pc, loopNormal);
         const i0 = getPointIndex(o0);
         const i1 = getPointIndex(o1);
         const i2 = getPointIndex(o2);
         if (i0 === i1 || i1 === i2 || i0 === i2) continue;
         const area = computeTriangleArea(points[i0], points[i1], points[i2]);
         if (!Number.isFinite(area) || area <= areaTolerance) continue;
         triIdx.push([i0, i1, i2]);
      }
      stitchedHoles += 1;
   }

   return { points, triIdx, stitchedHoles, boundaryEdges: boundaryEdges.length };
}

function csgToStoneData(csg, baseStone, sourceGear, metadata = {}) {
   const polygons = csg.toPolygons();
   const rawTriangles = [];

   for (const polygon of polygons) {
      const polyVertices = polygon?.vertices || [];
      if (polyVertices.length < 3) continue;

      let nx = Number(polygon?.plane?.normal?.x);
      let ny = Number(polygon?.plane?.normal?.y);
      let nz = Number(polygon?.plane?.normal?.z);
      let nLen = Math.hypot(nx, ny, nz);
      if (!Number.isFinite(nLen) || nLen < 1e-12) {
         const a = polyVertices[0].pos;
         const b = polyVertices[1].pos;
         const c = polyVertices[2].pos;
         const ux = b.x - a.x;
         const uy = b.y - a.y;
         const uz = b.z - a.z;
         const vx = c.x - a.x;
         const vy = c.y - a.y;
         const vz = c.z - a.z;
         nx = uy * vz - uz * vy;
         ny = uz * vx - ux * vz;
         nz = ux * vy - uy * vx;
         nLen = Math.hypot(nx, ny, nz);
      }
      if (!Number.isFinite(nLen) || nLen < 1e-12) continue;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;
      const faceNormal = [nx, ny, nz];

      for (let i = 1; i < polyVertices.length - 1; i++) {
         const v0 = polyVertices[0].pos;
         const v1 = polyVertices[i].pos;
         const v2 = polyVertices[i + 1].pos;
         const [o0, o1, o2] = orientTriangleByNormal(
            [v0.x, v0.y, v0.z],
            [v1.x, v1.y, v1.z],
            [v2.x, v2.y, v2.z],
            faceNormal,
         );
         rawTriangles.push([o0, o1, o2]);
      }
   }

    const stitched = stitchTinyBoundaryHoles(rawTriangles);
    if (stitched.stitchedHoles > 0) {
      console.log('[concave-csg] stitched tiny holes', {
         holes: stitched.stitchedHoles,
         boundaryEdges: stitched.boundaryEdges,
      });
   }

   const vertices = [];
   for (const [i0, i1, i2] of stitched.triIdx) {
      const p0 = stitched.points[i0];
      const p1 = stitched.points[i1];
      const p2 = stitched.points[i2];
      const ux = p1[0] - p0[0];
      const uy = p1[1] - p0[1];
      const uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0];
      const vy = p2[1] - p0[1];
      const vz = p2[2] - p0[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nLen = Math.hypot(nx, ny, nz);
      if (!Number.isFinite(nLen) || nLen < 1e-12) continue;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      vertices.push(p0[0], p0[1], p0[2], nx, ny, nz, 0);
      vertices.push(p1[0], p1[1], p1[2], nx, ny, nz, 0);
      vertices.push(p2[0], p2[1], p2[2], nx, ny, nz, 0);
   }

   const vertexData = new Float32Array(vertices);
   const triangleCount = Math.floor(vertexData.length / 21);

   return new StoneData(
      vertexData,
      triangleCount,
      Array.isArray(baseStone?.facets) ? baseStone.facets : [],
      baseStone?.refractiveIndex,
      baseStone?.dispersion,
      sourceGear,
      metadata,
   );
}

function transformedConcaveToolCSG(normal, centerDistance) {
   if (!concaveToolStone) {
      if (concaveToolLoadError) {
         throw new Error(`Concave tool load failed: ${concaveToolLoadError.message || concaveToolLoadError}`);
      }
      throw new Error('Concave tool mesh not loaded');
   }

   const frame = buildConcaveToolFrame(normal, centerDistance);
   const inwardY = frame.inwardY;
   const xAxis = frame.xAxis;
   const zAxis = frame.zAxis;
   const position = frame.position;

   const polygons = [];
   const data = concaveToolStone.vertexData;
   for (let tri = 0; tri < concaveToolStone.triangleCount; tri++) {
      const base = tri * 21;
      const transformed = [];

      for (let v = 0; v < 3; v++) {
         const p = base + v * 7;
         const lx = data[p + 0] * concaveToolScale;
         const ly = data[p + 1] * concaveToolScale;
         const lz = data[p + 2] * concaveToolScale;

         const wx = position[0] + xAxis[0] * lx + inwardY[0] * ly + zAxis[0] * lz;
         const wy = position[1] + xAxis[1] * lx + inwardY[1] * ly + zAxis[1] * lz;
         const wz = position[2] + xAxis[2] * lx + inwardY[2] * ly + zAxis[2] * lz;

         const lnx = data[p + 3];
         const lny = data[p + 4];
         const lnz = data[p + 5];
         let wnx = xAxis[0] * lnx + inwardY[0] * lny + zAxis[0] * lnz;
         let wny = xAxis[1] * lnx + inwardY[1] * lny + zAxis[1] * lnz;
         let wnz = xAxis[2] * lnx + inwardY[2] * lny + zAxis[2] * lnz;
         const nLen = Math.hypot(wnx, wny, wnz);
         if (nLen > 1e-8) {
            wnx /= nLen;
            wny /= nLen;
            wnz /= nLen;
         } else {
            wnx = 0;
            wny = 0;
            wnz = 1;
         }

         transformed.push({ pos: [wx, wy, wz], normal: [wnx, wny, wnz] });
      }

      const triNormal = transformed[0].normal;
      const [o0, o1, o2] = orientTriangleByNormal(
         transformed[0].pos,
         transformed[1].pos,
         transformed[2].pos,
         triNormal,
      );

      const v0 = new CSG.Vertex(new CSG.Vector(o0), new CSG.Vector(triNormal));
      const v1 = new CSG.Vertex(new CSG.Vector(o1), new CSG.Vector(triNormal));
      const v2 = new CSG.Vertex(new CSG.Vector(o2), new CSG.Vector(triNormal));

      polygons.push(new CSG.Polygon([v0, v1, v2]));
   }

   return CSG.fromPolygons(polygons);
}

function buildConcaveToolFrame(normal, centerDistance) {
   // Tool local +Y should point toward stone center.
   // The design facet normal is outward (center -> facet), so +Y aligns with +normal.
   const inwardY = [normal[0], normal[1], normal[2]];
   let xAxis = [-inwardY[1], inwardY[0], 0];
   let xLen = Math.hypot(xAxis[0], xAxis[1], xAxis[2]);
   if (!Number.isFinite(xLen) || xLen < 1e-8) {
      xAxis = [1, 0, 0];
      xLen = 1;
   }
   xAxis = [xAxis[0] / xLen, xAxis[1] / xLen, xAxis[2] / xLen];
   const zAxis = [
      inwardY[1] * xAxis[2] - inwardY[2] * xAxis[1],
      inwardY[2] * xAxis[0] - inwardY[0] * xAxis[2],
      inwardY[0] * xAxis[1] - inwardY[1] * xAxis[0],
   ];

   const position = [
      normal[0] * centerDistance,
      normal[1] * centerDistance,
      normal[2] * centerDistance,
   ];

   return { inwardY, xAxis, zAxis, position };
}

function transformedConcaveToolPointCloud(normal, centerDistance, maxPoints = CONCAVE_DEBUG_POINT_CLOUD_MAX_POINTS) {
   const frame = buildConcaveToolFrame(normal, centerDistance);
   const inwardY = frame.inwardY;
   const xAxis = frame.xAxis;
   const zAxis = frame.zAxis;
   const position = frame.position;
   const data = concaveToolStone?.vertexData;
   if (!(data instanceof Float32Array) || data.length < 7) return [];

   const totalVertices = Math.floor(data.length / 7);
   const target = Math.max(1, Math.floor(maxPoints));
   const strideVertices = Math.max(1, Math.ceil(totalVertices / target));

   const points = [];
   for (let i = 0, vi = 0; i < data.length; i += 7, vi++) {
      if ((vi % strideVertices) !== 0) continue;
      const lx = data[i + 0] * concaveToolScale;
      const ly = data[i + 1] * concaveToolScale;
      const lz = data[i + 2] * concaveToolScale;
      const wx = position[0] + xAxis[0] * lx + inwardY[0] * ly + zAxis[0] * lz;
      const wy = position[1] + xAxis[1] * lx + inwardY[1] * ly + zAxis[1] * lz;
      const wz = position[2] + xAxis[2] * lx + inwardY[2] * ly + zAxis[2] * lz;
      points.push([wx, wy, wz]);
      if (points.length >= target) break;
   }
   return points;
}

function csgBounds(csgSolid) {
   const polygons = csgSolid?.toPolygons?.() || [];
   let minX = Infinity; let minY = Infinity; let minZ = Infinity;
   let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
   let found = false;
   for (const polygon of polygons) {
      const verts = polygon?.vertices || [];
      for (const v of verts) {
         const x = Number(v?.pos?.x);
         const y = Number(v?.pos?.y);
         const z = Number(v?.pos?.z);
         if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
         found = true;
         if (x < minX) minX = x;
         if (y < minY) minY = y;
         if (z < minZ) minZ = z;
         if (x > maxX) maxX = x;
         if (y > maxY) maxY = y;
         if (z > maxZ) maxZ = z;
      }
   }
   if (!found) return null;
   return { minX, minY, minZ, maxX, maxY, maxZ };
}

function boundsOverlap(a, b) {
   if (!a || !b) return true;
   if (a.maxX < b.minX || b.maxX < a.minX) return false;
   if (a.maxY < b.minY || b.maxY < a.minY) return false;
   if (a.maxZ < b.minZ || b.maxZ < a.minZ) return false;
   return true;
}

function buildStoneFromFacetDesign(definition = {}) {
   const facets = Array.isArray(definition.facets) ? definition.facets : [];
   const ri = parseFloat(definition.refractiveIndex);
   const refractiveIndex = Number.isFinite(ri) && ri > 1.0 ? ri : 1.54;
   const gear = definition.gear;

   const planes = createBootstrapCubePlanes(1.0);

   const concaveCuts = [];

   facets.forEach((facet, idx) => {
      const facetName = String(facet?.name || `F${idx + 1}`).trim();
      const instructions = String(facet?.instructions || '').trim();
      const normalized = normalizeFacetMetadata(facetName, instructions);

      const angle = parseFloat(facet?.angleDeg);
      const angleDeg = Number.isFinite(angle) ? Math.max(-90.0, Math.min(90.0, angle)) : 0;

      const distanceRaw = parseFloat(facet?.distance);
      const distance = Number.isFinite(distanceRaw) ? distanceRaw : 1.0;
      const d = Math.max(1e-5, Math.abs(distance));
      const indexSet = computeFacetIndexSet(facet, gear);

      if (isConcaveFacetInstructions(normalized.instructions)) {
         for (const index of indexSet) {
            const normal = computeNormalFromPolar(angleDeg, index, gear, 0);
            const len = Math.hypot(normal[0], normal[1], normal[2]);
            if (!Number.isFinite(len) || len < 1e-9) continue;
            concaveCuts.push({
               normal: [normal[0] / len, normal[1] / len, normal[2] / len],
               distance: d,
               index,
               angleDeg,
               name: normalized.name,
            });
         }
         return;
      }

      if (isFlatFacetAngleDeg(angleDeg)) {
         const normal = [0, 0, resolveFlatFacetNormalZ(angleDeg, distance)];
         planes.push({
            a: normal[0],
            b: normal[1],
            c: normal[2],
            d,
            name: normalized.name,
            instructions: normalized.instructions,
            frosted: normalized.frosted,
         });
         return;
      }

      for (const index of indexSet) {
         let normal = computeNormalFromPolar(angleDeg, index, gear, 0);
         let planeD = d;
         const len = Math.hypot(normal[0], normal[1], normal[2]);
         if (!Number.isFinite(len) || len < 1e-9) continue;

         normal = [normal[0] / len, normal[1] / len, normal[2] / len];
         if (planeD < 0) {
            normal = [-normal[0], -normal[1], -normal[2]];
            planeD = -planeD;
         }

         planes.push({
            a: normal[0],
            b: normal[1],
            c: normal[2],
            d: planeD,
            name: normalized.name,
            instructions: normalized.instructions,
            frosted: normalized.frosted,
         });
      }
   });

   if (!planes.length) {
      throw new Error('Design: no facets defined');
   }

   const convexStone = buildStoneFromHalfSpacePlanes(planes, refractiveIndex, gear, definition.metadata || {});
   if (!concaveCuts.length) {
      convexStone.hasConcaveCutters = false;
      convexStone.renderConvexFacetMode = 1;
      convexStone.concaveDebugTools = [];
      return convexStone;
   }

   let csgStone = stoneDataToCSG(convexStone);
   let csgPolygonCount = csgStone.toPolygons().length;
   const basePolygonCount = csgPolygonCount;
   const baseStoneBounds = csgBounds(csgStone);
   const concaveDebugTools = [];
   console.groupCollapsed(`[concave-csg] facets=${concaveCuts.length} baseTriangles=${convexStone.triangleCount} basePolygons=${csgPolygonCount}`);
   const prevCsgEpsilon = CSG?.Plane?.EPSILON;
   if (Number.isFinite(prevCsgEpsilon)) {
      CSG.Plane.EPSILON = Math.max(prevCsgEpsilon, 5e-3);
   }
   try {
      for (const cut of concaveCuts) {
         const toolDistance = cut.distance + CONCAVE_TOOL_RADIUS;
         const position = [
            cut.normal[0] * toolDistance,
            cut.normal[1] * toolDistance,
            cut.normal[2] * toolDistance,
         ];
         concaveDebugTools.push({
            normal: [cut.normal[0], cut.normal[1], cut.normal[2]],
            position,
            radius: CONCAVE_TOOL_RADIUS,
            distance: cut.distance,
            toolDistance,
            facetIndex: cut.index,
            facetAngleDeg: cut.angleDeg,
            facetName: cut.name,
            pointCloud: transformedConcaveToolPointCloud(cut.normal, toolDistance),
         });

         if (concaveDebugTools.length <= 24) {
            console.log('[concave-csg] cutter', {
               i: concaveDebugTools.length,
               facet: cut.name,
               index: cut.index,
               angleDeg: Number(cut.angleDeg.toFixed(4)),
               distance: Number(cut.distance.toFixed(6)),
               toolDistance: Number(toolDistance.toFixed(6)),
               normal: cut.normal.map((v) => Number(v.toFixed(6))),
               position: position.map((v) => Number(v.toFixed(6))),
            });
         }

         const tool = transformedConcaveToolCSG(cut.normal, toolDistance);
         const toolBounds = csgBounds(tool);
         if (!boundsOverlap(baseStoneBounds, toolBounds)) {
            if (concaveDebugTools.length <= 24) {
               console.log('[concave-csg] skip (no bounds overlap)', {
                  i: concaveDebugTools.length,
               });
            }
            continue;
         }

         const toolPolygons = tool.toPolygons().length;
         const beforeSubtract = csgPolygonCount;
         csgStone = csgStone.subtract(tool);
         csgPolygonCount = csgStone.toPolygons().length;
         if (concaveDebugTools.length <= 24) {
            console.log('[concave-csg] subtract', {
               i: concaveDebugTools.length,
               polygonsBefore: beforeSubtract,
               toolPolygons,
               polygonsAfter: csgPolygonCount,
            });
         }
      }
   } finally {
      if (Number.isFinite(prevCsgEpsilon)) {
         CSG.Plane.EPSILON = prevCsgEpsilon;
      }
   }
   console.groupEnd();

   const result = csgToStoneData(csgStone, convexStone, gear, definition.metadata || {});
   result.hasConcaveCutters = true;
   result.renderConvexFacetMode = 0;
   result.concaveDebugTools = concaveDebugTools;
   result.concaveDebugSummary = {
      cutters: concaveDebugTools.length,
      baseTriangles: convexStone.triangleCount,
      resultTriangles: result.triangleCount,
      basePolygons: basePolygonCount,
      resultPolygons: csgPolygonCount,
   };
   if (!Number.isFinite(result.triangleCount) || result.triangleCount <= 0) {
      console.error('[concave-csg] result has no triangles after subtraction');
      const fallback = new StoneData(
         convexStone.vertexData,
         convexStone.triangleCount,
         Array.isArray(convexStone.facets) ? convexStone.facets : [],
         convexStone.refractiveIndex,
         convexStone.dispersion,
         convexStone.sourceGear,
         convexStone.metadata,
      );
      fallback.hasConcaveCutters = true;
      fallback.renderConvexFacetMode = 1;
      fallback.concaveDebugTools = concaveDebugTools;
      fallback.concaveDebugSummary = {
         ...result.concaveDebugSummary,
         fallbackToConvex: true,
      };
      return fallback;
   } else {
      console.log('[concave-csg] done', result.concaveDebugSummary);
   }
   return result;
}

// ---------------------------------------------------------------------------
// GemCad .gem binary format loader — derived from stone.cpp::readGemFile()
//
// The format is NOT a fixed-record binary. It is a flat stream of float64s:
//
//   FACET LOOP (repeat until sentinel):
//     a, b, c   — float64 * 3  (raw plane normal, NOT yet unit length)
//                 sentinel: a == -99999.0 ends the loop
//     int32     — 4 bytes, unused padding (read and discarded)
//     nameLen   — 1 byte: 0 = no name, else number of chars that follow
//     nameChars — nameLen bytes (tab-delimited: "name\tcutting_instructions")
//
//     VERTEX LOOP for this facet (repeat until tag != 1):
//       tag      — int32: 1 = vertex follows, anything else = end of vertices
//       x, y, z  — float64 * 3  (only present when tag == 1)
//
//   TAIL (optional, may be absent in older files):
//     nsym        — int32
//     mirror_sym  — int32  (0 or 1)
//     igear       — int32
//     r_i         — float64  ← refractive index
//
// Key insight from stone.cpp lines 1583-1647:
//   - a,b,c are read raw then normalised: len=sqrt(a²+b²+c²), d=0.9/len
//   - The normalised (a/len, b/len, c/len, d) defines a half-space: ax+by+cz=d
//   - Vertices are reconstructed by intersecting ALL combinations of 3 planes
//   - Each facet's vertices are the intersection points that satisfy ALL planes
//   - The vertex data in the file is ignored (it's a cache GemCad writes for
//     its own use); stone.cpp discards it too (reads but never stores x,y,z)
//
// So we must reconstruct vertices ourselves by plane intersection, exactly
// as stone.cpp::newFacet() does via half-space clipping of a convex hull.
// ---------------------------------------------------------------------------
async function loadGEM(buffer) {
   const view = new DataView(buffer);
   let offset = 0;
   const SILLY = -99999.0;
   const F64 = 8;
   const I32 = 4;

   // ── 1. Parse plane records ───────────────────────────────────────────────
   const planes = []; // each: { a, b, c, d, name, instructions }  (unit normal, d = 0.9/|abc|)

   function readFacetLabel(nameView) {
      const byteLength = nameView.byteLength;
      const bytes = new Uint8Array(nameView.buffer, nameView.byteOffset, byteLength);
      const str = new TextDecoder().decode(bytes);

      // match "name\tinstructions" with optional tab. If no tab, all goes to name and instructions is empty.
      const match = (/^([^\t]*)\t?(.*)$/).exec(str) || ['', '', ''];
      return {
         name: match[1].trim(),
         instructions: match[2].trim(),
      };
   }

   while (offset + F64 <= buffer.byteLength) {
      const a_raw = view.getFloat64(offset, true); offset += F64;
      if (a_raw === SILLY) break;

      if (offset + F64 * 2 > buffer.byteLength) break;
      const b_raw = view.getFloat64(offset, true); offset += F64;
      const c_raw = view.getFloat64(offset, true); offset += F64;

      const len = Math.sqrt(a_raw * a_raw + b_raw * b_raw + c_raw * c_raw);
      if (len === 0) continue; // zero-length normal, skip plane
      const angle = Math.acos(c_raw / len) * 180 / Math.PI;

      const plane = {
         a: a_raw / len,
         b: b_raw / len,
         c: c_raw / len,
         d: 0.9 / len,   // matches stone.cpp: d = 1/len * 0.9
         angleDeg: angle,
         name: '',
         instructions: '',
         frosted: false,
      };
      planes.push(plane);

      // discard the int32 pad
      offset += I32;

      // read name (1-byte length prefix)
      if (offset >= buffer.byteLength) break;
      const nameLen = view.getUint8(offset); offset += 1;
      const nameView = new DataView(buffer, offset, nameLen);
      if (nameLen > 0) {
         const label = readFacetLabel(nameView);
         const normalized = normalizeFacetMetadata(label.name, label.instructions);
         planes[planes.length - 1].name = normalized.name;
         planes[planes.length - 1].instructions = normalized.instructions;
         planes[planes.length - 1].frosted = normalized.frosted;
         offset += nameLen;
      }

      // skip cached vertex data: read int32 tags until tag != 1
      while (offset + I32 <= buffer.byteLength) {
         const tag = view.getInt32(offset, true); offset += I32;
         if (tag !== 1) break;
         offset += F64 * 3; // skip x, y, z
      }
   }

   // Find facets with a name and use that name for all planes that match the angle and d within epsilon. This is a heuristic to recover facet labels that some versions of GemCad omit from planes other than the first in a group of parallel planes.
   const NAMING_EPS = 1e-4;
   for (const p of planes) {
      if (!p.name) {
         for (const q of planes) {
            if (q.name && Math.abs(p.angleDeg - q.angleDeg) < NAMING_EPS && Math.abs(p.d - q.d) < NAMING_EPS) {
               p.name = q.name;
               p.instructions = q.instructions;
               p.frosted = q.frosted;
               break;
            }
         }
      }
   }

   // ── 2. Read optional tail ────────────────────────────────────────────────
   let refractiveIndex = 1.77; // default: corundum, reasonable fallback
   let sourceGear = null;
   let sym = 0, mirrorSym = 0;
   let gearOff = 0;
   if (offset + I32 * 3 + F64 <= buffer.byteLength) {
      sym = view.getInt32(offset, true); offset += I32; // nsym
      mirrorSym = view.getInt32(offset, true); offset += I32; // mirror_sym
      const tailGear = view.getInt32(offset, true); offset += I32; // igear
      sourceGear = Math.abs(tailGear); // For some reason, gear is sometimes negative.
      refractiveIndex = view.getFloat64(offset, true); offset += F64;
   }

   if (offset + 1 <= buffer.byteLength) {
      const i = view.getInt32(offset, true); offset += I32;
      if (i === 32767) {
         gearOff = view.getFloat64(offset, true); offset += F64;
      } else {
         gearOff = i;
      }
   }

   let metadata = {};
   for (let j = 0; j < 8 && offset < buffer.byteLength; j++) {
      const byte = view.getUint8(offset); offset += 1;
      if (byte === 0) continue; // skip null bytes
      if (byte === 0xFF) break;
      const strView = new DataView(buffer, offset, byte);
      const str = new TextDecoder().decode(new Uint8Array(strView.buffer, strView.byteOffset, strView.byteLength));
      offset += byte;
      if (j < 4) {
         if (!metadata.title) metadata.title = '';
         metadata.title += (metadata.title ? "\n" : "") + str.trim();
      } else {
         if (!metadata.comments) metadata.comments = '';
         metadata.comments += (metadata.comments ? "\n" : "") + str.trim();
      }
   }

   // ── 3. Reconstruct vertices by 3-plane intersection ──────────────────────
   // For a convex polyhedron defined by half-spaces ax+by+cz <= d, every
   // vertex is the intersection of exactly 3 planes. We try all C(n,3)
   // combinations and keep points that satisfy ALL planes (within epsilon).


   // Collect unique vertices
   const allVerts = [];
   function addVertex(pt) {
      for (const v of allVerts) {
         if (Math.abs(v[0] - pt[0]) + Math.abs(v[1] - pt[1]) + Math.abs(v[2] - pt[2]) < VERTEX_EPS)
            return allVerts.indexOf(v);
      }
      allVerts.push(pt);
      return allVerts.length - 1;
   }

   // For each plane, collect which vertices lie on it (within epsilon)
   const n = planes.length;
   const facetVerts = planes.map(() => []); // facetVerts[planeIdx] = [vertIdx, ...]

   for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
         for (let k = j + 1; k < n; k++) {
            const pt = intersect3Planes(planes[i], planes[j], planes[k]);
            if (!pt || !insideAllPlanes(pt, planes)) continue;

            const vi = addVertex(pt);

            // This vertex belongs to planes i, j, k
            for (const pi of [i, j, k]) {
               if (!facetVerts[pi].includes(vi))
                  facetVerts[pi].push(vi);
            }
         }
      }
   }
   // ── 5. Tessellate and pack ────────────────────────────────────────────────
   const triangles = [];
   const facets = [];

   for (let pi = 0; pi < n; pi++) {
      const verts = orderFacetVerts(pi, facetVerts[pi], planes, allVerts);
      if (verts.length < 3) continue;

      const p = planes[pi];
      const nx = p.a, ny = p.b, nz = p.c;
      const triangleCount = verts.length - 2;
      facets.push({
         index: pi + 1,
         name: p.name,
         instructions: p.instructions,
         frosted: Boolean(p.frosted),
         normal: [nx, -ny, nz],
         d: p.d,
         vertexCount: verts.length,
         triangleCount,
      });

      // Fan triangulation from first vertex
      for (let i = 1; i < verts.length - 1; i++) {
         triangles.push({
            v0: allVerts[verts[0]],
            v1: allVerts[verts[i]],
            v2: allVerts[verts[i + 1]],
            normal: [nx, ny, nz],
            frosted: Boolean(p.frosted),
         });
      }
   }

   // Pack into flat Float32Array matching loadSTL output format.
   // GEM format flips the Y axis compared to our convention.
   const triCount = triangles.length;
   const floatsPerVertex = 7;
   const vertexData = new Float32Array(triCount * 3 * floatsPerVertex);

   for (let i = 0; i < triCount; i++) {
      const { v0, v1, v2, normal, frosted } = triangles[i];
      const vs = [v0, v2, v1];
      for (let v = 0; v < 3; v++) {
         const idx = (i * 3 + v) * floatsPerVertex;
         vertexData[idx + 0] = vs[v][0];
         vertexData[idx + 1] = -vs[v][1];
         vertexData[idx + 2] = vs[v][2];
         vertexData[idx + 3] = normal[0];
         vertexData[idx + 4] = -normal[1];
         vertexData[idx + 5] = normal[2];
         vertexData[idx + 6] = frosted ? 1.0 : 0.0;
      }
   }

   return new StoneData(vertexData, triCount, facets, refractiveIndex, null, sourceGear, metadata);
}

function normalizeMesh(data) {
   let min = [Infinity, Infinity, Infinity];
   let max = [-Infinity, -Infinity, -Infinity];

   for (let i = 0; i < data.length; i += 7) {
      for (let a = 0; a < 3; a++) {
         if (data[i + a] < min[a]) min[a] = data[i + a];
         if (data[i + a] > max[a]) max[a] = data[i + a];
      }
   }

   const center = min.map((v, i) => (v + max[i]) / 2);
   const size = min.map((v, i) => max[i] - v);
   const maxDimension = Math.max(...size);
   const scale = 2.0 / maxDimension;

   for (let i = 0; i < data.length; i += 7) {
      data[i] = (data[i] - center[0]) * scale;
      data[i + 1] = (data[i + 1] - center[1]) * scale;
      data[i + 2] = (data[i + 2] - center[2]) * scale;
   }

   return { scale, center };
}

function normalizeStoneToUnitSphere(stone) {
   if (!stone || !(stone.vertexData instanceof Float32Array) || stone.vertexData.length < 7) {
      return { center: [0, 0, 0], scale: 1, maxRadius: 0 };
   }

   const data = stone.vertexData;
   const center = [0, 0, 0];
   let maxRadius = 0;
   for (let i = 0; i < data.length; i += 7) {
      const dx = data[i + 0];
      const dy = data[i + 1];
      const dz = data[i + 2];
      const r = Math.hypot(dx, dy, dz);
      if (r > maxRadius) maxRadius = r;
   }

   if (!Number.isFinite(maxRadius) || maxRadius <= 1e-9) {
      return { center, scale: 1, maxRadius: maxRadius || 0 };
   }

   const scale = 1.0 / maxRadius;
   for (let i = 0; i < data.length; i += 7) {
      data[i + 0] = data[i + 0] * scale;
      data[i + 1] = data[i + 1] * scale;
      data[i + 2] = data[i + 2] * scale;
   }

   if (Array.isArray(stone.facets) && stone.facets.length > 0) {
      stone.facets = stone.facets.map((facet) => {
         if (!facet || !Array.isArray(facet.normal) || facet.normal.length < 3 || !Number.isFinite(facet.d)) {
            return facet;
         }
         return {
            ...facet,
            d: facet.d * scale,
         };
      });
   }

   if (Array.isArray(stone.concaveDebugTools) && stone.concaveDebugTools.length > 0) {
      stone.concaveDebugTools = stone.concaveDebugTools.map((tool) => {
         const p = Array.isArray(tool?.position) ? tool.position : [0, 0, 0];
         return {
            ...tool,
            position: [
               (Number(p[0]) || 0) * scale,
               (Number(p[1]) || 0) * scale,
               (Number(p[2]) || 0) * scale,
            ],
            pointCloud: Array.isArray(tool?.pointCloud)
               ? tool.pointCloud.map((point) => [
                  (Number(point?.[0]) || 0) * scale,
                  (Number(point?.[1]) || 0) * scale,
                  (Number(point?.[2]) || 0) * scale,
               ])
               : [],
            radius: (Number(tool?.radius) || 0) * scale,
            distance: (Number(tool?.distance) || 0) * scale,
            toolDistance: (Number(tool?.toolDistance) || 0) * scale,
         };
      });
   }

   return { center, scale, maxRadius };
}

function computeMeshBoundsRadius(data) {
   let maxRadiusSq = 0;
   for (let i = 0; i < data.length; i += 7) {
      const x = data[i + 0];
      const y = data[i + 1];
      const z = data[i + 2];
      const radiusSq = x * x + y * y + z * z;
      if (radiusSq > maxRadiusSq) maxRadiusSq = radiusSq;
   }
   return Math.sqrt(maxRadiusSq);
}

// ---------------------------------------------------------------------------
// BVH Builder
// Each triangle is stored as:
// [v0x,v0y,v0z, v1x,v1y,v1z, v2x,v2y,v2z, nx,ny,nz, frosted]
// = 13 floats per triangle → triangleBuffer (storage buffer)
//
// BVH node layout (8 floats each, aligned for GPU):
//   [aabbMinX, aabbMinY, aabbMinZ, leftOrTriIdx,
//    aabbMaxX, aabbMaxY, aabbMaxZ, triCountOrRight]
//
//   Leaf:  triCountOrRight > 0  → triCount triangles starting at leftOrTriIdx
//   Inner: triCountOrRight == 0 → left child = leftOrTriIdx, right = leftOrTriIdx+1
// ---------------------------------------------------------------------------

function buildBVH(vertexData, triangleCount) {
   const floatsPerVertex = 7;
   const floatsPerTriangle = 13;
   // Pack triangles into flat array: 13 floats each
   const tris = new Float32Array(triangleCount * floatsPerTriangle);
   for (let i = 0; i < triangleCount; i++) {
      const base = i * 3 * floatsPerVertex;
      const t = i * floatsPerTriangle;
      // v0
      tris[t + 0] = vertexData[base + 0];
      tris[t + 1] = vertexData[base + 1];
      tris[t + 2] = vertexData[base + 2];
      // v1
      tris[t + 3] = vertexData[base + 7];
      tris[t + 4] = vertexData[base + 8];
      tris[t + 5] = vertexData[base + 9];
      // v2
      tris[t + 6] = vertexData[base + 14];
      tris[t + 7] = vertexData[base + 15];
      tris[t + 8] = vertexData[base + 16];
      // face normal
      tris[t + 9] = vertexData[base + 3];
      tris[t + 10] = vertexData[base + 4];
      tris[t + 11] = vertexData[base + 5];
      tris[t + 12] = vertexData[base + 6];
   }

   // Centroid per triangle for splitting
   const centroids = new Float32Array(triangleCount * 3);
   for (let i = 0; i < triangleCount; i++) {
      const t = i * floatsPerTriangle;
      centroids[i * 3 + 0] = (tris[t + 0] + tris[t + 3] + tris[t + 6]) / 3;
      centroids[i * 3 + 1] = (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3;
      centroids[i * 3 + 2] = (tris[t + 2] + tris[t + 5] + tris[t + 8]) / 3;
   }

   // Triangle index array — we'll reorder this during BVH build
   const triIndices = new Int32Array(triangleCount);
   for (let i = 0; i < triangleCount; i++) triIndices[i] = i;

   const nodes = []; // will hold {minX,minY,minZ,maxX,maxY,maxZ,left,right,triStart,triCount}

   function computeAABB(start, count) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = start; i < start + count; i++) {
         const ti = triIndices[i] * floatsPerTriangle;
         for (let v = 0; v < 3; v++) {
            const x = tris[ti + v * 3 + 0];
            const y = tris[ti + v * 3 + 1];
            const z = tris[ti + v * 3 + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
         }
      }
      return { minX, minY, minZ, maxX, maxY, maxZ };
   }

   const LEAF_MAX = 4; // max triangles per leaf

   function buildNode(start, count) {
      const nodeIdx = nodes.length;
      nodes.push(null); // placeholder

      const aabb = computeAABB(start, count);

      if (count <= LEAF_MAX) {
         nodes[nodeIdx] = { ...aabb, triStart: start, triCount: count, left: -1, right: -1 };
         return nodeIdx;
      }

      // Choose longest axis
      const dx = aabb.maxX - aabb.minX;
      const dy = aabb.maxY - aabb.minY;
      const dz = aabb.maxZ - aabb.minZ;
      const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;

      // Sort by centroid along axis
      const sub = triIndices.subarray(start, start + count);
      sub.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);

      const mid = Math.floor(count / 2);
      const left = buildNode(start, mid);
      const right = buildNode(start + mid, count - mid);

      nodes[nodeIdx] = { ...aabb, triStart: -1, triCount: 0, left, right };
      return nodeIdx;
   }

   buildNode(0, triangleCount);

   // Pack nodes into Float32Array: 8 floats per node
   // [minX, minY, minZ, leftOrTriStart,  maxX, maxY, maxZ, triCountOrZero]
   const nodeCount = nodes.length;
   const nodeBuffer = new Float32Array(nodeCount * 8);
   for (let i = 0; i < nodeCount; i++) {
      const n = nodes[i];
      const b = i * 8;
      nodeBuffer[b + 0] = n.minX;
      nodeBuffer[b + 1] = n.minY;
      nodeBuffer[b + 2] = n.minZ;
      nodeBuffer[b + 3] = n.triCount > 0 ? n.triStart : n.left; // leaf: triStart, inner: left child
      nodeBuffer[b + 4] = n.maxX;
      nodeBuffer[b + 5] = n.maxY;
      nodeBuffer[b + 6] = n.maxZ;
      nodeBuffer[b + 7] = n.triCount > 0 ? n.triCount : -(n.right + 1); // leaf: triCount>0, inner: -rightIdx
   }

   // Reorder triangle buffer by triIndices so leaves are contiguous
   const sortedTris = new Float32Array(triangleCount * floatsPerTriangle);
   for (let i = 0; i < triangleCount; i++) {
      const src = triIndices[i] * floatsPerTriangle;
      const dst = i * floatsPerTriangle;
      for (let j = 0; j < floatsPerTriangle; j++) sortedTris[dst + j] = tris[src + j];
   }

   const packedFloatsPerTriangle = 16;
   const packedTris = new Float32Array(triangleCount * packedFloatsPerTriangle);
   for (let i = 0; i < triangleCount; i++) {
      const t = i * floatsPerTriangle;
      const pt = i * packedFloatsPerTriangle;
      // v0
      packedTris[pt + 0] = sortedTris[t + 0];
      packedTris[pt + 1] = sortedTris[t + 1];
      packedTris[pt + 2] = sortedTris[t + 2];
      // w ignored

      // e1 = v1 - v0
      packedTris[pt + 4] = sortedTris[t + 3] - sortedTris[t + 0];
      packedTris[pt + 5] = sortedTris[t + 4] - sortedTris[t + 1];
      packedTris[pt + 6] = sortedTris[t + 5] - sortedTris[t + 2];
      // w ignored

      // e2 = v2 - v0
      packedTris[pt + 8] = sortedTris[t + 6] - sortedTris[t + 0];
      packedTris[pt + 9] = sortedTris[t + 7] - sortedTris[t + 1];
      packedTris[pt + 10] = sortedTris[t + 8] - sortedTris[t + 2];
      // w ignored

      // face normal
      packedTris[pt + 12] = sortedTris[t + 9];
      packedTris[pt + 13] = sortedTris[t + 10];
      packedTris[pt + 14] = sortedTris[t + 11];

      // frosted
      packedTris[pt + 15] = sortedTris[t + 12];

   }

   return { nodeBuffer, triBuffer: packedTris, nodeCount };
}

function computeFacetAngleDeg(normal) {
   const nz = Math.max(-1, Math.min(1, Math.abs(normal[2])));
   return Math.acos(nz) * 180 / Math.PI;
}

function computeFacetAngleFromUpDeg(normal) {
   const x = normal[0];
   const y = normal[1];
   const z = normal[2];
   const len = Math.hypot(x, y, z);
   if (len <= 1e-8) return 180;
   const nz = Math.max(-1, Math.min(1, z / len));
   return Math.acos(nz) * 180 / Math.PI;
}

function hasUniqueTableFacet(facets = []) {
   for (const facet of facets) {
      const angle = computeFacetAngleFromUpDeg(facet?.normal || [0, 0, 0]);
      if (angle <= TABLE_FACET_MAX_ANGLE_DEG) {
         return true;
      }
   }
   return false;
}

function computeFacetGearIndex(normal, gear) {
   const x = normal[0] ?? 0;
   const y = normal[1] ?? 0;
   if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) {
      return (normal[2] ?? 1) < 0 ? 'Culet' : 'Table';
   }

   const g = gear;
   const turns = Math.atan2(x, -y) / (Math.PI * 2);
   let gearIndex = Math.round(turns * g);
   gearIndex = ((gearIndex % g) + g) % g;
   if (gearIndex === 0) gearIndex = g;
   return String(gearIndex).padStart(Math.max(2, String(g).length), '0');
}

function isDownFacingFlatFacet(normal) {
   const nz = Number(normal?.[2]);
   return Number.isFinite(nz) && nz < 0 && isFlatFacetAngleDeg(computeFacetAngleDeg(normal));
}

function getFacetSection(angle, normal = null) {
   if (normal && isDownFacingFlatFacet(normal)) return 'PAVILION';
   if (angle < -1 || angle > 89) return 'PAVILION';
   return 'CROWN';
}

function groupFacetInfo(facets = [], gear) {
   const sections = new Map([
      ['PAVILION', []],
      ['CROWN', []],
      ['OTHER', []],
   ]);
   const grouped = new Map();

   for (const facet of facets) {
      const name = (facet.name || '').trim() || '?';
      const instructions = (facet.instructions || '').trim();
      const angle = computeSignedFacetAngleDeg(facet.normal);
      const angleLabel = Math.abs(angle).toFixed(2);
      const key = makeKeyFromFacet(facet);
      let entry = grouped.get(key);
      if (!entry) {
         entry = {
            ...facet,
            section: getFacetSection(angle, facet.normal),
            name,
            angle,
            angleLabel: `${angleLabel}°`,
            indexes: [],
            instructions,
         };
         grouped.set(key, entry);
         sections.get(entry.section)?.push(entry);
      } else if ((entry.name === '?' || !entry.name) && name !== '?') {
         const nextSection = getFacetSection(angle, facet.normal);
         if (entry.section !== nextSection) {
            const currentEntries = sections.get(entry.section);
            const currentIndex = currentEntries?.indexOf(entry) ?? -1;
            if (currentIndex >= 0) currentEntries.splice(currentIndex, 1);
            sections.get(nextSection)?.push(entry);
            entry.section = nextSection;
         }
         entry.name = name;
      }
      entry.indexes.push(computeFacetGearIndex(facet.normal, gear));
   }

   for (const entries of sections.values()) {
      entries.forEach((entry) => {
         const seen = new Set();
         const out = [];
         for (const index of entry.indexes) {
            let formatted;
            if (/^\d+$/.test(index)) {
               formatted = String(parseInt(index, 10)).padStart(2, '0');
            } else {
               formatted = index;
            }
            if (!seen.has(formatted)) {
               seen.add(formatted);
               out.push(formatted);
            }
         }
         entry.indexes = out.sort((a, b) => {
            return (a % gear) - (b % gear);
         });
      });
   }

   return sections;
}

function formatFacetIndexLines(indexes) {
   if (!indexes.length) return ['\u2014'];
   return indexes.join('-')
}

function parseFacetGearIndex(normal, gear) {
   const raw = computeFacetGearIndex(normal, gear);
   const parsed = parseInt(raw, 10);
   return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function wrapGearIndex(value, gear) {
   return value % gear;
}

function generatePatternIndexSet(startIndex, symmetry, mirror, gear) {
   const g = gear;
   const sym = Math.max(1, Math.min(g, Math.round(symmetry) || 1));
   const step = g / sym;
   const indexSet = new Set();

   for (let i = 0; i < sym; i++) {
      const offset = i * step;
      const primary = wrapGearIndex(startIndex + offset, g);
      indexSet.add(primary);
      if (mirror) indexSet.add(mirrorIndex(primary, g));
   }
   return [...indexSet].sort((a, b) => a - b);
}

function inferSymmetryMirrorFromIndexes(indexes, gear) {
   const g = gear;
   const normalized = [...new Set(
      (indexes || [])
         .map((value) => parseInt(value, 10))
         .filter((value) => Number.isFinite(value) && value >= 0)
         .map((value) => (value === 0 ? g : value))
         .map((value) => wrapGearIndex(value, g)),
   )].sort((a, b) => a - b);

   if (!normalized.length) return { startIndex: 0, symmetry: 1, mirror: false };
   if (normalized.length === 1) return { startIndex: normalized[0] === g ? 0 : normalized[0], symmetry: 1, mirror: false };

   // Compute deltas between consecutive indexes (wrap around)
   const deltas = [];
   for (let i = 0; i < normalized.length; i++) {
      const curr = normalized[i];
      const next = normalized[(i + 1) % normalized.length];
      const delta = (next - curr + g) % g;
      if (delta <= 0) {
         deltas.push(null);
      } else {
         deltas.push(delta);
      }
   }

   const allEqual = deltas.every((d) => d !== null && Math.abs(d - deltas[0]) < 1e-6);

   if (allEqual) {
      // Even spacing → no mirror, symmetry equals number of positions
      return { startIndex: normalized[0] === g ? 0 : normalized[0], symmetry: normalized.length, mirror: false };
   }

   // Otherwise assume mirrored pattern: mirror doubles the unique positions
   const inferredSymmetry = Math.max(1, Math.min(g, Math.floor(normalized.length / 2)));
   return { startIndex: normalized[0] === g ? 0 : normalized[0], symmetry: inferredSymmetry, mirror: true };
}

function computeSignedFacetAngleDeg(normal) {
   return geometryComputeSignedFacetAngleDeg(normal);
}

function getFacetDistanceValue(facet) {
   if (Number.isFinite(facet?.d)) return Math.abs(facet.d);
   return 1;
}

const makeKeyFromFacet = (facet) => {
   const angle = computeSignedFacetAngleDeg(facet.normal);
   const angleKey = angle.toFixed(2);
   const name = String(facet?.name || '').trim();
   const dKey = Number.isFinite(facet?.d) ? Math.abs(facet.d).toFixed(4) : 'NaN';
   // const section = getFacetSection(angle);
   // const instructions = String(facet?.instructions || '').trim();
   const key = `${name}\u0000${angleKey}\u0000${dKey}`;
   return key;
};

function groupExternalFacetsForDesign(facets = [], gear) {
   const sourceByKey = new Map();
   facets.forEach((facet) => {
      const key = makeKeyFromFacet(facet);
      if (!sourceByKey.has(key)) sourceByKey.set(key, []);
      sourceByKey.get(key).push(facet);
   });

   const groupedSections = groupFacetInfo(facets, gear);
   // console.log('Grouped Sections:', groupedSections);
   const sectionOrder = ['PAVILION', 'CROWN', 'OTHER'];
   const groupedFacets = [];

   for (const sectionName of sectionOrder) {
      const entries = groupedSections.get(sectionName) || [];
      for (const entry of entries) {
         const key = makeKeyFromFacet(entry);
         const sourceFacets = sourceByKey.get(key) || [];
         const entryNameUpper = String(entry.name || '').trim().toUpperCase();
         const nameMatchedFacets = entryNameUpper
            ? sourceFacets.filter((facet) => String(facet?.name || '').trim().toUpperCase() === entryNameUpper)
            : [];
         const preferredFacets = nameMatchedFacets.length ? nameMatchedFacets : sourceFacets;
         const sampleFacet = preferredFacets[0] || sourceFacets[0] || null;

         const indexedFromSource = preferredFacets
            .map((facet) => parseFacetGearIndex(facet.normal, gear))
            .filter((value) => Number.isFinite(value));

         const indexedFromNotes = (entry.indexes || [])
            .map((value) => parseInt(value, 10))
            .filter((value) => Number.isFinite(value));

         const indexes = indexedFromNotes.length ? indexedFromNotes : indexedFromSource;
         const inferred = inferSymmetryMirrorFromIndexes(indexes, gear);
         const sampleNormal = sampleFacet?.normal || entry.normal;
         const downFacingFlat = isDownFacingFlatFacet(sampleNormal);
         const signedAngle = sampleFacet
            ? computeSignedFacetAngleDeg(sampleFacet.normal)
            : entry.angle;
         const baseDistance = Number.isFinite(entry?.d)
            ? Number(entry.d)
            : Number(sampleFacet?.d);
         const distance = downFacingFlat
            ? -Math.abs(Number.isFinite(baseDistance) ? baseDistance : 1)
            : Math.abs(Number.isFinite(baseDistance) ? baseDistance : 1);

         groupedFacets.push({
            id: `${Date.now()}-${groupedFacets.length}-${Math.random().toString(36).slice(2, 8)}`,
            name: String(entry.name || sampleFacet?.name || `F${groupedFacets.length + 1}`),
            instructions: String(entry.instructions || sampleFacet?.instructions || ''),
            symmetry: inferred.symmetry,
            mirror: inferred.mirror,
            angleDeg: downFacingFlat ? -0 : signedAngle,
            startIndex: inferred.startIndex,
            distance,
            indexes: indexes.length ? [...new Set(indexes)] : undefined,
         });
      }
   }

   return groupedFacets;
}

function buildInstructionAngleCutSequence(facets = [], gear) {
   const g = Math.max(1, parseInt(gear, 10) || 96);
   const groups = [];
   let currentCutKey = null;
   let currentCut = null;

   const normalizeGearIndex = (value) => {
      const wrapped = wrapGearIndex(value, g);
      return wrapped === 0 ? g : wrapped;
   };

   for (const facet of facets) {
      const tag = String(facet?.instructions || '').trim().toUpperCase();
      if (tag === 'BOOTSTRAP') continue;

      const angle = computeSignedFacetAngleDeg(facet?.normal || [0, 0, 1]);
      const cutKey = makeKeyFromFacet(facet);
      if (cutKey !== currentCutKey) {
         currentCut = {
            name: String(facet?.name || '').trim() || '?',
            instructions: String(facet?.instructions || '').trim(),
            angleDeg: angle,
            normal: facet?.normal || [0, 0, 1],
            d: Number.isFinite(facet?.d) ? Number(facet.d) : 1,
            indexes: [],
            _seenIndexes: new Set(),
         };

         groups.push({
            angleKey: `${angle.toFixed(2)}-${groups.length}`,
            angleDeg: angle,
            angleLabel: `${Math.abs(angle).toFixed(2)}\u00b0`,
            cuts: [currentCut],
         });
         currentCutKey = cutKey;
      }

      const parsed = parseFacetGearIndex(facet?.normal || [0, 0, 1], g);
      if (Number.isFinite(parsed) && parsed >= 0) {
         const nextIndex = normalizeGearIndex(parsed);
         if (!currentCut._seenIndexes.has(nextIndex)) {
            currentCut._seenIndexes.add(nextIndex);
            currentCut.indexes.push(nextIndex);
         }
      }
   }

   for (const group of groups) {
      for (const cut of group.cuts) {
         delete cut._seenIndexes;
         const indexes = cut.indexes.length
            ? cut.indexes
            : [normalizeGearIndex(1)];
         const inferred = inferSymmetryMirrorFromIndexes(indexes, g);
         const downFacingFlat = isDownFacingFlatFacet(cut.normal);
         const distance = downFacingFlat ? -Math.abs(cut.d) : Math.abs(cut.d);

         cut.indexes = indexes;
         cut.startIndex = inferred.startIndex;
         cut.symmetry = inferred.symmetry;
         cut.mirror = inferred.mirror;
         cut.distance = distance;
         cut.angleDeg = downFacingFlat ? -0 : cut.angleDeg;
      }
   }

   return groups;
}

function normalizeDesignFacet(inputFacet = {}, fallbackIndex = 0) {
   const parsedSymmetry = parseFloat(inputFacet.symmetry);
   const parsedAngleDeg = parseFloat(inputFacet.angleDeg);
   const parsedStartIndex = parseFloat(inputFacet.startIndex);
   const parsedDistance = parseFloat(inputFacet.distance);
   const parsedIndexes = Array.isArray(inputFacet.indexes)
      ? [...new Set(
         inputFacet.indexes
            .map((value) => parseInt(value, 10))
            .filter((value) => Number.isFinite(value) && value > 0),
      )].sort((a, b) => a - b)
      : null;
   const angleDeg = Math.max(-90, Math.min(90, Number.isFinite(parsedAngleDeg) ? parsedAngleDeg : 0));
   const rawDistance = Number.isFinite(parsedDistance) ? parsedDistance : 0;
   const normalizedDistance = isFlatFacetAngleDeg(angleDeg)
      ? rawDistance
      : Math.max(0, Math.abs(rawDistance));

   const next = {
      id: inputFacet.id || `${Date.now()}-${fallbackIndex}-${Math.random().toString(36).slice(2, 8)}`,
      name: String(inputFacet.name || `F${fallbackIndex + 1}`).trim() || `F${fallbackIndex + 1}`,
      instructions: String(inputFacet.instructions || '').trim(),
      symmetry: parsedSymmetry,
      mirror: Boolean(inputFacet.mirror),
      angleDeg,
      startIndex: Math.max(0, Math.min(360, Math.round(Number.isFinite(parsedStartIndex) ? parsedStartIndex : 0))),
      distance: normalizedDistance,
      indexes: parsedIndexes && parsedIndexes.length ? parsedIndexes : undefined,
   };
   return next;
}

// Generate polygonal faces (ordered vertices, normal and angles) from
// a list of design-style facets (as produced by groupExternalFacetsForDesign
// or similar). Returns an array of faces: { name, instructions, normal, vertices:[ [x,y,z], ... ], angleDeg, signedAngleDeg, azimuthDeg }
function generateFacesFromFacetList(facetList = [], gear = 96) {

   const normalizedInput = (facetList || []).map((f, i) => normalizeDesignFacet(f, i));
   // Hardcoded toggle: when true, reverse polygon winding for all generated faces.
   const FORCE_REVERSE_WINDING = true;

   // Build plane half-spaces from facet definitions (one plane per patterned index)
   const planes = [];
   for (let facetOrder = 0; facetOrder < normalizedInput.length; facetOrder++) {
      const facet = normalizedInput[facetOrder];
      const symmetry = Math.min(gear, Math.round(Number(facet.symmetry) || gear));
      const step = Math.max(1, gear) / symmetry;
      const mirror = Boolean(facet.mirror);

      const explicit = Array.isArray(facet.indexes) ? facet.indexes.map(v => wrapGearIndex(Math.round(v), gear)) : [];

      const indexSet = new Set();
      if (explicit.length) {
         for (const idx of explicit) indexSet.add(idx);
      } else {
         const start = wrapGearIndex(facet.startIndex, gear);
         for (let i = 0; i < symmetry; i++) {
            const off = Math.round(i * step);
            const primary = wrapGearIndex(start + off, gear);
            indexSet.add(primary);
            if (mirror) indexSet.add(mirrorIndex(primary, gear));
         }
      }

      const angleDeg = facet.angleDeg < -89 ? -facet.angleDeg : facet.angleDeg;
      for (const idx of indexSet) {
         let normal = computeNormalFromPolar(angleDeg, idx, gear, 0);
         let d = facet.distance;
         const len = Math.hypot(normal[0], normal[1], normal[2]);
         if (!Number.isFinite(len) || len < EPS) continue;
         normal = [normal[0] / len, normal[1] / len, normal[2] / len];
         if (!Number.isFinite(d)) d = 1.0;
         if (d < 0 && isFlatFacetAngleDeg(angleDeg)) {
            normal = [0, 0, -1];
            d = -d;
         } else if (d < 0) {
            normal = [-normal[0], -normal[1], -normal[2]];
            d = -d;
         }

         planes.push({
            a: normal[0],
            b: normal[1],
            c: normal[2],
            d,
            name: facet.name,
            instructions: facet.instructions,
            frosted: Boolean(facet.frosted),
            index: idx,
            facetOrder,
         });
      }
   }

   if (!planes.length) return [];

   // Normalize plane coefficients
   for (const p of planes) {
      const l = Math.hypot(p.a, p.b, p.c) || 1;
      p.a /= l; p.b /= l; p.c /= l; p.d /= l;
   }

   const allVerts = [];
   function addVertex(pt) {
      for (let i = 0; i < allVerts.length; i++) {
         const v = allVerts[i];
         if (Math.abs(v[0] - pt[0]) + Math.abs(v[1] - pt[1]) + Math.abs(v[2] - pt[2]) < 1e-6) return i;
      }
      allVerts.push(pt);
      return allVerts.length - 1;
   }

   const n = planes.length;
   const facetVerts = planes.map(() => []);
   for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
         for (let k = j + 1; k < n; k++) {
            const pt = intersect3Planes(planes[i], planes[j], planes[k]);
            if (!pt || !insideAllPlanes(pt, planes)) continue;
            const vi = addVertex(pt);
            for (const pi of [i, j, k]) if (!facetVerts[pi].includes(vi)) facetVerts[pi].push(vi);
         }
      }
   }

   // Flip plane normals if centroid violates half-space (match orientation used elsewhere)
   if (allVerts.length) {
      let cx = 0, cy = 0, cz = 0;
      for (const v of allVerts) { cx += v[0]; cy += v[1]; cz += v[2]; }
      cx /= allVerts.length; cy /= allVerts.length; cz /= allVerts.length;
      let flipCount = 0;
      for (const p of planes) {
         const val = p.a * cx + p.b * cy + p.c * cz;
         if (val > p.d + 1e-8) { p.a = -p.a; p.b = -p.b; p.c = -p.c; p.d = -p.d; flipCount++; }
      }
      if (flipCount) console.debug('generateFacesFromFacetList: flipped', flipCount, 'planes to match centroid');
   }

   const faces = [];
   for (let pi = 0; pi < n; pi++) {
      const ordered = orderFacetVerts(pi, facetVerts[pi], planes, allVerts);
      if (!ordered || ordered.length < 3) continue;
      let verts = ordered.map(vi => allVerts[vi]);
      if (FORCE_REVERSE_WINDING) verts = verts.reverse();
      const p = planes[pi];
      const n = [p.a, p.b, p.c];
      const angleDeg = computeFacetAngleDeg(n);
      const isGirdle = Math.abs(angleDeg) >= 89;
      // const normal = isGirdle ? [-n[0], n[1], n[2]] : n; // NOTE: no idea why i have to do that
      const normal = n;
      const signedAngleDeg = computeSignedFacetAngleDeg(n);
      const azimuth = (Math.atan2(n[0], -n[1]) * 180 / Math.PI) || 0;
      const azimuthDeg = ((azimuth % 360) + 360) % 360;
      // derive index_angle from the original pattern index when available to avoid mirrored pavilion angles
      let indexAngle = 0;
      if (Number.isFinite(Number(p.index))) {
         const idx = Number(p.index);
         // Map index -> angle step
         const step = 360 / Math.max(1, gear);
         let base = (idx * step) % 360;
         // For pavilion facets (signedAngleDeg < 0) that are NOT girdle facets, reverse rotation direction
         if (signedAngleDeg < 0 && !isGirdle) base = (360 - base) % 360;
         indexAngle = base;
         if (indexAngle < 0) indexAngle += 360;
      } else {
         const azimuth = (Math.atan2(n[0], -n[1]) * 180 / Math.PI) || 0;
         indexAngle = ((azimuth % 360) + 360) % 360;
      }

      const faceObj = {
         name: p.name || '',
         instructions: p.instructions || '',
         normal: normal,
         vertices: verts,
         angleDeg,
         signedAngleDeg,
         azimuthDeg,
         indexAngle,
         sourceFacetOrder: Number.isFinite(Number(p.facetOrder)) ? Number(p.facetOrder) : -1,
         sourceGearIndex: Number.isFinite(Number(p.index)) ? Number(p.index) : null,
      };
      // Heuristic: ensure girdle facets are laterally aligned with expected polar direction.
      if (isGirdle && Number.isFinite(Number(p.index))) {
         const expected = computeNormalFromPolar(angleDeg, Number(p.index), gear, 0);
         const ex = expected[0] || 0;
         if (ex * faceObj.normal[0] < 0) {
            // mirror vertices across X to align with expected side and flip normal
            faceObj.vertices = faceObj.vertices.map(v => (Array.isArray(v) ? [-v[0], v[1], v[2]] : v));
            faceObj.normal = [-faceObj.normal[0], -faceObj.normal[1], -faceObj.normal[2]];
         }
      }
      faces.push(faceObj);
   }

   return faces;
}

function buildDesignGcsText(definition = {}) {
   const gear = parseInt(definition.gear, 10);
   const riValue = parseFloat(definition.refractiveIndex);
   const refractiveIndex = Number.isFinite(riValue) && riValue > 1.0 ? riValue : 1.54;
   const facets = Array.isArray(definition.facets) ? definition.facets : [];
   const symmetry = Math.max(1, ...facets.map(f => Number.isFinite(Number(f.symmetry)) ? Number(f.symmetry) : 1));
   const mirror = facets.some(f => f.mirror) ? 1 : 0;

   const normalizeVec = (vector) => {
      const len = Math.hypot(vector[0], vector[1], vector[2]);
      if (!Number.isFinite(len) || len <= 1e-9) return [0, 0, 1];
      return [vector[0] / len, vector[1] / len, vector[2] / len];
   };

   const fmt = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return '0';
      const s = num.toPrecision(17);
      return s.replace(/\.?0+$/, '').replace(/\.$/, '');
   };

   const escapeXML = (str) => {
      return String(str)
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;')
         .replace(/\n/g, '&#10;')
         .replace(/'/g, '&apos;');
   };

   const tierXml = [];
   const normalizedFacets = facets.map((f, i) => normalizeDesignFacet(f, i));
   const faces = generateFacesFromFacetList(facets, gear);
   const groups = new Map();
   for (const face of faces) {
      const sourceOrder = Number.isFinite(Number(face.sourceFacetOrder)) ? Number(face.sourceFacetOrder) : Number.MAX_SAFE_INTEGER;
      const key = `${sourceOrder}\u0000${face.name}\u0000${face.instructions}`;
      if (!groups.has(key)) {
         groups.set(key, {
            sourceOrder,
            name: face.name || '',
            instructions: face.instructions || '',
            faces: [],
         });
      }
      groups.get(key).faces.push(face);
   }

   const orderedGroups = [...groups.values()].sort((a, b) => {
      if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
      const nameCmp = String(a.name).localeCompare(String(b.name));
      if (nameCmp !== 0) return nameCmp;
      return String(a.instructions).localeCompare(String(b.instructions));
   });

   for (const { sourceOrder, name, instructions, faces: grpFaces } of orderedGroups) {
      grpFaces.sort((a, b) => {
         const ia = a.sourceGearIndex;
         const ib = b.sourceGearIndex;
         if (ia !== ib) return ia - ib;
         const va = a.indexAngle ? a.indexAngle : a.azimuthDeg;
         const vb = b.indexAngle ? b.indexAngle : b.azimuthDeg;
         return va - vb;
      });
      const source = normalizedFacets[sourceOrder]
         || normalizedFacets.find(f => String((f.name || '')).trim() === String((name || '')).trim() && String((f.instructions || '')).trim() === String((instructions || '')).trim())
         || null;
      const angleAttr = source && source.angleDeg ? source.angleDeg : (grpFaces[0]?.signedAngleDeg ?? 0);
      let depthAttr = source && source.distance ? source.distance : null;
      if (!Number.isFinite(depthAttr) && grpFaces[0] && Array.isArray(grpFaces[0].vertices) && grpFaces[0].vertices.length) {
         const n0 = grpFaces[0].normal || [0, 0, 1];
         const v0 = grpFaces[0].vertices[0];
         depthAttr = Math.abs((n0[0] * v0[0]) + (n0[1] * v0[1]) + (n0[2] * v0[2]));
      }
      const visibleAttr = source && typeof source.visible !== 'undefined' ? Boolean(source.visible) : true;
      const guideAttr = source && typeof source.guide !== 'undefined' ? Boolean(source.guide) : false;

      const facetXml = grpFaces.map((face) => {
         const normal = normalizeVec(face.normal || [0, 0, 1]);
         const vertices = Array.isArray(face.vertices) ? face.vertices.slice() : [];
         if (vertices.length < 3) {
            console.warn('buildDesignGcsText: skipping face with <3 vertices', name, instructions, face);
            return '';
         }
         const d0 = Math.abs(normal[0] * vertices[0][0] + normal[1] * vertices[0][1] + normal[2] * vertices[0][2]);
         if (!Number.isFinite(d0) || d0 < 1e-9) {
            console.warn('buildDesignGcsText: skipping face with near-zero plane distance', name, instructions, d0, face);
            return '';
         }
         const vertsXml = vertices.map(v => `        <vertex x="${fmt(v[0])}" y="${fmt(v[1])}" z="${fmt(v[2])}"/>`).join('\n');
         const outNormal = normalizeVec(face.normal || normal);
         const rawIdxAngle = Number.isFinite(Number(face.indexAngle)) ? Number(face.indexAngle) : (Number.isFinite(Number(face.azimuthDeg)) ? Number(face.azimuthDeg) : 0);
         const idxAngleStr = fmt(rawIdxAngle);
         return `\n        <facet nx="${fmt(outNormal[0])}" ny="${fmt(outNormal[1])}" nz="${fmt(outNormal[2])}" index_angle="${idxAngleStr}">\n${vertsXml}\n        </facet>`;
      }).join('');
      if (facetXml) {
         const angleForXml = (Number(angleAttr) < 0) ? (180 + Number(angleAttr)) : Number(angleAttr);
         const angleStr = fmt(angleForXml);
         const depthStr = fmt(depthAttr ?? 0);
         tierXml.push(`    <tier angle="${angleStr}" depth="${depthStr}" name="${escapeXML(name)}" instructions="${escapeXML(instructions)}" visible="${visibleAttr ? 'true' : 'false'}" guide="${guideAttr ? 'true' : 'false'}">${facetXml}\n  </tier>`);
      }
   }

   const result = `
<GemCutStudio version="1000">\n
   <index symmetry="${fmt(symmetry)}" mirror="${fmt(mirror)}" gear="${gear}"/>\n
   <render refractive_index="${fmt(refractiveIndex)}"/>\
   n${tierXml.join('\n')}\n
   <info title="${escapeXML(definition.metadata?.title || '')}" footer1="${escapeXML(definition.metadata?.comments || '')}"/>\n
</GemCutStudio>\n`;
   return result;
}

function buildDesignAscText(definition = {}) {
   const gear = Math.max(1, parseInt(definition.gear, 10) || 96);
   const riValue = parseFloat(definition.refractiveIndex);
   const refractiveIndex = Number.isFinite(riValue) && riValue > 1.0 ? riValue : 1.54;
   const facets = Array.isArray(definition.facets) ? definition.facets : [];
   const normalizedFacets = facets.map((f, i) => normalizeDesignFacet(f, i));

   const fmt = (value, digits = 6) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return '0';
      return num.toFixed(digits).replace(/\.?0+$/, '');
   };

   const normalizeAscIndex = (value) => {
      const raw = parseInt(value, 10);
      if (!Number.isFinite(raw)) return null;
      let idx = raw % gear;
      if (idx < 0) idx += gear;
      if (idx === 0) idx = gear;
      return idx;
   };

   const mirrorAscIndex = (index) => {
      const idx = normalizeAscIndex(index);
      if (!Number.isFinite(idx)) return null;
      if (idx === gear) return gear;
      return normalizeAscIndex(gear - idx);
   };

   const titleLines = String(definition.metadata?.title || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
   const commentLines = String(definition.metadata?.comments || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

   const lines = [];
   lines.push('GemCad 5.0');
   lines.push(`g ${gear} 0`);
   lines.push(`I ${fmt(refractiveIndex, 6)}`);

   for (const line of titleLines) {
      lines.push(`H ${line}`);
   }
   for (const line of commentLines) {
      lines.push(`F ${line}`);
   }

   normalizedFacets.forEach((facet, idx) => {
      const symmetry = Math.max(1, Math.min(gear, parseInt(facet.symmetry, 10) || 1));
      const mirror = Boolean(facet.mirror);
      const step = gear / symmetry;
      const indexSet = new Set();

      const explicitIndexes = Array.isArray(facet.indexes)
         ? [...new Set(
            facet.indexes
               .map((value) => normalizeAscIndex(value))
               .filter((value) => Number.isFinite(value)),
         )]
         : [];

      if (explicitIndexes.length > 0) {
         explicitIndexes.forEach((value) => indexSet.add(value));
      } else {
         const start = normalizeAscIndex(facet.startIndex) || 1;
         for (let i = 0; i < symmetry; i++) {
            const offset = Math.round(i * step);
            const primary = normalizeAscIndex(start + offset);
            if (!Number.isFinite(primary)) continue;
            indexSet.add(primary);
            if (mirror) {
               const mirrored = mirrorAscIndex(primary);
               if (Number.isFinite(mirrored)) indexSet.add(mirrored);
            }
         }
      }

      let indexes = [...indexSet].sort((a, b) => a - b);
      if (!indexes.length) indexes = [1];

      const angleDeg = Number.isFinite(Number(facet.angleDeg)) ? Number(facet.angleDeg) : 0;
      const rawDistance = Number.isFinite(Number(facet.distance)) ? Number(facet.distance) : 1;
      const rho = Math.abs(rawDistance);
      const safeName = String(facet.name || `F${idx + 1}`).trim() || `F${idx + 1}`;
      const safeInstructions = String(facet.instructions || '').replace(/\r?\n/g, ' ').trim();

      let row = `a ${fmt(angleDeg, 6)} ${fmt(rho, 6)} ${indexes.join(' ')} n ${safeName}`;
      if (safeInstructions) row += ` G ${safeInstructions}`;
      lines.push(row);
   });

   return `${lines.join('\n')}\n`;
}

function buildDesignGemBuffer(definition = {}) {
   return convertGCSTextToGEMBuffer(buildDesignGcsText(definition));
}

const GIRDLE_ANGLE_EPS_DEG = 1.0;
const isGirdleFacet = (facet) => {
   const angleDeg = computeFacetAngleDeg(facet.normal);
   return Math.abs(angleDeg - 90) <= GIRDLE_ANGLE_EPS_DEG;
};

function computeFacetNotesSummary(stone) {
   const facets = Array.isArray(stone?.facets) ? stone.facets : [];
   const vertexData = stone?.vertexData;
   if (!facets.length || !(vertexData instanceof Float32Array) || vertexData.length < 3) return null;

   let minX = Infinity; let maxX = -Infinity;
   let minY = Infinity; let maxY = -Infinity;
   let minZ = Infinity; let maxZ = -Infinity;
   for (let i = 0; i < vertexData.length; i += 7) {
      const x = vertexData[i + 0];
      const y = vertexData[i + 1];
      const z = vertexData[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
   }

   const xSpan = maxX - minX;
   const ySpan = maxY - minY;
   const length = Math.max(xSpan, ySpan);
   const width = Math.max(1e-9, Math.min(xSpan, ySpan));
   const lw = length / width;
   const lHoriz = xSpan > ySpan;

   const girdleCount = facets.filter((facet) => isGirdleFacet(facet)).length;
   const totalCount = facets.length;
   const nonGirdleCount = Math.max(0, totalCount - girdleCount);

   const tableVerts = [];
   function pushUniqueTableVertex(x, y) {
      const key = `${x.toFixed(6)}:${y.toFixed(6)}`;
      if (!pushUniqueTableVertex.seen.has(key)) {
         pushUniqueTableVertex.seen.add(key);
         tableVerts.push([x, y]);
      }
   }
   pushUniqueTableVertex.seen = new Set();

   const girdleZSlices = [];
   const floatsPerVertex = 7;
   const verticesPerTriangle = 3;
   let triOffset = 0;
   for (const facet of facets) {
      const triCount = Math.max(0, Math.round(facet?.triangleCount || 0));
      const isTable = computeFacetAngleFromUpDeg(facet?.normal || [0, 0, 0]) <= TABLE_FACET_MAX_ANGLE_DEG;
      if (isGirdleFacet(facet)) {
         for (let t = 0; t < triCount; t++) {
            const triBase = (triOffset + t) * verticesPerTriangle * floatsPerVertex;
            for (let v = 0; v < verticesPerTriangle; v++) {
               const base = triBase + v * floatsPerVertex;
               if (base + 2 >= vertexData.length) continue;
               if (isTable) {
                  const x = vertexData[base + 0];
                  const y = vertexData[base + 1];
                  if (Number.isFinite(x) && Number.isFinite(y)) pushUniqueTableVertex(x, y);
               }
               const z = vertexData[base + 2];
               if (Number.isFinite(z)) girdleZSlices.push(z);
            }
         }
      } else if (isTable) {
         for (let t = 0; t < triCount; t++) {
            const triBase = (triOffset + t) * verticesPerTriangle * floatsPerVertex;
            for (let v = 0; v < verticesPerTriangle; v++) {
               const base = triBase + v * floatsPerVertex;
               if (base + 1 >= vertexData.length) continue;
               const x = vertexData[base + 0];
               const y = vertexData[base + 1];
               if (Number.isFinite(x) && Number.isFinite(y)) pushUniqueTableVertex(x, y);
            }
         }
      }
      triOffset += triCount;
   }

   let girdleTop = 0;
   let girdleBottom = 0;
   if (girdleZSlices.length) {
      girdleZSlices.sort((a, b) => a - b);
      const loIdx = Math.floor((girdleZSlices.length - 1) * 0.1);
      const hiIdx = Math.floor((girdleZSlices.length - 1) * 0.9);
      girdleBottom = girdleZSlices[Math.max(0, Math.min(girdleZSlices.length - 1, loIdx))];
      girdleTop = girdleZSlices[Math.max(0, Math.min(girdleZSlices.length - 1, hiIdx))];
   } else {
      const mid = (minZ + maxZ) * 0.5;
      girdleBottom = mid;
      girdleTop = mid;
   }

   const pavilionDepth = Math.max(0, girdleBottom - minZ);
   const crownHeight = Math.max(0, maxZ - girdleTop);
   const pw = pavilionDepth / width;
   const cw = crownHeight / width;

   // Index 0 axis is the negative Y direction (same convention as facet gear index mapping).
   let tableWidthAt0 = 0;
   let tableWidthAt90 = 0;
   if (tableVerts.length > 1) {
      let min0 = Infinity;
      let max0 = -Infinity;
      let min90 = Infinity;
      let max90 = -Infinity;
      for (const [x, y] of tableVerts) {
         const axis0 = -y;
         const axis90 = x;
         if (axis0 < min0) min0 = axis0;
         if (axis0 > max0) max0 = axis0;
         if (axis90 < min90) min90 = axis90;
         if (axis90 > max90) max90 = axis90;
      }
      tableWidthAt0 = Math.max(0, max0 - min0);
      tableWidthAt90 = Math.max(0, max90 - min90);
   }
   const uw = tableWidthAt0 / width;
   const tw = tableWidthAt90 / width;

   const gearUsed = parseInt(stone.sourceGear, 10);

   return {
      lw,
      pw,
      cw,
      uw,
      tw,
      gearUsed,
      nonGirdleCount,
      girdleCount,
      totalCount,
      lHoriz,
   };
}

export {
   loadSTL,
   loadGCS,
   loadASC,
   loadGEM,
   buildFacetInfo,
   convertGCSTextToGEMBuffer,
   normalizeMesh,
   normalizeStoneToUnitSphere,
   computeMeshBoundsRadius,
   buildBVH,
   buildStoneFromFacetDesign,
   computeFacetAngleDeg,
   computeFacetAngleFromUpDeg,
   hasUniqueTableFacet,
   computeFacetGearIndex,
   groupFacetInfo,
   formatFacetIndexLines,
   parseFacetGearIndex,
   generatePatternIndexSet,
   inferSymmetryMirrorFromIndexes,
   computeSignedFacetAngleDeg,
   getFacetDistanceValue,
   groupExternalFacetsForDesign,
   buildInstructionAngleCutSequence,
   normalizeDesignFacet,
   computeFacetNotesSummary,
   stretchStoneByVertices,
   computeNormalFromPolar,
   generateFacesFromFacetList,
   buildDesignGcsText,
   buildDesignAscText,
   buildDesignGemBuffer,
};


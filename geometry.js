"use strict";

const EPS = 1e-9;
const FLAT_FACET_ANGLE_EPS_DEG = 1e-8;

export function isNegativeZero(value) {
   return value === 0 && 1 / value === -Infinity;
}

export function isFlatFacetAngleDeg(angleDeg) {
   return Math.abs(angleDeg) <= FLAT_FACET_ANGLE_EPS_DEG;
}

export function resolveFlatFacetNormalZ(angleDeg, distance) {
   if (Number.isFinite(distance) && distance < 0) return -1;
   if (angleDeg < 0 || isNegativeZero(angleDeg)) return -1;
   return 1;
}

export function computeNormalFromPolar(angleDeg, index, gear, gearOffset = 0) {
   if (isFlatFacetAngleDeg(angleDeg)) {
      return [0, 0, resolveFlatFacetNormalZ(angleDeg)];
   }
   const incl = angleDeg * Math.PI / 180;
   const azi = (index - gearOffset) * 2 * Math.PI / gear;
   let c = Math.cos(incl);
   let s = Math.sin(incl);
   if (angleDeg < 0) {
      c *= -1;
      s *= -1;
   }
   const a = s * Math.sin(azi);
   const b = -s * Math.cos(azi);
   return [a, b, c];
}

export function computeSignedFacetAngleDeg(normal) {
   const nz = Math.max(-1, Math.min(1, Math.abs(normal[2])));
   const absAngle = Math.acos(nz) * 180 / Math.PI;
   return normal[2] >= 0 ? absAngle : -absAngle;
}

export function computeFacetNormalFromParams(gearValue, rawIndexValue, angleValue, distanceValue) {
   const gear = Math.max(1, parseInt(gearValue, 10) || 96);
   const rawIndex = parseFloat(rawIndexValue) || 0;
   const angleDeg = Math.max(-90, Math.min(90, parseFloat(angleValue) || 0));
   const distance = parseFloat(distanceValue);

   if (isFlatFacetAngleDeg(angleDeg)) {
      return [0, 0, resolveFlatFacetNormalZ(angleDeg, distance)];
   }

   const normal = computeNormalFromPolar(angleDeg, (rawIndex % gear), gear, 0);
   const len = Math.hypot(normal[0], normal[1], normal[2]);
   if (!Number.isFinite(len) || len <= 1e-9) return [0, 0, 0];
   return [normal[0] / len, normal[1] / len, normal[2] / len];
}

function buildFacetVertexLists(stone) {
   const floatsPerVertex = 7;
   const vertsPerTri = 3;
   const vertexData = stone.vertexData;
   const facets = stone.facets;
   const facetVertexLists = [];

   let triOffset = 0;
   for (let fi = 0; fi < facets.length; fi++) {
      const triCountForFacet = Math.max(0, Math.round(facets[fi].triangleCount || 0));
      const pts = [];
      for (let t = 0; t < triCountForFacet; t++) {
         const triIdx = triOffset + t;
         const base = triIdx * vertsPerTri * floatsPerVertex;
         for (let v = 0; v < vertsPerTri; v++) {
            const idx = base + v * floatsPerVertex;
            const x = vertexData[idx + 0];
            const y = vertexData[idx + 1];
            const z = vertexData[idx + 2];
            pts.push([x, y, z]);
         }
      }
      triOffset += triCountForFacet;

      const uniq = [];
      const seen = new Set();
      for (const p of pts) {
         const key = `${p[0].toFixed(6)}:${p[1].toFixed(6)}:${p[2].toFixed(6)}`;
         if (!seen.has(key)) {
            seen.add(key);
            uniq.push(p);
         }
      }
      facetVertexLists.push(uniq);
   }

   return facetVertexLists;
}

function computeHorizontalSpans(vertexData) {
   let minX = Infinity;
   let maxX = -Infinity;
   let minY = Infinity;
   let maxY = -Infinity;
   for (let i = 0; i < vertexData.length; i += 7) {
      const x = vertexData[i + 0];
      const y = vertexData[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
   }
   const xSpan = maxX - minX;
   const ySpan = maxY - minY;
   const length = Math.max(xSpan, ySpan);
   const width = Math.min(xSpan, ySpan);
   return { xSpan, ySpan, length, width };
}

function normalizeVec3(v, fallback = [0, 0, 1]) {
   const len = Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0);
   if (!Number.isFinite(len) || len <= EPS) return fallback.slice();
   return [v[0] / len, v[1] / len, v[2] / len];
}

function wrapGearIndex(index, gear) {
   let idx = Math.round(index || 0);
   const g = Math.max(1, Math.round(gear || 1));
   idx = ((idx % g) + g) % g;
   if (idx === 0) idx = g;
   return idx;
}

function gearIndexFromNormal(normal, gear, snap = true) {
   const x = normal[0] || 0;
   const y = normal[1] || 0;
   if (Math.hypot(x, y) <= 1e-8) return snap ? 1 : 0;
   const g = Math.max(1, Math.round(gear || 1));
   const turns = Math.atan2(x, -y) / (Math.PI * 2);
   const raw = turns * g;
   if (snap) return wrapGearIndex(Math.round(raw), g);
   let idx = ((raw % g) + g) % g;
   if (Math.abs(idx) <= 1e-12) idx = g;
   return idx;
}

function circularIndexDelta(rawIndex, snappedIndex, gear) {
   const g = Math.max(1, Math.round(gear || 1));
   let raw = Number(rawIndex);
   let snap = Number(snappedIndex);
   if (!Number.isFinite(raw) || !Number.isFinite(snap)) return 0;
   raw = ((raw % g) + g) % g;
   snap = ((snap % g) + g) % g;
   const d = Math.abs(raw - snap);
   return Math.min(d, g - d);
}

function pointKey3(p) {
   return `${p[0].toFixed(6)}:${p[1].toFixed(6)}:${p[2].toFixed(6)}`;
}

function fitPlaneDistance(normal, pts, weights = null) {
   if (!pts.length) return 0;
   let sum = 0;
   let wsum = 0;
   for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const w = Math.max(1, weights?.[i] || 1);
      sum += w * (normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2]);
      wsum += w;
   }
   return sum / Math.max(EPS, wsum);
}

function rmsPointPlaneDistance(normal, d, pts, weights = null) {
   if (!pts.length) return 0;
   let acc = 0;
   let wsum = 0;
   for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const w = Math.max(1, weights?.[i] || 1);
      const e = normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] - d;
      acc += w * e * e;
      wsum += w;
   }
   return Math.sqrt(acc / Math.max(EPS, wsum));
}

function pointPlaneResidual(normal, d, p) {
   return normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] - d;
}

function transformedNormalFromOriginal(orig, sx, sy) {
   const nx = (orig[0] || 0) / sx;
   const ny = (orig[1] || 0) / sy;
   const nz = orig[2] || 0;
   return normalizeVec3([nx, ny, nz], [0, 0, 1]);
}

function fitSnappedNormalFromPoints(orig, snappedIndex, gear, pts, fallbackNormal, weights = null) {
   if (!pts || pts.length < 3) return normalizeVec3(fallbackNormal, [0, 0, 1]);

   let radial = computeNormalFromPolar(90, snappedIndex, gear, 0);
   radial = normalizeVec3([radial[0], radial[1], 0], [1, 0, 0]);

   let meanQ = 0;
   let meanZ = 0;
   let wsum = 0;
   const qz = [];
   for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const w = Math.max(1, weights?.[i] || 1);
      const q = radial[0] * p[0] + radial[1] * p[1];
      const z = p[2];
      qz.push([q, z, w]);
      meanQ += w * q;
      meanZ += w * z;
      wsum += w;
   }

   if (qz.length >= 6) {
      let zMin = Infinity;
      let zMax = -Infinity;
      for (const [, z] of qz) {
         if (z < zMin) zMin = z;
         if (z > zMax) zMax = z;
      }
      const zSpan = zMax - zMin;
      if (zSpan > 1e-7) {
         const bins = [
            { q: 0, z: 0, w: 0 },
            { q: 0, z: 0, w: 0 },
            { q: 0, z: 0, w: 0 },
         ];
         for (const [q, z, w] of qz) {
            const t = Math.max(0, Math.min(0.999999, (z - zMin) / zSpan));
            const bi = Math.min(2, Math.floor(t * 3));
            bins[bi].q += w * q;
            bins[bi].z += w * z;
            bins[bi].w += w;
         }
         for (const b of bins) {
            if (b.w <= EPS) continue;
            const aq = b.q / b.w;
            const az = b.z / b.w;
            const aw = Math.min(6, Math.max(2, 0.75 * b.w));
            qz.push([aq, az, aw]);
            meanQ += aw * aq;
            meanZ += aw * az;
            wsum += aw;
         }
      }
   }

   meanQ /= Math.max(EPS, wsum);
   meanZ /= Math.max(EPS, wsum);

   let sqq = 0;
   let sqz = 0;
   let szz = 0;
   for (const [q, z, w] of qz) {
      const dq = q - meanQ;
      const dz = z - meanZ;
      sqq += w * dq * dq;
      sqz += w * dq * dz;
      szz += w * dz * dz;
   }

   const trace = sqq + szz;
   const det = sqq * szz - sqz * sqz;
   const disc = Math.max(0, trace * trace * 0.25 - det);
   const lambdaMin = trace * 0.5 - Math.sqrt(disc);

   let h;
   let nz;
   if (Math.abs(sqz) > 1e-12) {
      h = sqz;
      nz = -(sqq - lambdaMin);
   } else if (sqq <= szz) {
      h = 1;
      nz = 0;
   } else {
      h = 0;
      nz = 1;
   }

   const hn = Math.hypot(h, nz);
   if (!Number.isFinite(hn) || hn <= EPS) {
      return normalizeVec3(fallbackNormal, [0, 0, 1]);
   }
   h /= hn;
   nz /= hn;

   const wantPositiveZ = (orig[2] || 0) >= 0;
   if (wantPositiveZ ? nz < 0 : nz > 0) {
      h = -h;
      nz = -nz;
   }

   const nx = h * radial[0];
   const ny = h * radial[1];
   return normalizeVec3([nx, ny, nz], fallbackNormal);
}

function refineSnappedNormalWithHinge(orig, snappedIndex, gear, pts, weights, baseNormal) {
   if (!pts || pts.length < 2) return { normal: normalizeVec3(baseNormal, [0, 0, 1]), hingePoint: null };

   let radial = computeNormalFromPolar(90, snappedIndex, gear, 0);
   radial = normalizeVec3([radial[0], radial[1], 0], [1, 0, 0]);

   const qz = pts.map((p, i) => ({
      i,
      q: radial[0] * p[0] + radial[1] * p[1],
      z: p[2],
      w: Math.max(1, weights?.[i] || 1),
      p,
   }));

   let hinge = qz[0];
   for (const row of qz) {
      if (row.w > hinge.w) hinge = row;
   }

   let target = null;
   let bestDist2 = -1;
   for (const row of qz) {
      if (row.i === hinge.i) continue;
      if (row.w < 2) continue;
      const dq = row.q - hinge.q;
      const dz = row.z - hinge.z;
      const d2 = dq * dq + dz * dz;
      if (d2 > bestDist2) {
         bestDist2 = d2;
         target = row;
      }
   }
   if (!target) {
      for (const row of qz) {
         if (row.i === hinge.i) continue;
         const dq = row.q - hinge.q;
         const dz = row.z - hinge.z;
         const d2 = dq * dq + dz * dz;
         if (d2 > bestDist2) {
            bestDist2 = d2;
            target = row;
         }
      }
   }
   if (!target || bestDist2 <= 1e-12) {
      return { normal: normalizeVec3(baseNormal, [0, 0, 1]), hingePoint: hinge.p };
   }

   const dq = target.q - hinge.q;
   const dz = target.z - hinge.z;
   let h = dz;
   let nz = -dq;
   const hn = Math.hypot(h, nz);
   if (!Number.isFinite(hn) || hn <= EPS) {
      return { normal: normalizeVec3(baseNormal, [0, 0, 1]), hingePoint: hinge.p };
   }
   h /= hn;
   nz /= hn;

   const wantPositiveZ = (orig[2] || 0) >= 0;
   if (wantPositiveZ ? nz < 0 : nz > 0) {
      h = -h;
      nz = -nz;
   }

   let hingeNormal = normalizeVec3([h * radial[0], h * radial[1], nz], baseNormal);
   if (hingeNormal[0] * baseNormal[0] + hingeNormal[1] * baseNormal[1] + hingeNormal[2] * baseNormal[2] < 0) {
      hingeNormal = [-hingeNormal[0], -hingeNormal[1], -hingeNormal[2]];
   }

   const HINGE_BLEND = 0.55;
   let blended = [
      (1 - HINGE_BLEND) * baseNormal[0] + HINGE_BLEND * hingeNormal[0],
      (1 - HINGE_BLEND) * baseNormal[1] + HINGE_BLEND * hingeNormal[1],
      (1 - HINGE_BLEND) * baseNormal[2] + HINGE_BLEND * hingeNormal[2],
   ];
   blended = normalizeVec3(blended, baseNormal);
   if (wantPositiveZ ? blended[2] < 0 : blended[2] > 0) {
      blended = [-blended[0], -blended[1], -blended[2]];
   }

   return { normal: blended, hingePoint: hinge.p };
}

function snapCrownPavilionNormal(orig, transformed, gear, pts, weights = null, snapIndices = true) {
   const snappedIndex = gearIndexFromNormal(transformed, gear, snapIndices);
   const signedAngle = computeSignedFacetAngleDeg(transformed);
   let snapped = computeNormalFromPolar(signedAngle, snappedIndex, gear, 0);
   snapped = normalizeVec3(snapped, transformed);
   snapped = fitSnappedNormalFromPoints(orig, snappedIndex, gear, pts, snapped, weights);
   if ((orig[2] || 0) > 0 && snapped[2] < 0) snapped = [-snapped[0], -snapped[1], -snapped[2]];
   if ((orig[2] || 0) < 0 && snapped[2] > 0) snapped = [-snapped[0], -snapped[1], -snapped[2]];
   return { normal: snapped, snappedIndex };
}

function snapGirdleNormalConditionally(orig, transformed, pts, gear, weights = null) {
   const baseXY = Math.hypot(transformed[0], transformed[1]);
   let base = baseXY > 1e-8
      ? [transformed[0] / baseXY, transformed[1] / baseXY, 0]
      : [orig[0] || 1, orig[1] || 0, 0];
   base = normalizeVec3(base, [1, 0, 0]);
   let baseD = fitPlaneDistance(base, pts, weights);
   const baseErr = rmsPointPlaneDistance(base, baseD, pts, weights);

   const snappedIndex = gearIndexFromNormal(transformed, gear, true);
   let snapped = computeNormalFromPolar(90, snappedIndex, gear, 0);
   snapped = normalizeVec3([snapped[0], snapped[1], 0], base);
   if (orig[0] * snapped[0] + orig[1] * snapped[1] < 0) snapped = [-snapped[0], -snapped[1], 0];
   const snappedD = fitPlaneDistance(snapped, pts, weights);
   const snappedErr = rmsPointPlaneDistance(snapped, snappedD, pts, weights);

   const MEETPOINT_TOL = 3e-4;
   const IMPROVE_EPS = 1e-6;
   const shouldSnap = baseErr > MEETPOINT_TOL && snappedErr + IMPROVE_EPS < baseErr;
   if (shouldSnap) {
      return { normal: snapped, d: snappedD, snapped: true };
   }

   return { normal: base, d: baseD, snapped: false };
}

export function stretchStoneByLW(stone, targetLwRatio, options = {}) {
   const target = Number(targetLwRatio);
   if (!stone || !stone.vertexData || !Array.isArray(stone.facets) || !Number.isFinite(target) || target <= 0) {
      return stone;
   }

   const isGirdleFacet = typeof options.isGirdleFacet === 'function' ? options.isGirdleFacet : null;
   const rebuildFromPlanes = typeof options.rebuildFromPlanes === 'function' ? options.rebuildFromPlanes : null;
   const snapIndices = options.snapIndices !== false;
      const roundingReport = options.roundingReport === true;
   if (!isGirdleFacet || !rebuildFromPlanes) return stone;

   const spans = computeHorizontalSpans(stone.vertexData);
   if (!Number.isFinite(spans.length) || !Number.isFinite(spans.width) || spans.width <= EPS || spans.length <= EPS) {
      return stone;
   }

   const currentLW = spans.length / Math.max(EPS, spans.width);
   if (!Number.isFinite(currentLW) || currentLW <= EPS) return stone;
   if (Math.abs(target - currentLW) <= 1e-6) return stone;

   const lengthOnX = spans.xSpan >= spans.ySpan;
   const lengthScale = target / currentLW;
   const sx = lengthOnX ? lengthScale : 1;
   const sy = lengthOnX ? 1 : lengthScale;
   if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= EPS || sy <= EPS) return stone;

   const facets = stone.facets;
   const gear = Math.max(1, parseInt(stone.sourceGear, 10) || 96);
   const facetVertexLists = buildFacetVertexLists(stone);
   const newFacetVerts = facetVertexLists.map((list) => list.map((p) => [sx * p[0], sy * p[1], p[2]]));

   const sharedPointCounts = new Map();
   const pointFacetIncidence = new Map();
   for (const list of newFacetVerts) {
      for (const p of list) {
         const key = pointKey3(p);
         sharedPointCounts.set(key, (sharedPointCounts.get(key) || 0) + 1);
      }
   }
   for (let fi = 0; fi < newFacetVerts.length; fi++) {
      const list = newFacetVerts[fi];
      for (let pi = 0; pi < list.length; pi++) {
         const key = pointKey3(list[pi]);
         if (!pointFacetIncidence.has(key)) pointFacetIncidence.set(key, []);
         pointFacetIncidence.get(key).push([fi, pi]);
      }
   }
   const facetWeights = newFacetVerts.map((list) => list.map((p) => {
      const count = sharedPointCounts.get(pointKey3(p)) || 1;
      // Boost vertices used by multiple facets so meetpoints dominate fit.
      return Math.min(4, Math.max(1, count));
   }));

   const ANG_EPS = 1e-4;
   const facetModels = [];
   const roundingDetails = [];
   for (let i = 0; i < facets.length; i++) {
      const pts = newFacetVerts[i];
      const weights = facetWeights[i];
      if (!pts || pts.length < 3) continue;
      const orig = normalizeVec3(facets[i].normal || [0, 0, 1], [0, 0, 1]);
      const angle = computeSignedFacetAngleDeg(orig);
      const isG = isGirdleFacet(facets[i]);
      const isFlat = Math.abs(angle) <= ANG_EPS;
      const transformed = transformedNormalFromOriginal(orig, sx, sy);
      const rawIndex = gearIndexFromNormal(transformed, gear, false);
      const snappedIndex = gearIndexFromNormal(transformed, gear, snapIndices);

      let normal;
      let d;
      if (isG) {
         if (snapIndices) {
            const snapped = snapGirdleNormalConditionally(orig, transformed, pts, gear, weights);
            normal = snapped.normal;
            d = snapped.d;
         } else {
            const lenXY = Math.hypot(transformed[0], transformed[1]);
            normal = lenXY > 1e-8
               ? [transformed[0] / lenXY, transformed[1] / lenXY, 0]
               : [orig[0] || 1, orig[1] || 0, 0];
            normal = normalizeVec3(normal, [1, 0, 0]);
            d = fitPlaneDistance(normal, pts, weights);
         }
      } else if (isFlat) {
         normal = [0, 0, (orig[2] || 0) < 0 ? -1 : 1];
         d = fitPlaneDistance(normal, pts, weights);
      } else {
         const snapped = snapCrownPavilionNormal(orig, transformed, gear, pts, weights, snapIndices);
         normal = snapped.normal;
         d = fitPlaneDistance(normal, pts, weights);
      }

      facetModels.push({
         facetIndex: i,
         pts,
         weights,
         orig,
         isG,
         isFlat,
         snappedIndex,
         normal,
         d,
      });

      if (roundingReport && !isFlat) {
         const delta = circularIndexDelta(rawIndex, snappedIndex, gear);
         roundingDetails.push({
            facetIndex: i,
            name: facets[i].name || '',
            isGirdle: isG,
            rawIndex,
            snappedIndex,
            delta,
         });
      }
   }

   if (snapIndices && facetModels.length > 2) {
      const ITER_COUNT = 12;
      const COUPLING_GAIN = 0.7;
      for (let iter = 0; iter < ITER_COUNT; iter++) {
         const pointBias = new Map();
         for (const [key, refs] of pointFacetIncidence.entries()) {
            let num = 0;
            let den = 0;
            for (const [fi, pi] of refs) {
               const model = facetModels.find((m) => m.facetIndex === fi);
               if (!model) continue;
               const p = model.pts[pi];
               const w = Math.max(1, model.weights?.[pi] || 1);
               const r = pointPlaneResidual(model.normal, model.d, p);
               num += w * r;
               den += w;
            }
            if (den > EPS) pointBias.set(key, num / den);
         }

         for (const model of facetModels) {
            const adjustedPts = model.pts.map((p) => p.slice());
            for (let pi = 0; pi < adjustedPts.length; pi++) {
               const key = pointKey3(model.pts[pi]);
               const bias = pointBias.get(key) || 0;
               adjustedPts[pi][0] -= COUPLING_GAIN * bias * model.normal[0];
               adjustedPts[pi][1] -= COUPLING_GAIN * bias * model.normal[1];
               adjustedPts[pi][2] -= COUPLING_GAIN * bias * model.normal[2];
            }

            if (model.isFlat) {
               model.normal = [0, 0, (model.orig[2] || 0) < 0 ? -1 : 1];
               model.d = fitPlaneDistance(model.normal, adjustedPts, model.weights);
               continue;
            }

            if (model.isG) {
               if (snapIndices) {
                  let snapped = computeNormalFromPolar(90, model.snappedIndex, gear, 0);
                  snapped = normalizeVec3([snapped[0], snapped[1], 0], model.normal);
                  if (model.orig[0] * snapped[0] + model.orig[1] * snapped[1] < 0) {
                     snapped = [-snapped[0], -snapped[1], 0];
                  }
                  model.normal = snapped;
                  model.d = fitPlaneDistance(model.normal, adjustedPts, model.weights);
               }
               continue;
            }

            model.normal = fitSnappedNormalFromPoints(
               model.orig,
               model.snappedIndex,
               gear,
               adjustedPts,
               model.normal,
               model.weights,
            );
            const hingeRefined = refineSnappedNormalWithHinge(
               model.orig,
               model.snappedIndex,
               gear,
               adjustedPts,
               model.weights,
               model.normal,
            );
            model.normal = hingeRefined.normal;
            if (hingeRefined.hingePoint) {
               model.d = model.normal[0] * hingeRefined.hingePoint[0]
                  + model.normal[1] * hingeRefined.hingePoint[1]
                  + model.normal[2] * hingeRefined.hingePoint[2];
            } else {
               model.d = fitPlaneDistance(model.normal, adjustedPts, model.weights);
            }
         }
      }
   }

   const planes = facetModels.map((m) => ({
      a: m.normal[0],
      b: m.normal[1],
      c: m.normal[2],
      d: m.d,
      name: facets[m.facetIndex].name || '',
      instructions: facets[m.facetIndex].instructions || '',
      frosted: facets[m.facetIndex].frosted,
   }));

   if (!planes.length) return stone;

   const allPts = [];
   for (const list of newFacetVerts) {
      for (const p of list) allPts.push(p);
   }
   let cx = 0;
   let cy = 0;
   let cz = 0;
   if (allPts.length) {
      for (const p of allPts) {
         cx += p[0];
         cy += p[1];
         cz += p[2];
      }
      cx /= allPts.length;
      cy /= allPts.length;
      cz /= allPts.length;
   }

   for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      const nlen = Math.hypot(p.a, p.b, p.c) || 1;
      p.a /= nlen;
      p.b /= nlen;
      p.c /= nlen;
      p.d /= nlen;
      const val = p.a * cx + p.b * cy + p.c * cz;
      if (val > p.d + EPS) {
         p.a = -p.a;
         p.b = -p.b;
         p.c = -p.c;
         p.d = -p.d;
      }
   }

   try {
      const result = rebuildFromPlanes(planes, stone.refractiveIndex, stone.sourceGear);
      if (!result || !(result.vertexData instanceof Float32Array) || result.triangleCount === 0) {
         return stone;
      }
      if (roundingReport && roundingDetails.length) {
         let sum = 0;
         let max = 0;
         for (const r of roundingDetails) {
            sum += r.delta;
            if (r.delta > max) max = r.delta;
         }
         result.lwRounding = {
            facetCount: roundingDetails.length,
            avgDelta: sum / roundingDetails.length,
            maxDelta: max,
            details: roundingDetails,
         };
      }
      return result;
   } catch {
      return stone;
   }
}

export function stretchStoneByVertices(stone, scaleFactor, crown = true, options = {}) {
   const s = Number(scaleFactor) || 1;
   if (!stone || !stone.vertexData || !Array.isArray(stone.facets) || s === 1) return stone;

   const isGirdleFacet = typeof options.isGirdleFacet === 'function' ? options.isGirdleFacet : null;
   const rebuildFromPlanes = typeof options.rebuildFromPlanes === 'function' ? options.rebuildFromPlanes : null;
   if (!isGirdleFacet || !rebuildFromPlanes) return stone;

   const floatsPerVertex = 7;
   const vertsPerTri = 3;
   const vertexData = stone.vertexData;
   const facets = stone.facets;

   const facetVertexLists = [];
   let triOffset = 0;
   for (let fi = 0; fi < facets.length; fi++) {
      const triCountForFacet = Math.max(0, Math.round(facets[fi].triangleCount || 0));
      const pts = [];
      for (let t = 0; t < triCountForFacet; t++) {
         const triIdx = triOffset + t;
         const base = triIdx * vertsPerTri * floatsPerVertex;
         for (let v = 0; v < vertsPerTri; v++) {
            const idx = base + v * floatsPerVertex;
            const x = vertexData[idx + 0];
            const y = vertexData[idx + 1];
            const z = vertexData[idx + 2];
            pts.push([x, y, z]);
         }
      }
      triOffset += triCountForFacet;
      const uniq = [];
      const seen = new Set();
      for (const p of pts) {
         const key = `${p[0].toFixed(6)}:${p[1].toFixed(6)}:${p[2].toFixed(6)}`;
         if (!seen.has(key)) {
            seen.add(key);
            uniq.push(p);
         }
      }
      facetVertexLists.push(uniq);
   }

   let girdleTop = null;
   let girdleBottom = null;
   for (let i = 0; i < facets.length; i++) {
      const f = facets[i];
      if (!isGirdleFacet(f)) continue;
      for (const p of facetVertexLists[i]) {
         girdleTop = girdleTop === null ? p[2] : Math.max(girdleTop, p[2]);
         girdleBottom = girdleBottom === null ? p[2] : Math.min(girdleBottom, p[2]);
      }
   }

   let z0 = null;
   const ANG_EPS = 1e-4;
   if (crown) {
      if (girdleTop !== null) z0 = girdleTop;
      else {
         for (let i = 0; i < facets.length; i++) {
            const f = facets[i];
            const angle = computeSignedFacetAngleDeg(f.normal);
            if (angle > ANG_EPS) {
               for (const p of facetVertexLists[i]) z0 = z0 === null ? p[2] : Math.min(z0, p[2]);
            }
         }
      }
   } else {
      if (girdleBottom !== null) z0 = girdleBottom;
      else {
         for (let i = 0; i < facets.length; i++) {
            const f = facets[i];
            const angle = computeSignedFacetAngleDeg(f.normal);
            if (angle < -ANG_EPS) {
               for (const p of facetVertexLists[i]) z0 = z0 === null ? p[2] : Math.max(z0, p[2]);
            }
         }
      }
   }
   if (z0 === null) return stone;

   const newFacetVerts = facetVertexLists.map((list, i) => list.map(p => p.slice()));
   for (let i = 0; i < facets.length; i++) {
      const f = facets[i];
      const angle = computeSignedFacetAngleDeg(f.normal);
      const isG = isGirdleFacet(f);
      const isTable = Math.abs(angle) <= ANG_EPS && ((f.normal?.[2] ?? 1) > 0);
      const isTarget = !isG && (crown ? (angle > ANG_EPS || isTable) : (angle < -ANG_EPS));
      if (!isTarget) continue;
      for (const p of newFacetVerts[i]) {
         p[2] = z0 + s * (p[2] - z0);
      }
   }

   const planes = [];
   for (let i = 0; i < facets.length; i++) {
      const pts = newFacetVerts[i];
      if (!pts || pts.length < 3) continue;
      const orig = facets[i].normal || [0, 0, 1];
      const isG = isGirdleFacet(facets[i]);
      const angle = computeSignedFacetAngleDeg(orig);
      const isTable = Math.abs(angle) <= ANG_EPS && (orig[2] ?? 1) > 0;
      const isTarget = !isG && (crown ? (angle > ANG_EPS || isTable) : (angle < -ANG_EPS));
      const effectiveS = isTarget ? s : 1;
      let normal;
      if (isG) {
         const lenXY = Math.hypot(orig[0], orig[1]);
         if (lenXY > 1e-8) {
            normal = [orig[0] / lenXY, orig[1] / lenXY, 0];
         } else {
            let cx = 0, cy = 0;
            for (const q of pts) { cx += q[0]; cy += q[1]; }
            cx /= pts.length; cy /= pts.length;
            const v0x = pts[0][0] - cx; const v0y = pts[0][1] - cy;
            const vlen = Math.hypot(v0x, v0y);
            if (vlen > 1e-8) {
               normal = [v0x / vlen, v0y / vlen, 0];
            } else {
               normal = [1, 0, 0];
            }
         }
         const dot = orig[0] * normal[0] + orig[1] * normal[1];
         if (dot < 0) normal = [-normal[0], -normal[1], -normal[2]];
      } else {
         const nx = orig[0];
         const ny = orig[1];
         const nz = orig[2] / effectiveS;
         const nlen = Math.hypot(nx, ny, nz);
         normal = nlen > EPS ? [nx / nlen, ny / nlen, nz / nlen] : orig.slice();
      }

      const p = pts[0];
      const d = normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2];
      planes.push({
         a: normal[0],
         b: normal[1],
         c: normal[2],
         d,
         name: facets[i].name || '',
         instructions: facets[i].instructions || '',
         frosted: facets[i].frosted,
      });
   }

   if (!planes.length) return stone;

   const allPts = [];
   for (const list of newFacetVerts) for (const p of list) allPts.push(p);
   let cx = 0, cy = 0, cz = 0;
   if (allPts.length) {
      for (const p of allPts) { cx += p[0]; cy += p[1]; cz += p[2]; }
      cx /= allPts.length; cy /= allPts.length; cz /= allPts.length;
   }
   for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      const nlen = Math.hypot(p.a, p.b, p.c) || 1;
      p.a /= nlen; p.b /= nlen; p.c /= nlen; p.d /= nlen;
      const val = p.a * cx + p.b * cy + p.c * cz;
      if (val > p.d + EPS) {
         p.a = -p.a; p.b = -p.b; p.c = -p.c; p.d = -p.d;
      }
   }

   try {
      const result = rebuildFromPlanes(planes, stone.refractiveIndex, stone.sourceGear);
      if (!result || !(result.vertexData instanceof Float32Array) || result.triangleCount === 0) {
         return stone;
      }
      return result;
   } catch {
      return stone;
   }
}

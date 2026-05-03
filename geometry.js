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

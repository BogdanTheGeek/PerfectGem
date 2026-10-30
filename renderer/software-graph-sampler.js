const LIGHT_MODE_FACTORS = [1, 0.9, 0.82];

function clamp(value, min, max) {
   return Math.min(max, Math.max(min, value));
}

function rotateX([x, y, z], radians) {
   const cos = Math.cos(radians);
   const sin = Math.sin(radians);
   return [x, y * cos - z * sin, y * sin + z * cos];
}

function triangleAreaAndNormal(vertexData, offset) {
   const ax = vertexData[offset];
   const ay = vertexData[offset + 1];
   const az = vertexData[offset + 2];
   const bx = vertexData[offset + 7];
   const by = vertexData[offset + 8];
   const bz = vertexData[offset + 9];
   const cx = vertexData[offset + 14];
   const cy = vertexData[offset + 15];
   const cz = vertexData[offset + 16];
   const abx = bx - ax;
   const aby = by - ay;
   const abz = bz - az;
   const acx = cx - ax;
   const acy = cy - ay;
   const acz = cz - az;
   const nx = aby * acz - abz * acy;
   const ny = abz * acx - abx * acz;
   const nz = abx * acy - aby * acx;
   const length = Math.hypot(nx, ny, nz);
   if (length <= 1e-12) return null;
   return {
      area: length * 0.5,
      normal: [nx / length, ny / length, nz / length],
      isTable: Math.abs(vertexData[offset + 5]) > 0.999,
   };
}

/**
 * CPU fallback for graph sampling. It deliberately works on mesh data only,
 * so it remains available when no GPU backend is present. It estimates
 * view-weighted light return; the WebGPU renderer remains the accelerated
 * implementation when available.
 */
export function sampleSoftwareGraphSweep({
   vertexData,
   tiltValues,
   modes,
   hasTableFacet = false,
}) {
   if (!(vertexData instanceof Float32Array)) {
      throw new TypeError('Software graph sampling requires Float32Array vertex data.');
   }

   const triangles = [];
   for (let offset = 0; offset + 20 < vertexData.length; offset += 21) {
      const triangle = triangleAreaAndNormal(vertexData, offset);
      if (triangle) triangles.push(triangle);
   }

   return modes.flatMap((mode, modeIndex) => {
      const factor = LIGHT_MODE_FACTORS[modeIndex] ?? 1;
      const points = [];
      const tablePoints = [];

      for (const tilt of tiltValues) {
         const angle = tilt * Math.PI / 180;
         let valueSum = 0;
         let areaSum = 0;
         let tableValueSum = 0;
         let tableAreaSum = 0;

         for (const triangle of triangles) {
            const [, , normalZ] = rotateX(triangle.normal, angle);
            const returnWeight = Math.pow(clamp(normalZ, 0, 1), modeIndex === 1 ? 1.5 : 1);
            const weighted = triangle.area * returnWeight * factor;
            valueSum += weighted;
            areaSum += triangle.area;
            if (triangle.isTable) {
               tableValueSum += weighted;
               tableAreaSum += triangle.area;
            }
         }

         points.push({ tilt, value: areaSum ? (valueSum / areaSum) * 100 : 0 });
         if (hasTableFacet) {
            tablePoints.push({
               tilt,
               value: tableAreaSum ? (tableValueSum / tableAreaSum) * 100 : 0,
            });
         }
      }

      const output = [{ label: mode.label, color: mode.color, points }];
      if (hasTableFacet) {
         output.push({ label: `${mode.label} table`, color: mode.color, points: tablePoints, dashed: true });
      }
      return output;
   });
}

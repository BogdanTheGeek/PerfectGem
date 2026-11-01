import { buildBVH } from '../loaders.js';

const LUMA = [0.2126, 0.7152, 0.0722];
const EPSILON = 1e-4;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const cross = (a, b) => [
   a[1] * b[2] - a[2] * b[1],
   a[2] * b[0] - a[0] * b[2],
   a[0] * b[1] - a[1] * b[0],
];
const normalize = (v) => {
   const length = Math.hypot(v[0], v[1], v[2]) || 1;
   return [v[0] / length, v[1] / length, v[2] / length];
};
const reflect = (direction, normal) => sub(direction, scale(normal, 2 * dot(direction, normal)));

function refract(direction, normal, eta) {
   const cosI = clamp(-dot(direction, normal), 0, 1);
   const sin2T = eta * eta * (1 - cosI * cosI);
   if (sin2T >= 1) return null;
   return add(scale(direction, eta), scale(normal, eta * cosI - Math.sqrt(1 - sin2T)));
}

function rotateX(vector, radians) {
   const cos = Math.cos(radians);
   const sin = Math.sin(radians);
   return [vector[0], vector[1] * cos - vector[2] * sin, vector[1] * sin + vector[2] * cos];
}

function rotateY(vector, radians) {
   const cos = Math.cos(radians);
   const sin = Math.sin(radians);
   return [vector[0] * cos + vector[2] * sin, vector[1], -vector[0] * sin + vector[2] * cos];
}

function rotateZ(vector, radians) {
   const cos = Math.cos(radians);
   const sin = Math.sin(radians);
   return [vector[0] * cos - vector[1] * sin, vector[0] * sin + vector[1] * cos, vector[2]];
}

function rayAabb(origin, direction, node, offset) {
   let tMin = -Infinity;
   let tMax = Infinity;
   for (let axis = 0; axis < 3; axis++) {
      const inverse = 1 / direction[axis];
      let a = (node[offset + axis] - origin[axis]) * inverse;
      let b = (node[offset + 4 + axis] - origin[axis]) * inverse;
      if (a > b) [a, b] = [b, a];
      tMin = Math.max(tMin, a);
      tMax = Math.min(tMax, b);
   }
   return [tMin, tMax];
}

function rayTriangle(origin, direction, triangles, index) {
   const offset = index * 16;
   const v0 = [triangles[offset], triangles[offset + 1], triangles[offset + 2]];
   const edge1 = [triangles[offset + 4], triangles[offset + 5], triangles[offset + 6]];
   const edge2 = [triangles[offset + 8], triangles[offset + 9], triangles[offset + 10]];
   const h = cross(direction, edge2);
   const determinant = dot(edge1, h);
   if (Math.abs(determinant) < 1e-6) return -1;
   const inverse = 1 / determinant;
   const s = sub(origin, v0);
   const u = dot(s, h) * inverse;
   if (u < 0 || u > 1) return -1;
   const q = cross(s, edge1);
   const v = dot(direction, q) * inverse;
   if (v < 0 || u + v > 1) return -1;
   const distance = dot(edge2, q) * inverse;
   return distance >= EPSILON ? distance : -1;
}

function intersect(origin, direction, nodes, triangles) {
   let closest = Infinity;
   let triangleIndex = -1;
   const stack = [0];
   while (stack.length) {
      const nodeIndex = stack.pop();
      const offset = nodeIndex * 8;
      const [near, far] = rayAabb(origin, direction, nodes, offset);
      if (far < near || near > closest) continue;
      const leftOrStart = nodes[offset + 3] | 0;
      const countOrRight = nodes[offset + 7];
      if (countOrRight > 0) {
         for (let index = leftOrStart; index < leftOrStart + (countOrRight | 0); index++) {
            const distance = rayTriangle(origin, direction, triangles, index);
            if (distance > 0 && distance < closest) {
               closest = distance;
               triangleIndex = index;
            }
         }
      } else {
         stack.push((-countOrRight | 0) - 1, leftOrStart);
      }
   }
   if (triangleIndex < 0) return null;
   const offset = triangleIndex * 16;
   return {
      distance: closest,
      normal: [triangles[offset + 12], triangles[offset + 13], triangles[offset + 14]],
      frosted: triangles[offset + 15] > 0.5,
   };
}

function intersectConvex(origin, direction, facets) {
   let closest = Infinity;
   let result = null;
   for (const facet of facets) {
      const denominator = dot(facet.normal, direction);
      if (denominator <= 0) continue;
      const distance = (facet.d - dot(facet.normal, origin)) / denominator;
      if (distance > EPSILON && distance < closest) {
         closest = distance;
         result = { distance, normal: facet.normal, frosted: facet.frosted };
      }
   }
   return result;
}

function createConvexFacets(vertexData, sourceFacets = []) {
   const facets = sourceFacets
      .filter((facet) => Array.isArray(facet?.normal) && Number.isFinite(facet?.d))
      .map((facet) => ({
         normal: normalize(facet.normal),
         d: Number(facet.d),
         frosted: Boolean(facet.frosted),
      }));
   if (facets.length) return facets;

   for (let offset = 0; offset + 20 < vertexData.length; offset += 21) {
      const normal = normalize([vertexData[offset + 3], vertexData[offset + 4], vertexData[offset + 5]]);
      facets.push({
         normal,
         d: dot(normal, [vertexData[offset], vertexData[offset + 1], vertexData[offset + 2]]),
         frosted: vertexData[offset + 6] > 0.5,
      });
   }
   return facets;
}

function cauchyRi(ri, cod) {
   const b = cod * 306033;
   const a = ri - b / (589.3 * 589.3);
   return [a + b / (650 * 650), a + b / (510 * 510), a + b / (475 * 475)];
}

function environment(direction, mode) {
   const z = direction[2];
   if (z <= 0) return 0;
   if (z > 0.9848) return 0;
   if (mode === 0) return 1;
   if (mode === 1) return z;
   if (mode === 2) return 2 * Math.sqrt(Math.max(0, 1 - z * z)) * z;
   const hash = (x, y) => {
      let qx = ((x * 127.1) % 1 + 1) % 1;
      let qy = ((y * 311.7) % 1 + 1) % 1;
      const offset = qx * (qx + 17.43) + qy * (qy + 17.43);
      qx += offset;
      qy += offset;
      return ((qx * qy) % 1 + 1) % 1;
   };
   const u = direction[0] * 8.5 + 8.5;
   const v = direction[2] * 8.5 + 8.5;
   const cellX = Math.floor(u);
   const cellY = Math.floor(v);
   const fx = u - cellX;
   const fy = v - cellY;
   const smoothX = fx * fx * (3 - 2 * fx);
   const smoothY = fy * fy * (3 - 2 * fy);
   const a = hash(cellX, cellY);
   const b = hash(cellX + 1, cellY);
   const c = hash(cellX, cellY + 1);
   const d = hash(cellX + 1, cellY + 1);
   const sky = (a * (1 - smoothX) + b * smoothX) * (1 - smoothY)
      + (c * (1 - smoothX) + d * smoothX) * smoothY;
   return sky * 0.85
      + Math.max(0, direction[1]) ** 80 * 2.5
      + Math.max(0, dot(direction, [0.5, 0.7, 0.5])) ** 80 * 1.8
      + Math.max(0, dot(direction, [-0.57, 0.68, 0.46])) ** 60 * 1.5;
}

function trichroicTint(direction, axisColors, clearMix, axisTiltDeg) {
   const tilt = axisTiltDeg.map((degrees) => degrees * Math.PI / 180);
   const unit = normalize(rotateZ(rotateY(rotateX(normalize(direction), tilt[0]), tilt[1]), tilt[2]));
   const weights = [Math.abs(unit[0]), Math.abs(unit[1]), Math.abs(unit[2])];
   const total = Math.max(1e-5, weights[0] + weights[1] + weights[2]);
   return [0, 1, 2].map((channel) => (
      ((axisColors[0][channel] * weights[0]
         + axisColors[1][channel] * weights[1]
         + axisColors[2][channel] * weights[2]) / total) * (1 - clearMix)
      + clearMix
   ));
}

function effectiveStoneColor(axisColors, clearMix) {
   return [0, 1, 2].map((channel) => (
      ((axisColors[0][channel] + axisColors[1][channel] + axisColors[2][channel]) / 3) * (1 - clearMix)
      + clearMix
   ));
}

function clarityColorGrade(color, clarity) {
   const amount = clamp(clarity, 0, 1);
   const signed = (amount - 0.5) * 2;
   const luma = color[0] * LUMA[0] + color[1] * LUMA[1] + color[2] * LUMA[2];
   if (signed < 0) {
      const rich = -signed;
      return color.map((component) => (
         (luma + (component - luma) * (1 + rich * 1.25)) * (1 - rich * 0.5)
      ));
   }
   return color.map((component) => component * (1 - signed) + signed);
}

function fresnel(direction, normal, eta) {
   const cosI = clamp(-dot(direction, normal), 0, 1);
   const sin2T = eta * eta * (1 - cosI * cosI);
   if (sin2T >= 1) return 1;
   const cosT = Math.sqrt(1 - sin2T);
   const rs = (eta * cosI - cosT) / (eta * cosI + cosT);
   const rp = (cosI - eta * cosT) / (cosI + eta * cosT);
   return (rs * rs + rp * rp) * 0.5;
}

function traceConvexChannel(direction, origin, ri, mode, tilt, facets, channel, axisColors, clearMix, stoneColor, axisTiltDeg, rotationY = 0) {
   let ray = direction;
   let point = origin;
   let throughput = 1;
   let light = 0;
   let distance = 0;
   let windowLeak = 0;
   for (let bounce = 0; bounce < 10; bounce++) {
      const hit = intersectConvex(point, ray, facets);
      if (!hit) {
         light += throughput * environment(rotateY(rotateX(ray, tilt), rotationY), mode)
            * stoneColor[channel] * trichroicTint(ray, axisColors, clearMix, axisTiltDeg)[channel];
         break;
      }
      distance += hit.distance;
      let normal = normalize(hit.normal);
      if (dot(ray, normal) > 0) normal = scale(normal, -1);
      const reflectance = fresnel(ray, normal, ri);
      const escaped = refract(ray, normal, ri);
      const worldNormal = rotateY(rotateX(hit.normal, tilt), rotationY);
      if (worldNormal[2] < -0.1) {
         windowLeak += throughput * (1 - reflectance) * Math.max(0, -worldNormal[2]);
      }
      if (escaped) {
         light += throughput * environment(rotateY(rotateX(escaped, tilt), rotationY), mode)
            * stoneColor[channel] * trichroicTint(escaped, axisColors, clearMix, axisTiltDeg)[channel] * (1 - reflectance);
      }
      point = add(add(point, scale(ray, hit.distance)), scale(normal, EPSILON));
      ray = reflect(ray, normal);
      throughput *= reflectance;
      if (throughput < 0.001) break;
   }
   return { light, distance, windowLeak: clamp(windowLeak, 0, 1) };
}

function traceChannel(direction, origin, ri, mode, tilt, nodes, triangles, channel, axisColors, clearMix, stoneColor, axisTiltDeg, rotationY = 0) {
   let ray = direction;
   let point = origin;
   let throughput = 1;
   let light = 0;
   let distance = 0;
   let windowLeak = 0;
   for (let bounce = 0; bounce < 10; bounce++) {
      const hit = intersect(point, ray, nodes, triangles);
      if (!hit) {
         light += throughput * environment(rotateY(rotateX(ray, tilt), rotationY), mode)
            * stoneColor[channel] * trichroicTint(ray, axisColors, clearMix, axisTiltDeg)[channel];
         break;
      }
      distance += hit.distance;
      let normal = normalize(hit.normal);
      if (dot(ray, normal) > 0) normal = scale(normal, -1);
      if (hit.frosted) {
         light += throughput * (0.54 + 0.24 * Math.max(0, rotateY(rotateX(normal, tilt), rotationY)[2]));
         break;
      }
      const reflectance = fresnel(ray, normal, ri);
      const escaped = refract(ray, normal, ri);
      const worldNormal = rotateY(rotateX(hit.normal, tilt), rotationY);
      if (worldNormal[2] < -0.1) {
         windowLeak += throughput * (1 - reflectance) * Math.max(0, -worldNormal[2]);
      }
      if (escaped) {
         light += throughput * environment(rotateY(rotateX(escaped, tilt), rotationY), mode)
            * stoneColor[channel] * trichroicTint(escaped, axisColors, clearMix, axisTiltDeg)[channel] * (1 - reflectance);
      }
      point = add(add(point, scale(ray, hit.distance)), scale(normal, EPSILON));
      ray = reflect(ray, normal);
      throughput *= reflectance;
      if (throughput < 0.001) break;
   }
   return { light, distance, windowLeak: clamp(windowLeak, 0, 1) };
}

function sampleTile({ nodes, triangles, tilt, mode, sampleSize, ri, clarity, axisColors, axisTiltDeg, focalLength }) {
   const angle = tilt * Math.PI / 180;
   const cameraDistance = Math.max(0.1, focalLength / 10);
   const sensorHalf = 5 * Math.tan(Math.PI / 8) * 0.70;
   const origin = rotateX([0, 0, cameraDistance], -angle);
   const channels = cauchyRi(ri, clarity.cod);
   const colorDensity = Math.max(0, (0.5 - clarity.value) * 2);
   const clearMix = clamp((clarity.value - 0.5) * 2, 0, 1);
   const stoneColor = effectiveStoneColor(axisColors, clearMix);
   const clarityTint = clarityColorGrade(stoneColor, clarity.value);
   let sum = 0;
   let count = 0;
   let tableSum = 0;
   let tableCount = 0;
   for (let y = 0; y < sampleSize; y++) {
      const screenY = ((y + 0.5) / sampleSize * 2 - 1) * sensorHalf;
      for (let x = 0; x < sampleSize; x++) {
         const screenX = ((x + 0.5) / sampleSize * 2 - 1) * sensorHalf;
         const worldRay = normalize([screenX, -screenY, -cameraDistance]);
         const direction = rotateX(worldRay, -angle);
         const firstHit = intersect(origin, direction, nodes, triangles);
         if (!firstHit) continue;
         let normal = normalize(firstHit.normal);
         if (dot(direction, normal) > 0) normal = scale(normal, -1);
         const channelValues = channels.map((channelRi, channel) => {
            const f0 = ((channelRi - 1) / (channelRi + 1)) ** 2;
            const surfaceFresnel = f0 + (1 - f0) * (1 - clamp(-dot(direction, normal), 0, 1)) ** 5;
            const reflectedRay = reflect(direction, normal);
            const reflected = environment(rotateX(reflectedRay, angle), mode)
               * stoneColor[channel] * trichroicTint(reflectedRay, axisColors, clearMix, axisTiltDeg)[channel] * surfaceFresnel;
            const internalRay = refract(direction, normal, 1 / channelRi);
            if (!internalRay) return reflected;
            const traced = traceChannel(
               internalRay,
               add(origin, scale(direction, firstHit.distance)),
               channelRi,
               mode,
               angle,
               nodes,
               triangles,
               channel,
               axisColors,
               clearMix,
               stoneColor,
               axisTiltDeg,
            );
            return reflected + traced.light * Math.exp(-colorDensity * traced.distance)
               * clarityTint[channel] * (1 - surfaceFresnel);
         });
         const value = channelValues[0] * LUMA[0] + channelValues[1] * LUMA[1] + channelValues[2] * LUMA[2];
         sum += value;
         count++;
         if (Math.abs(firstHit.normal[2]) > 0.995) {
            tableSum += value;
            tableCount++;
         }
      }
   }
   return {
      value: count ? (sum / count) * 100 : 0,
      tableValue: tableCount ? (tableSum / tableCount) * 100 : 0,
   };
}

export function sampleSoftwareGraphSweep({
   vertexData,
   tiltValues,
   modes,
   hasTableFacet = false,
   material = {},
   sampleSize = 64,
}) {
   if (!(vertexData instanceof Float32Array)) {
      throw new TypeError('Software graph sampling requires Float32Array vertex data.');
   }
   const triangleCount = Math.floor(vertexData.length / 21);
   const { nodeBuffer, triBuffer } = buildBVH(vertexData, triangleCount);
   const clarity = { value: material.clarity ?? 0.5, cod: material.cod ?? 0.013 };
   const ri = material.ri ?? 1.544;
   const axisColors = [material.axisAColor, material.axisBColor, material.axisCColor]
      .map((color) => Array.isArray(color) ? color : [1, 1, 1]);
   const axisTiltDeg = [material.axisTiltXDeg ?? 0, material.axisTiltYDeg ?? 0, material.axisTiltZDeg ?? 0];
   const focalLength = material.focalLength ?? 200;
   return modes.flatMap((mode) => {
      const points = [];
      const tablePoints = [];
      for (const tilt of tiltValues) {
         const result = sampleTile({
            nodes: nodeBuffer,
            triangles: triBuffer,
            tilt,
            mode: mode.mode,
            sampleSize,
            ri,
            clarity,
            axisColors,
            axisTiltDeg,
            focalLength,
         });
         points.push({ tilt, value: result.value });
         if (hasTableFacet) tablePoints.push({ tilt, value: result.tableValue });
      }
      const series = [{ label: mode.label, color: mode.color, points }];
      if (hasTableFacet) series.push({ label: `${mode.label} table`, color: mode.color, points: tablePoints, dashed: true });
      return series;
   });
}

/**
 * Runs the same 64×64 optical tiles as the synchronous sampler, yielding
 * between tiles so a software graph refresh cannot starve the UI thread.
 */
export async function sampleSoftwareGraphSweepAsync(options, shouldContinue = () => true) {
   const {
      vertexData,
      tiltValues,
      modes,
      hasTableFacet = false,
      material = {},
      sampleSize = 64,
   } = options;
   if (!(vertexData instanceof Float32Array)) {
      throw new TypeError('Software graph sampling requires Float32Array vertex data.');
   }
   const triangleCount = Math.floor(vertexData.length / 21);
   const { nodeBuffer, triBuffer } = buildBVH(vertexData, triangleCount);
   const clarity = { value: material.clarity ?? 0.5, cod: material.cod ?? 0.013 };
   const ri = material.ri ?? 1.544;
   const axisColors = [material.axisAColor, material.axisBColor, material.axisCColor]
      .map((color) => Array.isArray(color) ? color : [1, 1, 1]);
   const axisTiltDeg = [material.axisTiltXDeg ?? 0, material.axisTiltYDeg ?? 0, material.axisTiltZDeg ?? 0];
   const focalLength = material.focalLength ?? 200;
   const seriesList = [];

   for (const mode of modes) {
      const points = [];
      const tablePoints = [];
      for (const tilt of tiltValues) {
         if (!shouldContinue()) return null;
         const result = sampleTile({
            nodes: nodeBuffer,
            triangles: triBuffer,
            tilt,
            mode: mode.mode,
            sampleSize,
            ri,
            clarity,
            axisColors,
            axisTiltDeg,
            focalLength,
         });
         points.push({ tilt, value: result.value });
         if (hasTableFacet) tablePoints.push({ tilt, value: result.tableValue });
         await new Promise((resolve) => setTimeout(resolve, 0));
      }
      seriesList.push({ label: mode.label, color: mode.color, points });
      if (hasTableFacet) {
         seriesList.push({ label: `${mode.label} table`, color: mode.color, points: tablePoints, dashed: true });
      }
   }
   return seriesList;
}

function acesTonemap(value) {
   return clamp((value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14), 0, 1);
}

function renderFlatTriangles({ canvas, triangles, material, rotation, stoneColor }) {
   const context = canvas.getContext('2d');
   const width = canvas.width;
   const height = canvas.height;
   const cameraDistance = Math.max(0.1, (material.focalLength ?? 200) / 10);
   const sensorHalf = 5 * Math.tan(Math.PI / 8) * 0.70;
   const background = material.backgroundColor ?? [0.05, 0.05, 0.05];
   context.fillStyle = `rgb(${background.map((value) => Math.round(value * 255)).join(',')})`;
   context.fillRect(0, 0, width, height);

   const lights = [
      { direction: [0.6, 0.4, 0.7], diffuse: 1, specular: 0.55, exponent: 22 },
      { direction: [-0.5, 0.3, 0.8], diffuse: 0.55, specular: 0.35, exponent: 18 },
      { direction: [0.1, -0.6, 0.6], diffuse: 0.35, specular: 0.20, exponent: 14 },
      { direction: [-0.2, 0.8, 0.3], diffuse: 0.25, specular: 0.15, exponent: 10 },
   ];
   const transform = (point) => rotateY(rotateX(point, rotation.x), rotation.y);
   const project = (point) => {
      const depth = cameraDistance - point[2];
      const scaleFactor = cameraDistance / (sensorHalf * Math.max(0.01, depth));
      return [width * (0.5 + point[0] * scaleFactor * 0.5), height * (0.5 - point[1] * scaleFactor * 0.5), depth];
   };
   const faces = [];

   for (let index = 0; index < triangles.length / 16; index++) {
      const offset = index * 16;
      const vertices = [
         transform([triangles[offset], triangles[offset + 1], triangles[offset + 2]]),
         transform([
            triangles[offset] + triangles[offset + 4],
            triangles[offset + 1] + triangles[offset + 5],
            triangles[offset + 2] + triangles[offset + 6],
         ]),
         transform([
            triangles[offset] + triangles[offset + 8],
            triangles[offset + 1] + triangles[offset + 9],
            triangles[offset + 2] + triangles[offset + 10],
         ]),
      ];
      const normal = normalize(transform([triangles[offset + 12], triangles[offset + 13], triangles[offset + 14]]));
      const center = scale(add(add(vertices[0], vertices[1]), vertices[2]), 1 / 3);
      const viewDirection = normalize([center[0], center[1], center[2] - cameraDistance]);
      if (dot(normal, viewDirection) >= 0) continue;
      let diffuse = 0.04 - 0.25;
      let specular = 0;
      for (const light of lights) {
         diffuse += Math.max(0, dot(normal, light.direction)) * light.diffuse;
         specular += Math.max(0, dot(normal, normalize(sub(light.direction, viewDirection)))) ** light.exponent * light.specular;
      }
      const ndotv = Math.max(0, dot(scale(viewDirection, -1), normal));
      const rim = (1 - ndotv) ** 4 * 0.25;
      const color = stoneColor.map((component) => (
         Math.round(acesTonemap((component * (diffuse * 0.6 + 0.4) + specular + rim) * 0.3) * 255)
      ));
      faces.push({ points: vertices.map(project), color, depth: center[2] });
   }

   faces.sort((a, b) => a.depth - b.depth);
   for (const face of faces) {
      context.beginPath();
      context.moveTo(face.points[0][0], face.points[0][1]);
      context.lineTo(face.points[1][0], face.points[1][1]);
      context.lineTo(face.points[2][0], face.points[2][1]);
      context.closePath();
      context.fillStyle = `rgb(${face.color.join(',')})`;
      context.fill();
   }
}

/**
 * CPU viewport renderer. It shares the BVH and optical path used by the
 * software graph sampler, and yields after scanline batches to keep controls
 * responsive while a software frame is being traced.
 */
export function createSoftwareRaytracer(stone) {
   if (!(stone?.vertexData instanceof Float32Array)) {
      throw new TypeError('Software ray tracing requires stone vertex data.');
   }
   const { nodeBuffer, triBuffer } = buildBVH(stone.vertexData, stone.triangleCount);
   let renderId = 0;

   return {
      async render({ canvas, material, rotation }) {
         const id = ++renderId;
         const sourceWidth = canvas.width;
         const sourceHeight = canvas.height;
         const clarity = { value: material.clarity ?? 0.5, cod: material.cod ?? 0.013 };
         const ri = material.ri ?? 1.544;
         const channels = cauchyRi(ri, clarity.cod);
         const clearMix = clamp((clarity.value - 0.5) * 2, 0, 1);
         const axisColors = [material.axisAColor, material.axisBColor, material.axisCColor]
            .map((color) => Array.isArray(color) ? color : [1, 1, 1]);
         const axisTiltDeg = [material.axisTiltXDeg ?? 0, material.axisTiltYDeg ?? 0, material.axisTiltZDeg ?? 0];
         const stoneColor = effectiveStoneColor(axisColors, clearMix);
         const clarityTint = clarityColorGrade(stoneColor, clarity.value);
         const angleX = rotation.x;
         const angleY = rotation.y;
         const cameraDistance = Math.max(0.1, (material.focalLength ?? 200) / 10);
         const sensorHalf = 5 * Math.tan(Math.PI / 8) * 0.70;
         const localOrigin = rotateX(rotateY([0, 0, cameraDistance], -angleY), -angleX);
         const mode = material.lightMode ?? 3;
         const background = material.backgroundColor ?? [0.05, 0.05, 0.05];
         const density = Math.max(0, (0.5 - clarity.value) * 2);
         if (mode > 3.5) {
            renderFlatTriangles({ canvas, triangles: triBuffer, material, rotation, stoneColor });
            return true;
         }
         const width = sourceWidth;
         const height = sourceHeight;
         const image = new ImageData(width, height);
         const data = image.data;

         for (let y = 0; y < height; y++) {
            const screenY = ((y + 0.5) / height * 2 - 1) * sensorHalf;
            for (let x = 0; x < width; x++) {
               const screenX = ((x + 0.5) / width * 2 - 1) * sensorHalf;
               const viewRay = normalize([screenX, -screenY, -cameraDistance]);
               const direction = rotateX(rotateY(viewRay, -angleY), -angleX);
               const hit = intersect(localOrigin, direction, nodeBuffer, triBuffer);
               const pixel = (y * width + x) * 4;
               if (!hit) {
                  data[pixel] = Math.round(background[0] * 255);
                  data[pixel + 1] = Math.round(background[1] * 255);
                  data[pixel + 2] = Math.round(background[2] * 255);
                  data[pixel + 3] = 255;
                  continue;
               }
               let normal = normalize(hit.normal);
               if (dot(direction, normal) > 0) normal = scale(normal, -1);
               const channelResults = channels.map((channelRi, channel) => {
                  const f0 = ((channelRi - 1) / (channelRi + 1)) ** 2;
                  const surfaceFresnel = f0 + (1 - f0) * (1 - clamp(-dot(direction, normal), 0, 1)) ** 5;
                  const reflectedRay = reflect(direction, normal);
                  const reflected = environment(rotateY(rotateX(reflectedRay, angleX), angleY), mode)
                     * stoneColor[channel] * trichroicTint(reflectedRay, axisColors, clearMix, axisTiltDeg)[channel]
                     * surfaceFresnel;
                  const internalRay = refract(direction, normal, 1 / channelRi);
                  if (!internalRay) return { value: reflected, windowLeak: 0 };
                  const traced = traceChannel(
                     internalRay,
                     add(localOrigin, scale(direction, hit.distance)),
                     channelRi,
                     mode,
                     angleX,
                     nodeBuffer,
                     triBuffer,
                     channel,
                     axisColors,
                     clearMix,
                     stoneColor,
                     axisTiltDeg,
                     angleY,
                  );
                  return {
                     value: reflected + traced.light * Math.exp(-density * traced.distance)
                        * clarityTint[channel] * (1 - surfaceFresnel),
                     windowLeak: traced.windowLeak,
                  };
               });
               const windowAmount = (channelResults[0].windowLeak + channelResults[1].windowLeak + channelResults[2].windowLeak) / 3;
               const windowColor = material.exitHighlight ?? [0, 0, 0];
               const exitStrength = material.exitStrength ?? 0;
               const color = channelResults.map((result, channel) => {
                  const base = result.value + windowColor[channel] * windowAmount * exitStrength;
                  const luminance = base * base * base * base;
                  return base + luminance * luminance * luminance * 10;
               });
               data[pixel] = Math.round(acesTonemap(color[0] * 1.5) * 255);
               data[pixel + 1] = Math.round(acesTonemap(color[1] * 1.5) * 255);
               data[pixel + 2] = Math.round(acesTonemap(color[2] * 1.5) * 255);
               data[pixel + 3] = 255;
            }
            if (y % 4 === 3) {
               await new Promise((resolve) => requestAnimationFrame(resolve));
               if (id !== renderId) return false;
            }
         }
         if (id !== renderId) return false;
         const context = canvas.getContext('2d');
         context.imageSmoothingEnabled = true;
         const scratch = document.createElement('canvas');
         scratch.width = width;
         scratch.height = height;
         scratch.getContext('2d').putImageData(image, 0, 0);
         context.clearRect(0, 0, sourceWidth, sourceHeight);
         context.drawImage(scratch, 0, 0, sourceWidth, sourceHeight);
         return true;
      },
      cancel() {
         renderId++;
      },
   };
}

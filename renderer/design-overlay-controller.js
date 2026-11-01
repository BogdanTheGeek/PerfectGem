import { mat4, vec4 } from '../gl-matrix/esm/index.js';
import { generateFacesFromFacetList, groupExternalFacetsForDesign } from '../loaders.js';

const EPSILON = 1e-8;

function subtract(a, b) {
   return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
   return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
   return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
   ];
}

function length(v) {
   return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v) {
   const magnitude = length(v);
   return magnitude > EPSILON ? v.map((component) => component / magnitude) : [0, 0, 0];
}

function pointKey(x, y, z) {
   return `${Math.round(x * 100000)}|${Math.round(y * 100000)}|${Math.round(z * 100000)}`;
}

/**
 * Renderer-neutral design picking, edge/vertex overlay, and orientation gizmo.
 * The renderer supplies matrices after every camera update; no graphics API
 * objects are shared with this controller.
 */
export function createDesignOverlayController({
   canvas,
   getStone,
   getCameraState,
   isDesignMode,
   onSelectionChanged,
   onModelUpdate,
   useOcclusionCulling = true,
   useFaceCulling = true,
   useProjectedFaceCulling = false,
   drawBaseEdges = true,
}) {
   if (!canvas || typeof getStone !== 'function' || typeof getCameraState !== 'function') {
      throw new TypeError('Design overlay requires canvas, getStone(), and getCameraState().');
   }

   const overlay = document.createElement('canvas');
   overlay.className = 'selectionOverlayCanvas';
   Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '80',
   });
   document.body.appendChild(overlay);
   const context = overlay.getContext('2d');
   const cache = { stone: null, vertices: [], edges: [], faces: [], radius: 1 };
   const selection = { vertexIds: [], edgeIds: [] };
   let hover = null;
   let lastPointer = { x: 0, y: 0 };
   let disposed = false;
   let animationFrame = 0;
   let press = null;

   function selectionPayload(nextHover = hover) {
      return {
         vertexIds: [...selection.vertexIds],
         edgeIds: [...selection.edgeIds],
         vertices: selection.vertexIds
            .map((id) => cache.vertices[id]?.point)
            .filter(Boolean)
            .map((point) => [...point]),
         edges: selection.edgeIds
            .map((id) => cache.edges[id])
            .filter(Boolean)
            .map((edge) => ({
               id: edge.id,
               points: [[...cache.vertices[edge.a].point], [...cache.vertices[edge.b].point]],
            })),
         hover: nextHover,
      };
   }

   function rebuild() {
      const stone = getStone();
      if (cache.stone === stone) return;
      cache.stone = stone;
      cache.vertices = [];
      cache.edges = [];
      cache.faces = [];
      const data = stone?.vertexData;
      if (!(data instanceof Float32Array)) return;
      const vertexIds = new Map();
      const edgeIds = new Map();
      let radius = 0;
      const edge = (a, b, faceId) => {
         const lo = Math.min(a, b), hi = Math.max(a, b), key = `${lo}|${hi}`;
         let id = edgeIds.get(key);
         if (id == null) {
            id = cache.edges.length;
            cache.edges.push({ id, a: lo, b: hi, faces: [] });
            edgeIds.set(key, id);
         }
         cache.edges[id].faces.push(faceId);
      };
      const gear = Math.max(1, Math.round(Number(stone.sourceGear) || 96));
      const designFacets = groupExternalFacetsForDesign(stone.facets || [], gear);
      const generatedFaces = generateFacesFromFacetList(designFacets, gear).faces || [];
      const meshFaces = generatedFaces.length ? generatedFaces : Array.from(
         { length: Math.floor(data.length / 21) },
         (_, index) => ({
            vertices: [[data[index * 21], data[index * 21 + 1], data[index * 21 + 2]],
               [data[index * 21 + 7], data[index * 21 + 8], data[index * 21 + 9]],
               [data[index * 21 + 14], data[index * 21 + 15], data[index * 21 + 16]]],
            sourceFacetOrder: -1,
         }),
      );
      for (const meshFace of meshFaces) {
         const ids = meshFace.vertices.map(([x, y, z]) => vertexFromPoint(x, y, z));
         if (ids.length < 3) continue;
         const points = ids.map((id) => cache.vertices[id].point);
         const normal = normalize(meshFace.normal || cross(subtract(points[1], points[0]), subtract(points[2], points[0])));
         const faceId = cache.faces.length;
         cache.faces.push({
            id: faceId,
            vertices: ids,
            normal,
            center: points.reduce((out, point) => out.map((value, i) => value + point[i] / points.length), [0, 0, 0]),
            sourceFacetOrder: Number.isFinite(Number(meshFace.sourceFacetOrder)) ? Number(meshFace.sourceFacetOrder) : -1,
            sourceGearIndex: Number.isFinite(Number(meshFace.sourceGearIndex)) ? Number(meshFace.sourceGearIndex) : null,
         });
         ids.forEach((id) => cache.vertices[id].faces.push(faceId));
         for (let index = 0; index < ids.length; index++) {
            edge(ids[index], ids[(index + 1) % ids.length], faceId);
         }
      }
      if (cache.vertices.length) {
         const center = cache.vertices.reduce(
            (total, vertex) => total.map((value, index) => value + vertex.point[index] / cache.vertices.length),
            [0, 0, 0],
         );
         for (const face of cache.faces) {
            if (dot(face.normal, subtract(face.center, center)) < 0) {
               face.normal = face.normal.map((component) => -component);
            }
         }
      }
      cache.radius = Math.max(0.1, radius);
      selection.vertexIds = [];
      selection.edgeIds = [];
      onSelectionChanged?.(selectionPayload(null));

      function vertexFromPoint(x, y, z) {
         const key = pointKey(x, y, z);
         if (vertexIds.has(key)) return vertexIds.get(key);
         const id = cache.vertices.length;
         cache.vertices.push({ id, point: [x, y, z], faces: [] });
         radius = Math.max(radius, Math.hypot(x, y, z));
         vertexIds.set(key, id);
         return id;
      }
   }

   function state() {
      const value = getCameraState();
      if (!value?.modelMatrix || !value?.viewMatrix || !value?.projectionMatrix) return null;
      const model = value.modelMatrix;
      const view = value.viewMatrix;
      const projection = value.projectionMatrix;
      const viewProjection = mat4.create();
      const inverseViewProjection = mat4.create();
      const inverseModel = mat4.create();
      mat4.multiply(viewProjection, projection, view);
      if (!mat4.invert(inverseViewProjection, viewProjection) || !mat4.invert(inverseModel, model)) return null;
      return { ...value, model, view, projection, inverseViewProjection, inverseModel };
   }

   function project(point, camera) {
      const rect = canvas.getBoundingClientRect();
      const v = vec4.fromValues(point[0], point[1], point[2], 1);
      vec4.transformMat4(v, v, camera.model);
      vec4.transformMat4(v, v, camera.view);
      vec4.transformMat4(v, v, camera.projection);
      if (Math.abs(v[3]) < EPSILON) return null;
      const x = v[0] / v[3], y = v[1] / v[3], z = v[2] / v[3];
      if (z < -1.2 || z > 1.2) return null;
      return { x: rect.left + (x + 1) * rect.width / 2, y: rect.top + (1 - y) * rect.height / 2 };
   }

   function ray(clientX, clientY, camera) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = (clientX - rect.left) / rect.width * 2 - 1;
      const y = 1 - (clientY - rect.top) / rect.height * 2;
      const unproject = (z) => {
         const v = vec4.fromValues(x, y, z, 1);
         vec4.transformMat4(v, v, camera.inverseViewProjection);
         if (Math.abs(v[3]) < EPSILON) return null;
         v[0] /= v[3]; v[1] /= v[3]; v[2] /= v[3]; v[3] = 1;
         vec4.transformMat4(v, v, camera.inverseModel);
         if (Math.abs(v[3]) < EPSILON) return null;
         return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
      };
      const near = unproject(-1), far = unproject(1);
      return near && far ? { origin: near, direction: normalize(subtract(far, near)) } : null;
   }

   function raySegmentDistance(rayOrigin, rayDirection, a, b) {
      const segment = subtract(b, a);
      const w = subtract(rayOrigin, a);
      const aa = dot(rayDirection, rayDirection);
      const bb = dot(rayDirection, segment);
      const cc = dot(segment, segment);
      const dd = dot(rayDirection, w);
      const ee = dot(segment, w);
      const denominator = aa * cc - bb * bb;
      let rayT = 0;
      let segmentT = 0;
      if (Math.abs(denominator) > EPSILON && cc > EPSILON) {
         rayT = (bb * ee - cc * dd) / denominator;
         segmentT = Math.max(0, Math.min(1, (aa * ee - bb * dd) / denominator));
      } else if (cc > EPSILON) {
         segmentT = Math.max(0, Math.min(1, ee / cc));
      }
      if (rayT < 0) {
         rayT = 0;
         segmentT = cc > EPSILON ? Math.max(0, Math.min(1, ee / cc)) : 0;
      }
      const onRay = rayOrigin.map((value, index) => value + rayDirection[index] * rayT);
      const onSegment = a.map((value, index) => value + segment[index] * segmentT);
      return { distance: length(subtract(onRay, onSegment)), rayT };
   }

   function visibleFaces(camera) {
      if (useProjectedFaceCulling) {
         const areas = cache.faces.map((face) => {
            let area = 0;
            const points = face.vertices.map((id) => project(cache.vertices[id].point, camera));
            if (points.some((point) => !point)) return 0;
            for (let index = 0; index < points.length; index++) {
               const a = points[index];
               const b = points[(index + 1) % points.length];
               area += a.x * b.y - b.x * a.y;
            }
            return area;
         });
         const reference = areas.reduce((best, area) => Math.abs(area) > Math.abs(best) ? area : best, 0);
         return areas.map((area) => Math.abs(area) > EPSILON && area * reference > 0);
      }
      const position = vec4.fromValues(...(camera.cameraPosition || [0, 0, 10]), 1);
      vec4.transformMat4(position, position, camera.inverseModel);
      if (Math.abs(position[3]) < EPSILON) return [];
      const point = [position[0] / position[3], position[1] / position[3], position[2] / position[3]];
      return cache.faces.map((face) => dot(face.normal, subtract(point, face.center)) > EPSILON);
   }

   function modelCameraPosition(camera) {
      const position = vec4.fromValues(...(camera.cameraPosition || [0, 0, 10]), 1);
      vec4.transformMat4(position, position, camera.inverseModel);
      if (Math.abs(position[3]) < EPSILON) return null;
      return [position[0] / position[3], position[1] / position[3], position[2] / position[3]];
   }

   function faceRayIntersection(rayOrigin, rayDirection, face) {
      const first = cache.vertices[face.vertices[0]]?.point;
      const denominator = dot(face.normal, rayDirection);
      if (!first || Math.abs(denominator) < EPSILON) return null;
      const rayT = dot(face.normal, subtract(first, rayOrigin)) / denominator;
      if (rayT < 0) return null;
      const point = rayOrigin.map((value, index) => value + rayDirection[index] * rayT);
      let sign = 0;
      for (let index = 0; index < face.vertices.length; index++) {
         const a = cache.vertices[face.vertices[index]]?.point;
         const b = cache.vertices[face.vertices[(index + 1) % face.vertices.length]]?.point;
         if (!a || !b) return null;
         const side = dot(face.normal, cross(subtract(b, a), subtract(point, a)));
         if (Math.abs(side) < EPSILON) continue;
         const next = Math.sign(side);
         if (sign && sign !== next) return null;
         sign = next;
      }
      return { rayT };
   }

   function isPointVisible(point, camera) {
      const origin = modelCameraPosition(camera);
      if (!origin) return false;
      const offset = subtract(point, origin);
      const distance = length(offset);
      if (distance < EPSILON) return true;
      const direction = offset.map((component) => component / distance);
      const epsilon = Math.max(1e-5, cache.radius * 1e-4);
      for (const face of cache.faces) {
         const hit = faceRayIntersection(origin, direction, face);
         if (hit && hit.rayT < distance - epsilon) return false;
      }
      return true;
   }

   function isVertexVisible(vertex, camera, faceVisibility) {
      return (!useFaceCulling || vertex.faces.some((faceId) => faceVisibility[faceId]))
         && (!useOcclusionCulling || isPointVisible(vertex.point, camera));
   }

   function isEdgeVisible(edge, camera, faceVisibility) {
      if (useFaceCulling && !edge.faces.some((faceId) => faceVisibility[faceId])) return false;
      if (!useOcclusionCulling) return true;
      const a = cache.vertices[edge.a].point;
      const b = cache.vertices[edge.b].point;
      return isPointVisible(a.map((value, index) => (value + b[index]) / 2), camera);
   }

   function pick(clientX, clientY) {
      rebuild();
      const camera = state();
      const cursorRay = camera && ray(clientX, clientY, camera);
      if (!cursorRay) return null;
      const faces = visibleFaces(camera);
      const threshold = cache.radius * 0.025;
      let hit = null;
      for (const vertex of cache.vertices) {
         if (!isVertexVisible(vertex, camera, faces)) continue;
         const offset = subtract(vertex.point, cursorRay.origin);
         const t = Math.max(0, dot(offset, cursorRay.direction));
         const distance = length(subtract(vertex.point, cursorRay.origin.map((v, i) => v + cursorRay.direction[i] * t)));
         if (distance <= threshold && (!hit || distance < hit.distance)) hit = { type: 'vertex', id: vertex.id, distance };
      }

      if (hit) return hit;
      for (const edge of cache.edges) {
         if (!isEdgeVisible(edge, camera, faces)) continue;
         const a = cache.vertices[edge.a].point, b = cache.vertices[edge.b].point;
         const candidate = raySegmentDistance(cursorRay.origin, cursorRay.direction, a, b);
         if (candidate.distance <= threshold && (!hit || candidate.distance < hit.distance)) {
            hit = { type: 'edge', id: edge.id, distance: candidate.distance };
         }
      }
      if (hit) return hit;
      for (const face of cache.faces) {
         if (useFaceCulling && !faces[face.id]) continue;
         const candidate = faceRayIntersection(cursorRay.origin, cursorRay.direction, face);
         if (candidate && (!hit || candidate.rayT < hit.rayT)) {
            hit = { type: 'face', id: face.id, distance: 0, rayT: candidate.rayT };
         }
      }
      return hit;
   }

   function drawGizmo(camera) {
      const center = { x: window.innerWidth - 68, y: window.innerHeight - 68 };
      const axes = [
         ['X', '#f55', camera.model[0], camera.model[1]],
         ['Y', '#5f5', camera.model[4], camera.model[5]],
         ['Z', '#58f', camera.model[8], camera.model[9]],
      ];
      context.save();
      context.lineWidth = 2;
      context.font = '11px system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const [label, color, dx, dy] of axes) {
         const end = { x: center.x + dx * 28, y: center.y - dy * 28 };
         context.strokeStyle = color;
         context.fillStyle = color;
         context.beginPath();
         context.moveTo(center.x, center.y);
         context.lineTo(end.x, end.y);
         context.stroke();
         context.fillText(label, end.x, end.y);
      }
      context.restore();
   }

   function drawGearHalo(camera) {
      const stone = cache.stone;
      if (!stone || !cache.vertices.length) return;
      let minZ = Infinity, maxZ = -Infinity, radius = 0;
      for (const vertex of cache.vertices) {
         minZ = Math.min(minZ, vertex.point[2]);
         maxZ = Math.max(maxZ, vertex.point[2]);
         radius = Math.max(radius, Math.hypot(vertex.point[0], vertex.point[1]));
      }
      const gear = Math.max(1, Math.round(Number(stone.sourceGear) || 96));
      const haloRadius = radius + Math.max(.02, cache.radius * .06);
      const z = (minZ + maxZ) / 2;
      context.save();
      context.strokeStyle = 'rgba(120,220,255,.48)';
      context.lineWidth = 1.5;
      context.beginPath();
      for (let index = 0; index <= Math.max(96, gear * 3); index++) {
         const angle = index / Math.max(96, gear * 3) * Math.PI * 2;
         const point = project([haloRadius * Math.sin(angle), -haloRadius * Math.cos(angle), z], camera);
         if (!point) continue;
         if (index === 0) context.moveTo(point.x, point.y);
         else context.lineTo(point.x, point.y);
      }
      context.stroke();
      context.font = '11px system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = 'rgba(205,242,255,.97)';
      const step = gear <= 24 ? 1 : gear <= 72 ? 2 : Math.max(4, Math.ceil(gear / 36));
      for (let index = 0; index < gear; index += step) {
         const angle = index / gear * Math.PI * 2;
         const point = project([haloRadius * 1.06 * Math.sin(angle), -haloRadius * 1.06 * Math.cos(angle), z], camera);
         if (point) context.fillText(String(index || gear), point.x, point.y);
      }
      context.restore();
   }

   function drawTooltip() {
      const selectedEdge = selection.edgeIds.length === 1 && cache.edges[selection.edgeIds[0]];
      const selectedVertex = selection.vertexIds.length === 1 && cache.vertices[selection.vertexIds[0]];
      const face = hover?.type === 'face' && cache.faces[hover.id];
      let line = '';
      if (selectedEdge) {
         const a = cache.vertices[selectedEdge.a].point, b = cache.vertices[selectedEdge.b].point;
         line = `Edge length: ${length(subtract(a, b)).toFixed(5)}`;
      } else if (selectedVertex) {
         line = `Vertex distance: ${length(selectedVertex.point).toFixed(5)}`;
      } else if (face) {
         line = `Facet ${face.sourceFacetOrder >= 0 ? face.sourceFacetOrder + 1 : face.id + 1}`;
      }
      if (!line) return;
      context.save();
      context.font = '12px system-ui, sans-serif';
      const width = context.measureText(line).width + 16;
      const x = Math.min(window.innerWidth - width - 8, Math.max(8, lastPointer.x + 14));
      const y = Math.min(window.innerHeight - 30, Math.max(8, lastPointer.y + 14));
      context.fillStyle = 'rgba(0,0,0,.78)';
      context.fillRect(x, y, width, 25);
      context.fillStyle = '#fff';
      context.fillText(line, x + 8, y + 16);
      context.restore();
   }

   function draw() {
      if (disposed) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, window.innerWidth), height = Math.max(1, window.innerHeight);
      if (overlay.width !== Math.round(width * dpr) || overlay.height !== Math.round(height * dpr)) {
         overlay.width = Math.round(width * dpr);
         overlay.height = Math.round(height * dpr);
         overlay.style.width = `${width}px`;
         overlay.style.height = `${height}px`;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const camera = state();
      if (!camera) return;
      drawGizmo(camera);
      if (!isDesignMode?.()) return;
      rebuild();
      drawGearHalo(camera);
      const edgeIds = new Set(selection.edgeIds);
      const vertexIds = new Set(selection.vertexIds);
      const faceVisibility = visibleFaces(camera);
      const visibleEdgeIds = new Set();
      for (const edge of cache.edges) {
         if (isEdgeVisible(edge, camera, faceVisibility)) {
            visibleEdgeIds.add(edge.id);
         }
      }
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(0,0,0,.82)';
      if (drawBaseEdges) {
         for (const edge of cache.edges) {
            if (!visibleEdgeIds.has(edge.id)) continue;
            const a = project(cache.vertices[edge.a].point, camera), b = project(cache.vertices[edge.b].point, camera);
            if (!a || !b) continue;
            context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
         }
      }
      for (const edge of cache.edges) {
         if (!visibleEdgeIds.has(edge.id)) continue;
         if (!edgeIds.has(edge.id) && !(hover?.type === 'edge' && hover.id === edge.id)) continue;
         const a = project(cache.vertices[edge.a].point, camera), b = project(cache.vertices[edge.b].point, camera);
         if (!a || !b) continue;
         context.strokeStyle = '#28ff78'; context.lineWidth = edgeIds.has(edge.id) ? 3 : 2;
         context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
      for (const vertex of cache.vertices) {
         if (!isVertexVisible(vertex, camera, faceVisibility)) continue;
         if (!vertexIds.has(vertex.id) && !(hover?.type === 'vertex' && hover.id === vertex.id)) continue;
         const point = project(vertex.point, camera);
         if (!point) continue;
         context.fillStyle = '#28ff78'; context.beginPath(); context.arc(point.x, point.y, vertexIds.has(vertex.id) ? 6 : 4, 0, Math.PI * 2); context.fill();
      }
      drawTooltip();
   }

   const move = (event) => {
      if (!isDesignMode?.()) return;
      lastPointer = { x: event.clientX, y: event.clientY };
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3) press.moved = true;
      if (!press?.moved) hover = pick(event.clientX, event.clientY);
      draw();
   };
   const down = (event) => {
      if (!isDesignMode?.() || event.button !== 0) return;
      press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
   };
   const up = (event) => {
      if (!press || event.pointerId !== press.pointerId) return;
      if (!press.moved) {
         hover = pick(event.clientX, event.clientY);
         if (!hover || hover.type === 'face') {
            selection.vertexIds = [];
            selection.edgeIds = [];
         } else if (hover.type === 'vertex' && !selection.vertexIds.includes(hover.id)) {
            selection.vertexIds.push(hover.id);
         } else if (hover.type === 'edge' && !selection.edgeIds.includes(hover.id)) {
            selection.edgeIds.push(hover.id);
         }
         onSelectionChanged?.(selectionPayload(hover));
      }
      press = null;
      draw();
   };
   canvas.addEventListener('pointermove', move, true);
   canvas.addEventListener('pointerdown', down, true);
   canvas.addEventListener('pointerup', up, true);
   canvas.addEventListener('pointercancel', up, true);
   window.addEventListener('resize', draw);
   const animate = () => {
      if (disposed) return;
      if (isDesignMode?.()) draw();
      animationFrame = requestAnimationFrame(animate);
   };
   animationFrame = requestAnimationFrame(animate);

   return Object.freeze({
      draw,
      invalidate() { cache.stone = null; draw(); },
      setModel(stone) {
         cache.stone = null;
         rebuild();
         onModelUpdate?.(stone);
         draw();
      },
      getSelection() { return selectionPayload(); },
      dispose() {
         disposed = true;
         canvas.removeEventListener('pointermove', move, true);
         canvas.removeEventListener('pointerdown', down, true);
         canvas.removeEventListener('pointerup', up, true);
         canvas.removeEventListener('pointercancel', up, true);
         window.removeEventListener('resize', draw);
         cancelAnimationFrame(animationFrame);
         overlay.remove();
      },
   });
}

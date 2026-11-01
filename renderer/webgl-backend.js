import { createRendererBackend } from './contracts.js';

function compileShader(gl, type, source) {
   const shader = gl.createShader(type);
   gl.shaderSource(shader, source);
   gl.compileShader(shader);
   if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || 'unknown';
      gl.deleteShader(shader);
      throw new Error(`WebGL shader compile failed: ${log}`);
   }
   return shader;
}

const MAX_RAY_TRIANGLES = 256;

function createWebGLPreviewBackend({
   gl,
   canvas,
   mat4,
   computeMeshBoundsRadius,
   isWebGL2,
   getViewportLayout = (scale) => ({
      pixelWidth: Math.max(2, Math.floor(window.innerWidth * scale)),
      pixelHeight: Math.max(2, Math.floor(window.innerHeight * scale)),
   }),
}) {
   const vertexShaderSource = isWebGL2 ? `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform mat4 uMvp;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vLocalPos;
void main() {
  vLocalPos = aPos;
  vNormal = aNormal;
  gl_Position = uMvp * vec4(aPos, 1.0);
}` : `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMvp;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize((uModel * vec4(aNormal, 0.0)).xyz);
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

   const fragmentShaderSource = isWebGL2 ? `#version 300 es
precision highp float;
#define MAX_TRIANGLES ${MAX_RAY_TRIANGLES}
in vec3 vNormal;
in vec3 vLocalPos;
uniform vec3 uBaseColor;
uniform mat4 uModel;
uniform mat4 uView;
uniform vec3 uCameraLocal;
uniform float uRi;
uniform float uCod;
uniform float uClarity;
uniform float uLightMode;
uniform vec3 uHeadShadowColor;
uniform vec3 uExitHighlight;
uniform float uExitStrength;
uniform vec3 uAxisAColor;
uniform vec3 uAxisBColor;
uniform vec3 uAxisCColor;
uniform vec3 uAxisTiltDeg;
uniform int uTriangleCount;
uniform vec4 uTriangles[MAX_TRIANGLES * 3];
out vec4 outColor;

float intersectTriangle(vec3 ro, vec3 rd, int index) {
  vec3 a = uTriangles[index * 3].xyz;
  vec3 b = uTriangles[index * 3 + 1].xyz;
  vec3 c = uTriangles[index * 3 + 2].xyz;
  vec3 edge1 = b - a;
  vec3 edge2 = c - a;
  vec3 p = cross(rd, edge2);
  float determinant = dot(edge1, p);
  if (abs(determinant) < 0.00001) return -1.0;
  vec3 t = ro - a;
  float u = dot(t, p) / determinant;
  if (u < 0.0 || u > 1.0) return -1.0;
  vec3 q = cross(t, edge1);
  float v = dot(rd, q) / determinant;
  if (v < 0.0 || u + v > 1.0) return -1.0;
  float distance = dot(edge2, q) / determinant;
  return distance > 0.0008 ? distance : -1.0;
}

float hash21(vec2 p) {
  vec2 q = fract(p * vec2(127.1, 311.7));
  q += dot(q, q + 17.43);
  return fract(q.x * q.y);
}

float randomSky(vec3 direction) {
  vec2 uv = direction.xz * 8.5 + 8.5;
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  vec2 smoothF = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), smoothF.x),
    mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0, 1.0)), smoothF.x),
    smoothF.y
  );
}

vec3 environmentColor(vec3 localDirection) {
  vec3 direction = normalize((uView * uModel * vec4(localDirection, 0.0)).xyz);
  float intensity = 0.0;
  if (uLightMode < 0.5) {
    intensity = direction.z > 0.0 ? 1.0 : 0.0;
  } else if (uLightMode < 1.5) {
    intensity = max(0.0, direction.z);
  } else if (uLightMode < 2.5) {
    float sinTheta = sqrt(max(0.0, 1.0 - direction.z * direction.z));
    intensity = 2.0 * sinTheta * max(0.0, direction.z);
  } else {
    if (direction.z > 0.0) {
      intensity = randomSky(direction) * 0.85;
      intensity += pow(max(0.0, dot(direction, vec3(0.0, 1.0, 0.0))), 80.0) * 2.5;
      intensity += pow(max(0.0, dot(direction, vec3(0.5, 0.7, 0.5))), 80.0) * 1.8;
      intensity += pow(max(0.0, dot(direction, vec3(-0.57, 0.68, 0.46))), 60.0) * 1.5;
    }
  }
  vec3 shadow = direction.z > 0.9848 ? uHeadShadowColor : vec3(1.0);
  vec3 tableAmbient = uLightMode > 2.5
    ? vec3(0.06) * max(0.0, -direction.z + 0.25)
    : vec3(0.0);
  return uBaseColor * intensity * shadow + tableAmbient;
}

vec3 rotateX(vec3 p, float angle) {
  float c = cos(angle); float s = sin(angle);
  return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}

vec3 rotateY(vec3 p, float angle) {
  float c = cos(angle); float s = sin(angle);
  return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

vec3 rotateZ(vec3 p, float angle) {
  float c = cos(angle); float s = sin(angle);
  return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
}

vec3 stoneTint(vec3 direction) {
  vec3 d = rotateZ(rotateY(rotateX(normalize(direction), radians(uAxisTiltDeg.x)), radians(uAxisTiltDeg.y)), radians(uAxisTiltDeg.z));
  float wa = abs(d.x);
  float wb = abs(d.y);
  float wc = abs(d.z);
  vec3 tint = (uAxisAColor * wa + uAxisBColor * wb + uAxisCColor * wc) / max(wa + wb + wc, 0.00001);
  return mix(tint, vec3(1.0), clamp((uClarity - 0.5) * 2.0, 0.0, 1.0));
}

vec3 applyClarityGrade(vec3 color) {
  float t = (clamp(uClarity, 0.0, 1.0) - 0.5) * 2.0;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 gray = vec3(luma);
  vec3 rich = (gray + (color - gray) * (1.0 + max(0.0, -t) * 1.25)) * (1.0 - max(0.0, -t) * 0.5);
  return max(t >= 0.0 ? mix(color, vec3(1.0), t) : rich, vec3(0.0));
}

vec3 acesTonemap(vec3 color) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);
}

vec3 traceInternal(vec3 origin, vec3 direction, float ri, out float windowLeak, out float totalDistance) {
  vec3 throughput = vec3(1.0);
  vec3 result = vec3(0.0);
  windowLeak = 0.0;
  totalDistance = 0.0;
  for (int bounce = 0; bounce < 10; bounce++) {
    float nearest = 1e20;
    int hitIndex = -1;
    for (int i = 0; i < MAX_TRIANGLES; i++) {
      if (i >= uTriangleCount) break;
      float distance = intersectTriangle(origin, direction, i);
      if (distance > 0.0 && distance < nearest) {
        nearest = distance;
        hitIndex = i;
      }
    }
    if (hitIndex < 0) {
      result += throughput * environmentColor(direction);
      break;
    }
    vec3 a = uTriangles[hitIndex * 3].xyz;
    vec3 b = uTriangles[hitIndex * 3 + 1].xyz;
    vec3 c = uTriangles[hitIndex * 3 + 2].xyz;
    vec3 geometricNormal = normalize(cross(b - a, c - a));
    vec3 n = geometricNormal;
    if (dot(direction, n) > 0.0) n = -n;
    totalDistance += nearest;
    float cosI = max(0.0, dot(-direction, n));
    float sinTransmitted2 = ri * ri * (1.0 - cosI * cosI);
    float cosT = sqrt(max(0.0, 1.0 - sinTransmitted2));
    float rs = (ri * cosI - cosT) / max(0.00001, ri * cosI + cosT);
    float rp = (cosI - ri * cosT) / max(0.00001, cosI + ri * cosT);
    float fresnel = sinTransmitted2 >= 1.0 ? 1.0 : 0.5 * (rs * rs + rp * rp);
    float outZ = (uModel * vec4(geometricNormal, 0.0)).z;
    if (outZ < -0.1) windowLeak += throughput.r * (1.0 - fresnel) * max(0.0, -outZ);
    vec3 exitDirection = refract(direction, n, ri);
    if (length(exitDirection) > 0.001) {
      result += throughput * environmentColor(exitDirection) * (1.0 - fresnel);
    }
    origin += direction * nearest + n * 0.0001;
    direction = reflect(direction, n);
    throughput *= fresnel;
    if (all(lessThan(throughput, vec3(0.001)))) break;
  }
  return result;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 viewDirection = normalize(uCameraLocal - vLocalPos);
  vec3 incoming = -viewDirection;
  if (uLightMode > 3.5) {
    vec3 light0 = normalize(vec3(0.6, 0.4, 0.7));
    vec3 light1 = normalize(vec3(-0.5, 0.3, 0.8));
    float diffuse = 0.12 + max(0.0, dot(n, light0)) + max(0.0, dot(n, light1)) * 0.55;
    float specular = pow(max(0.0, dot(reflect(-light0, n), viewDirection)), 22.0) * 0.55;
    outColor = vec4(acesTonemap(applyClarityGrade(stoneTint(n) * diffuse * 0.55 + vec3(specular)) * 0.3), 1.0);
    return;
  }
  float cauchyB = uCod * 306033.0;
  float cauchyA = uRi - cauchyB / (589.3 * 589.3);
  vec3 ri = vec3(
    cauchyA + cauchyB / (650.0 * 650.0),
    cauchyA + cauchyB / (510.0 * 510.0),
    cauchyA + cauchyB / (475.0 * 475.0)
  );
  vec3 refractedR = refract(incoming, n, 1.0 / max(ri.r, 1.01));
  vec3 refractedG = refract(incoming, n, 1.0 / max(ri.g, 1.01));
  vec3 refractedB = refract(incoming, n, 1.0 / max(ri.b, 1.01));
  float f0 = pow((ri.g - 1.0) / (ri.g + 1.0), 2.0);
  float fresnel = f0 + (1.0 - f0) * pow(1.0 - clamp(dot(n, viewDirection), 0.0, 1.0), 5.0);
  vec3 reflectedDirection = reflect(incoming, n);
  vec3 reflected = environmentColor(reflectedDirection) * stoneTint(reflectedDirection);
  float windowR = 0.0;
  float windowG = 0.0;
  float windowB = 0.0;
  float distR = 0.0;
  float distG = 0.0;
  float distB = 0.0;
  vec3 internal = vec3(
    length(refractedR) > 0.001 ? traceInternal(vLocalPos, refractedR, ri.r, windowR, distR).r : reflected.r,
    length(refractedG) > 0.001 ? traceInternal(vLocalPos, refractedG, ri.g, windowG, distG).g : reflected.g,
    length(refractedB) > 0.001 ? traceInternal(vLocalPos, refractedB, ri.b, windowB, distB).b : reflected.b
  );
  float colorDensity = max(0.0, (0.5 - clamp(uClarity, 0.0, 1.0)) * 2.0);
  float transmission = exp(-colorDensity * ((distR + distG + distB) / 3.0));
  vec3 finalInternal = internal * transmission * applyClarityGrade(uBaseColor);
  vec3 color = reflected * fresnel + finalInternal * (1.0 - fresnel);
  float windowAmount = clamp((windowR + windowG + windowB) / 3.0, 0.0, 1.0);
  color += uExitHighlight * windowAmount * uExitStrength * (1.0 - fresnel);
  outColor = vec4(acesTonemap(applyClarityGrade(color) * 1.5), 1.0);
}` : `
precision mediump float;
varying vec3 vNormal;
varying vec3 vWorldPos;
uniform vec3 uBaseColor;
void main() {
  vec3 lightDir = normalize(vec3(0.35, 0.5, 1.0));
  vec3 n = normalize(vNormal);
  float diffuse = max(dot(n, lightDir), 0.0);
  float ambient = 0.12;
  vec3 viewDir = normalize(vec3(0.0, 0.0, 3.0) - vWorldPos);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  vec3 refractTint = mix(uBaseColor * 0.6, vec3(1.0), fresnel * 0.7);
  vec3 color = refractTint * (ambient + diffuse * 0.7) + vec3(0.7, 0.85, 1.0) * fresnel * 0.35;
  float alpha = clamp(0.35 + diffuse * 0.25 + fresnel * 0.2, 0.35, 0.9);
  gl_FragColor = vec4(color, alpha);
}`;

   const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
   const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
   const program = gl.createProgram();
   gl.attachShader(program, vertexShader);
   gl.attachShader(program, fragmentShader);
   gl.linkProgram(program);
   if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program) || 'unknown'}`);
   }
   gl.useProgram(program);
   gl.deleteShader(vertexShader);
   gl.deleteShader(fragmentShader);

   const aPos = gl.getAttribLocation(program, 'aPos');
   const aNormal = gl.getAttribLocation(program, 'aNormal');
   const uMvp = gl.getUniformLocation(program, 'uMvp');
   const uModel = gl.getUniformLocation(program, 'uModel');
   const uView = isWebGL2 ? gl.getUniformLocation(program, 'uView') : null;
   const uBaseColor = gl.getUniformLocation(program, 'uBaseColor');
   const uCameraLocal = isWebGL2 ? gl.getUniformLocation(program, 'uCameraLocal') : null;
   const uRi = isWebGL2 ? gl.getUniformLocation(program, 'uRi') : null;
   const uCod = isWebGL2 ? gl.getUniformLocation(program, 'uCod') : null;
   const uClarity = isWebGL2 ? gl.getUniformLocation(program, 'uClarity') : null;
   const uLightMode = isWebGL2 ? gl.getUniformLocation(program, 'uLightMode') : null;
   const uHeadShadowColor = isWebGL2 ? gl.getUniformLocation(program, 'uHeadShadowColor') : null;
   const uExitHighlight = isWebGL2 ? gl.getUniformLocation(program, 'uExitHighlight') : null;
   const uExitStrength = isWebGL2 ? gl.getUniformLocation(program, 'uExitStrength') : null;
   const uAxisAColor = isWebGL2 ? gl.getUniformLocation(program, 'uAxisAColor') : null;
   const uAxisBColor = isWebGL2 ? gl.getUniformLocation(program, 'uAxisBColor') : null;
   const uAxisCColor = isWebGL2 ? gl.getUniformLocation(program, 'uAxisCColor') : null;
   const uAxisTiltDeg = isWebGL2 ? gl.getUniformLocation(program, 'uAxisTiltDeg') : null;
   const uTriangleCount = isWebGL2 ? gl.getUniformLocation(program, 'uTriangleCount') : null;
   const uTriangles = isWebGL2 ? gl.getUniformLocation(program, 'uTriangles[0]') : null;
   const vertexBuffer = gl.createBuffer();
   const model = mat4.create();
   const view = mat4.create();
   const proj = mat4.create();
   const viewProj = mat4.create();
   const mvp = mat4.create();
   const inverseModel = mat4.create();

   let currentStone = null;
   let triCount = 0;
   let modelRadius = 1;
   let currentRotX = 0;
   let currentRotY = 0;
   let framePending = false;
   let uiState = null;
   let tiltAnimating = false;
   let tiltBaseX = 0;
   let tiltBaseY = 0;
   let tiltStartTs = 0;

   function deriveBaseColor() {
      const a = uiState?.axisAColor || [0.88, 0.95, 1.0];
      const b = uiState?.axisBColor || [0.88, 0.95, 1.0];
      const c = uiState?.axisCColor || [0.88, 0.95, 1.0];
      return [
         Math.max(0, Math.min(1, (a[0] + b[0] + c[0]) / 3)),
         Math.max(0, Math.min(1, (a[1] + b[1] + c[1]) / 3)),
         Math.max(0, Math.min(1, (a[2] + b[2] + c[2]) / 3)),
      ];
   }

   function requestRender() {
      if (framePending) return;
      framePending = true;
      requestAnimationFrame(() => {
         framePending = false;
         draw();
      });
   }

   function draw() {
      if (!currentStone || triCount <= 0) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const renderScale = Math.max(0.5, Math.min(dpr, uiState?.renderScale > 0 ? uiState.renderScale : dpr));
      const viewport = getViewportLayout(renderScale);
      canvas.width = viewport.pixelWidth;
      canvas.height = viewport.pixelHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
      const bg = uiState?.backgroundColor || [0.05, 0.05, 0.05];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.BLEND);
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(aNormal);
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 7 * 4, 3 * 4);

      const cameraDist = Math.max(0.1, (uiState?.focalLength || 200) / 10);
      mat4.identity(model);
      mat4.rotateX(model, model, currentRotX);
      mat4.rotateY(model, model, currentRotY);
      mat4.lookAt(view, [0, 0, cameraDist], [0, 0, 0], [0, 1, 0]);
      const sensorHalf = 5 * Math.tan(Math.PI / 8) * 0.70;
      mat4.perspective(proj, 2 * Math.atan(sensorHalf / cameraDist), canvas.width / canvas.height, 0.1, 200.0);
      mat4.multiply(viewProj, proj, view);
      mat4.multiply(mvp, viewProj, model);
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.uniformMatrix4fv(uModel, false, model);
      if (uView) gl.uniformMatrix4fv(uView, false, view);
      gl.uniform3fv(uBaseColor, deriveBaseColor());
      if (isWebGL2) {
         mat4.invert(inverseModel, model);
         const cameraLocal = [
            inverseModel[0] * 0 + inverseModel[4] * 0 + inverseModel[8] * cameraDist + inverseModel[12],
            inverseModel[1] * 0 + inverseModel[5] * 0 + inverseModel[9] * cameraDist + inverseModel[13],
            inverseModel[2] * 0 + inverseModel[6] * 0 + inverseModel[10] * cameraDist + inverseModel[14],
         ];
         gl.uniform3fv(uCameraLocal, cameraLocal);
         gl.uniform1f(uRi, Math.max(1.01, uiState?.ri || currentStone?.refractiveIndex || 1.54));
         gl.uniform1f(uCod, Math.max(0, uiState?.cod ?? currentStone?.dispersion ?? 0));
         gl.uniform1f(uClarity, Math.max(0, Math.min(1, uiState?.clarity ?? 0.5)));
         gl.uniform1f(uLightMode, uiState?.lightMode ?? 3);
         gl.uniform3fv(uHeadShadowColor, uiState?.headShadowColor || [0.5, 0.5, 0.5]);
         gl.uniform3fv(uExitHighlight, uiState?.exitHighlight || [0, 0, 0]);
         gl.uniform1f(uExitStrength, Math.max(0, uiState?.exitStrength || 0));
         gl.uniform3fv(uAxisAColor, uiState?.axisAColor || [1, 1, 1]);
         gl.uniform3fv(uAxisBColor, uiState?.axisBColor || [1, 1, 1]);
         gl.uniform3fv(uAxisCColor, uiState?.axisCColor || [1, 1, 1]);
         gl.uniform3fv(uAxisTiltDeg, [
            uiState?.axisTiltXDeg || 0,
            uiState?.axisTiltYDeg || 0,
            uiState?.axisTiltZDeg || 0,
         ]);
         gl.uniform1i(uTriangleCount, Math.min(triCount, MAX_RAY_TRIANGLES));
      }
      gl.drawArrays(gl.TRIANGLES, 0, triCount * 3);
   }

   function stopTilt() {
      tiltAnimating = false;
   }

   function tickTilt(timestamp) {
      if (!tiltAnimating) return;
      if (!tiltStartTs) tiltStartTs = timestamp;
      const elapsedSec = (timestamp - tiltStartTs) / 1000;
      const amp = (uiState?.tiltAngleDeg || 10) * Math.PI / 180;
      currentRotX = tiltBaseX + Math.sin(elapsedSec * Math.PI) * amp;
      currentRotY = tiltBaseY + Math.cos(elapsedSec * Math.PI) * amp;
      draw();
      requestAnimationFrame(tickTilt);
   }

   window.addEventListener('resize', requestRender);
   return createRendererBackend({
      id: 'webgl',
      capabilities: {
         frameProvider: null,
         graphAcceleration: false,
         stillCapture: true,
         internalReflections: isWebGL2,
      },
      loadMesh(_filename, stone) {
         currentStone = stone;
         triCount = currentStone.triangleCount;
         modelRadius = Math.max(0.1, computeMeshBoundsRadius(currentStone.vertexData));
         gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
         gl.bufferData(gl.ARRAY_BUFFER, currentStone.vertexData, gl.STATIC_DRAW);
         if (isWebGL2) {
            const triangleData = new Float32Array(MAX_RAY_TRIANGLES * 3 * 4);
            const source = currentStone.vertexData;
            const count = Math.min(currentStone.triangleCount, MAX_RAY_TRIANGLES);
            for (let triangle = 0; triangle < count; triangle++) {
               for (let vertex = 0; vertex < 3; vertex++) {
                  const sourceOffset = (triangle * 3 + vertex) * 7;
                  const targetOffset = (triangle * 3 + vertex) * 4;
                  triangleData[targetOffset] = source[sourceOffset];
                  triangleData[targetOffset + 1] = source[sourceOffset + 1];
                  triangleData[targetOffset + 2] = source[sourceOffset + 2];
               }
            }
            gl.useProgram(program);
            gl.uniform4fv(uTriangles, triangleData);
         }
         requestRender();
      },
      renderFrame() {
         requestRender();
      },
      captureStill() {
         return canvas.toDataURL('image/png');
      },
      setUiState(nextUiState) {
         uiState = nextUiState;
         requestRender();
      },
      setRotation(rotX, rotY) {
         stopTilt();
         currentRotX = rotX;
         currentRotY = rotY;
         requestRender();
      },
      getRotation() {
         return { x: currentRotX, y: currentRotY };
      },
      getCameraState() {
         return {
            modelMatrix: new Float32Array(model),
            viewMatrix: new Float32Array(view),
            projectionMatrix: new Float32Array(proj),
            cameraPosition: [0, 0, Math.max(0.1, (uiState?.focalLength || 200) / 10)],
         };
      },
      resetView() {
         stopTilt();
         currentRotX = 0;
         currentRotY = 0;
         requestRender();
      },
      toggleTilt() {
         if (tiltAnimating) {
            stopTilt();
            return false;
         }
         tiltAnimating = true;
         tiltBaseX = currentRotX;
         tiltBaseY = currentRotY;
         tiltStartTs = 0;
         requestAnimationFrame(tickTilt);
         return true;
      },
      dispose() {
         stopTilt();
         gl.deleteBuffer(vertexBuffer);
         gl.deleteProgram(program);
      },
   });
}

export async function setupWebGLRendererApp({
   canvas,
   mat4,
   loadStoneFromUrl,
   computeMeshBoundsRadius,
   createStatusLabel,
   getViewportLayout,
}) {
   const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })
      || canvas.getContext('webgl', { antialias: true, alpha: false });
   if (!gl) return null;
   const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

   createStatusLabel(isWebGL2 ? 'Renderer: webgl2 internal ray tracing' : 'Renderer: webgl preview');
   const backend = createWebGLPreviewBackend({
      gl,
      canvas,
      mat4,
      computeMeshBoundsRadius,
      isWebGL2,
      getViewportLayout,
   });
   let currentStone = null;
   return {
      renderer: 'webgl',
      backend,
      requestRender() {
         backend.renderFrame();
      },
      setRotation(rotX, rotY) {
         backend.setRotation(rotX, rotY);
      },
      getRotation() {
         return backend.getRotation();
      },
      getCameraState() {
         return backend.getCameraState();
      },
      resetView() {
         backend.resetView();
      },
      toggleTilt() {
         return backend.toggleTilt();
      },
      setUiState(nextUiState) {
         backend.setUiState(nextUiState);
      },
      captureStill() {
         return backend.captureStill();
      },
      setStone(filename, stone) {
         currentStone = stone;
         backend.loadMesh(filename, stone);
      },
      getStone() {
         return currentStone;
      },
      async loadModel(filename, url) {
         const stone = await loadStoneFromUrl(filename, url);
         currentStone = stone;
         backend.loadMesh(filename, stone);
         return stone;
      },
   };
}

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

function createWebGLPreviewBackend({ gl, canvas, mat4, computeMeshBoundsRadius }) {
   const vertexShaderSource = `
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

   const fragmentShaderSource = `
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
   const uBaseColor = gl.getUniformLocation(program, 'uBaseColor');
   const vertexBuffer = gl.createBuffer();
   const model = mat4.create();
   const view = mat4.create();
   const proj = mat4.create();
   const viewProj = mat4.create();
   const mvp = mat4.create();

   let currentStone = null;
   let triCount = 0;
   let modelRadius = 1;
   let currentRotX = -0.35;
   let currentRotY = 0.5;
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
      canvas.width = Math.max(2, Math.floor(window.innerWidth * dpr));
      canvas.height = Math.max(2, Math.floor(window.innerHeight * dpr));
      canvas.style.width = '100vw';
      canvas.style.height = '100vh';
      canvas.style.left = '0';
      canvas.style.top = '0';
      gl.viewport(0, 0, canvas.width, canvas.height);
      const bg = uiState?.backgroundColor || [0.05, 0.05, 0.05];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(aNormal);
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 7 * 4, 3 * 4);

      const cameraDist = Math.max(2.25, modelRadius * 3.2);
      mat4.identity(model);
      mat4.rotateX(model, model, currentRotX);
      mat4.rotateY(model, model, currentRotY);
      mat4.lookAt(view, [0, 0, cameraDist], [0, 0, 0], [0, 1, 0]);
      mat4.perspective(proj, Math.PI / 4, canvas.width / canvas.height, 0.1, 200.0);
      mat4.multiply(viewProj, proj, view);
      mat4.multiply(mvp, viewProj, model);
      gl.uniformMatrix4fv(uMvp, false, mvp);
      gl.uniformMatrix4fv(uModel, false, model);
      gl.uniform3fv(uBaseColor, deriveBaseColor());
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
      },
      loadMesh(_filename, stone) {
         currentStone = stone;
         triCount = currentStone.triangleCount;
         modelRadius = Math.max(0.1, computeMeshBoundsRadius(currentStone.vertexData));
         gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
         gl.bufferData(gl.ARRAY_BUFFER, currentStone.vertexData, gl.STATIC_DRAW);
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
}) {
   const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
   if (!gl) return null;

   createStatusLabel('Renderer: webgl backend');
   const backend = createWebGLPreviewBackend({ gl, canvas, mat4, computeMeshBoundsRadius });
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
         backend.loadMesh(filename, stone);
      },
      async loadModel(filename, url) {
         const stone = await loadStoneFromUrl(filename, url);
         backend.loadMesh(filename, stone);
         return stone;
      },
   };
}

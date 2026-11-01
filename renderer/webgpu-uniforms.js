// This layout is private to the WebGPU shader implementation.
export function packWebGPUUniforms(out, {
   modelMatrix,
   viewMatrix,
   projectionMatrix,
   cameraPosition,
   material,
   time,
   lightMode,
   graphMode,
   flatShading,
}) {
   out.set(modelMatrix, 0);
   out.set(viewMatrix, 16);
   out.set(projectionMatrix, 32);

   out[48] = cameraPosition[0];
   out[49] = cameraPosition[1];
   out[50] = cameraPosition[2];
   out[51] = material.clarity;
   out[52] = time;
   out[53] = material.ri;
   out[54] = material.cod;
   out[55] = lightMode;
   out.set(material.axisAColor, 56);
   out[59] = graphMode;
   out.set(material.axisBColor, 60);
   out[63] = material.exitStrength;
   out.set(material.axisCColor, 64);
   out[67] = flatShading;
   out.set(material.exitHighlight, 68);
   out[71] = material.convexFacetMode;
   out.set(material.headShadowColor, 72);
   out[75] = 0;

   const [xDeg, yDeg, zDeg] = material.axisTiltDeg;
   const hx = xDeg * Math.PI / 360;
   const hy = yDeg * Math.PI / 360;
   const hz = zDeg * Math.PI / 360;
   const sx = Math.sin(hx);
   const cx = Math.cos(hx);
   const sy = Math.sin(hy);
   const cy = Math.cos(hy);
   const sz = Math.sin(hz);
   const cz = Math.cos(hz);
   const qx = sx * cy * cz - cx * sy * sz;
   const qy = cx * sy * cz + sx * cy * sz;
   const qz = cx * cy * sz - sx * sy * cz;
   const qw = cx * cy * cz + sx * sy * sz;
   const inverseLength = 1 / Math.hypot(qx, qy, qz, qw);
   out[76] = qx * inverseLength;
   out[77] = qy * inverseLength;
   out[78] = qz * inverseLength;
   out[79] = qw * inverseLength;
}

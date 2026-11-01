export async function loadWebGPUShaderSources() {
   const [renderResponse, computeResponse] = await Promise.all([
      fetch('shaders.wgsl'),
      fetch('compute.wgsl'),
   ]);
   if (!renderResponse.ok || !computeResponse.ok) {
      throw new Error('Unable to load WebGPU shader sources.');
   }
   return {
      renderShaderSource: await renderResponse.text(),
      graphComputeShaderSource: await computeResponse.text(),
   };
}

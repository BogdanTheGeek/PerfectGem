/**
 * Renderer-neutral data contracts. Backends may expose only the capabilities
 * they support; consumers must not depend on a graphics API object.
 *
 * Interactive renderers may additionally expose getCameraState(), returning
 * modelMatrix, viewMatrix, and projectionMatrix. UI overlays use that state
 * for picking instead of reaching into renderer-specific camera objects.
 */

export const FRAME_CAPABILITIES = Object.freeze({
   CANVAS: 'canvas',
   IMAGE_BITMAP: 'image-bitmap',
   PIXELS: 'pixels',
});

export function createFrameProvider({ capabilities, maxTextureDimension2D, viewportSize, createTarget }) {
   if (!(capabilities instanceof Set)) {
      throw new TypeError('Frame provider capabilities must be a Set.');
   }
   if (typeof createTarget !== 'function') {
      throw new TypeError('Frame provider must implement createTarget().');
   }

   return Object.freeze({
      capabilities: new Set(capabilities),
      maxTextureDimension2D: Number.isFinite(maxTextureDimension2D)
         ? maxTextureDimension2D
         : Infinity,
      get viewportSize() {
         const size = viewportSize?.();
         return {
            width: Math.max(1, Math.round(size?.width || 1)),
            height: Math.max(1, Math.round(size?.height || 1)),
         };
      },
      createTarget,
   });
}

export function assertFrameCapability(provider, capability) {
   if (!provider?.capabilities?.has(capability)) {
      throw new Error(`Renderer cannot provide ${capability} frames.`);
   }
}

export function createRendererBackend({
   id,
   capabilities,
   loadMesh,
   renderFrame,
   sampleGraph,
   captureStill,
   dispose,
   ...extensions
}) {
   if (!id || typeof loadMesh !== 'function' || typeof renderFrame !== 'function') {
      throw new TypeError('Renderer backend requires id, loadMesh(), and renderFrame().');
   }

   return Object.freeze({
      id,
      capabilities: Object.freeze({ ...capabilities }),
      loadMesh,
      renderFrame,
      sampleGraph,
      captureStill,
      dispose,
      ...extensions,
   });
}

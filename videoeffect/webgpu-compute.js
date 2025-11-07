function getTextureFormat(directOutput) {
  return directOutput ? navigator.gpu.getPreferredCanvasFormat() : 'rgba8unorm';
}

function getOrCreateResource(cache, key, createFn) {
  if (!cache[key]) {
    console.log('Creating new resource for ', key);
    cache[key] = createFn();
  }
  return cache[key];
}

function getOrCreateTexture(device, cache, key, size, directOutput, usage) {
  const [width, height] = size;
  const format = getTextureFormat(directOutput);
  const cacheKey = `${key}_${width}x${height}_${format}_${usage}`;

  let texture = cache[cacheKey];
  if (!texture || texture.width !== width || texture.height !== height) {
    console.log(
      'Creating new texture for ', cacheKey, ' with format ', format,
      ' and usage ', usage);
    if (texture) {
      texture.destroy();
    }
    texture = device.createTexture({
      size,
      format,
      usage,
    });
    cache[cacheKey] = texture;
  }
  return texture;
}

async function renderWithWebGPU(params, videoFrame, resourceCache) {
  const device = params.device;
  const webgpuCanvas = params.webgpuCanvas;
  const width = params.webgpuCanvas.width;
  const height = params.webgpuCanvas.height;
  const wgs = params.wgs;

  // Import external texture.
  let sourceTexture;
  if (params.zeroCopy) {
    sourceTexture = device.importExternalTexture({
      source: videoFrame,
    });
  } else {
    sourceTexture = getOrCreateTexture(
      device, resourceCache, 'sourceTexture',
      [videoFrame.displayWidth, videoFrame.displayHeight, 1],
      params.directOutput,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT);

    device.queue.copyExternalImageToTexture(
      { source: videoFrame }, { texture: sourceTexture },
      [videoFrame.displayWidth, videoFrame.displayHeight]);
  }

  // Always process at full video resolution, ignore display size
  const processingWidth = videoFrame.displayWidth || 1280;
  const processingHeight = videoFrame.displayHeight || 720;

  // Update canvas size only if video resolution actually changed
  if (webgpuCanvas.width !== processingWidth ||
    webgpuCanvas.height !== processingHeight) {
    webgpuCanvas.width = processingWidth;
    webgpuCanvas.height = processingHeight;
    // Reconfigure context with actual video size
    context.configure({
      device: device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
      usage: GPUTextureUsage.RENDER_ATTACHMENT |
        (params.directOutput ?
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST :
          0),
    });
  }

  const outputTexture = getOrCreateTexture(
    device, resourceCache, 'outputTexture', [width, height, 1],
    params.directOutput,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.TEXTURE_BINDING);

  // Update uniform buffer
  const hasUniform = false;
  if (hasUniform) {
    const uniformData =
      new Float32Array([width, height, 6.0]);  // resolution, blurAmount
    device.queue.writeBuffer(params.uniformBuffer, 0, uniformData);
  }

  // Create bind group
  const canvasTexture = params.context.getCurrentTexture();
  const bindGroup = device.createBindGroup({
    layout: params.computePipeline.getBindGroupLayout(0),
    label: 'blurBindGroup',
    entries: [
      {
        binding: 0,
        resource: params.zeroCopy ? sourceTexture : sourceTexture.createView()
      },
      {
        binding: 1,
        resource: params.directOutput ? canvasTexture.createView() :
          outputTexture.createView(),
        // resource: outputTexture.createView(),
      },
      { binding: 2, resource: params.blurSampler },
      // { binding: 3, resource: { buffer: params.uniformBuffer } },
    ],
  });

  // Run compute shader
  const commandEncoder = device.createCommandEncoder();
  const computePass = commandEncoder.beginComputePass();
  computePass.setPipeline(params.computePipeline);
  computePass.setBindGroup(0, bindGroup);

  let workgroupCountX, workgroupCountY;
  if (params.computePipeline.label === 'tileBlurPipeline' || params.blur) {
    // tileDim = wgs[0] * 4; filterSize = 15; blockDim = tileDim - filterSize;
    const tileDim = wgs[0] * 4;
    const filterSize = 15;
    const blockDim = tileDim - filterSize;
    workgroupCountX = Math.ceil(width / blockDim);
    workgroupCountY = Math.ceil(height / 4);
  } else {
    workgroupCountX = Math.ceil(width / wgs[0]);
    workgroupCountY = Math.ceil(height / wgs[1]);
  }
  computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY);
  computePass.end();


  device.queue.submit([commandEncoder.finish()]);

  // Create a new VideoFrame from the processed WebGPU canvas
  const processedVideoFrame = new VideoFrame(
    params.webgpuCanvas,
    { timestamp: videoFrame.timestamp, duration: videoFrame.duration });

  return processedVideoFrame;
}

// WebGPU blur renderer
export async function createWebGPUBlurRenderer(
  segmenter, config) {
  if(config.blur) {
    throw new Error('WebGPU-compute.js does not support config.blur');
  }
  console.log(
    'createWebGPUBlurRenderer zeroCopy: ', config.zeroCopy,
    ' directOutput: ', config.directOutput, ' bilinearFiltering', config.bilinearFiltering);
  // Always use full resolution for processing, regardless of display size
  const webgpuCanvas = new OffscreenCanvas(1280, 720);

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('WebGPU adapter not available');
  }

  // Ensure we're compatible with directOutput
  console.log('Adapter features:');
  for (const feature of adapter.features) {
    console.log(`- ${feature}`);
  }
  if (!adapter.features.has('bgra8unorm-storage')) {
    console.log('BGRA8UNORM-STORAGE not supported');
  }
  const device =
    await adapter.requestDevice({ requiredFeatures: ['bgra8unorm-storage'] });
  const context = webgpuCanvas.getContext('webgpu');

  if (!context) {
    throw new Error('WebGPU context not available');
  }

  context.configure({
    device: device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: 'premultiplied',
    usage: GPUTextureUsage.RENDER_ATTACHMENT |
      (config.directOutput ?
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST :
        0),
  });

  // WebGPU compute shader for blur effect
  const computeShaderCode = `
      @group(0) @binding(0) var inputTexureture: ${config.zeroCopy ? 'texture_external' : 'texture_2d<f32>'};
      @group(0) @binding(1) var outputTexture: texture_storage_2d<${getTextureFormat(config.directOutput)}, write>;
      @group(0) @binding(2) var textureSampler: sampler;
      
      @compute @workgroup_size(${config.wgs[0]}, ${config.wgs[1]})
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let inputDims = textureDimensions(inputTexureture);
        
        if (global_id.x >= inputDims.x || global_id.y >= inputDims.y) {
          return;
        }
        
        let coord = vec2<i32>(i32(global_id.x), i32(global_id.y));
        let uv = (vec2<f32>(coord) + 0.5) / vec2<f32>(inputDims);
        
        var originalColor = textureSampleBaseClampToEdge(inputTexureture, textureSampler, uv);
            
        textureStore(outputTexture, coord, originalColor);
      }
    `;

  const computeShader = device.createShaderModule({
    code: computeShaderCode,
  });

  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: computeShader,
      entryPoint: 'main',
    },
  });

  const blurSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  // Create a simple render pipeline to copy the compute shader's output (RGBA)
  // to the canvas, which might have a different format (e.g., BGRA).

  const renderSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  const resourceCache = {};

  return {
    render: async (videoFrame) => {
      const params = {
        device,
        context,
        computePipeline,
        webgpuCanvas,
        blurSampler,
        // uniformBuffer,
        renderSampler,
        ...config,
        segmenter
      };
      try {
        return await renderWithWebGPU(params, videoFrame, resourceCache);
      } catch (error) {
        console.warn('WebGPU rendering failed:', error);
      }
    }
  };
}

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

const vertexData = new Float32Array([
  // pos.x, pos.y, uv.x, uv.y
  -1,
  -1,
  0,
  0,
  1,
  -1,
  1,
  0,
  -1,
  1,
  0,
  1,
  1,
  1,
  1,
  1,
]);

const vertexBufferLayout = {
  arrayStride: 4 * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' },      // pos
    { shaderLocation: 1, offset: 2 * 4, format: 'float32x2' },  // uv
  ],
};

async function renderWithWebGPU(params, videoFrame, resourceCache) {
  const device = params.device;
  const webgpuCanvas = params.webgpuCanvas;
  const context = params.context;
  const width = videoFrame.displayWidth || 1280;
  const height = videoFrame.displayHeight || 720;

  // Import external texture.
  let sourceTexture;
  if (params.zeroCopy) {
    sourceTexture = device.importExternalTexture({
      source: videoFrame,
    });
  } else {
    sourceTexture = getOrCreateTexture(
      device, resourceCache, 'sourceTexture', [width, height, 1],
      params.directOutput,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT);

    device.queue.copyExternalImageToTexture(
      { source: videoFrame }, { texture: sourceTexture }, [width, height]);
  }

  // Update canvas size only if video resolution actually changed
  if (webgpuCanvas.width !== width || webgpuCanvas.height !== height) {
    webgpuCanvas.width = width;
    webgpuCanvas.height = height;
    context.configure({
      device: device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
  if (params.uniformBuffer) {
    const uniformData =
      new Float32Array([width, height, 6.0]);  // resolution, blurAmount
    device.queue.writeBuffer(params.uniformBuffer, 0, uniformData);
  }

  let vertexBuffer = resourceCache.vertexBuffer;
  if (!vertexBuffer) {
    vertexBuffer = device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
    vertexBuffer.unmap();
    resourceCache.vertexBuffer = vertexBuffer;
  }

  const bindGroup = params.blur ? device.createBindGroup({
    layout: params.renderPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: params.zeroCopy ? sourceTexture : sourceTexture.createView()
      },
      { binding: 1, resource: params.renderSampler },
      { binding: 2, resource: { buffer: params.uniformBuffer } },
    ],
  }) : device.createBindGroup({
    layout: params.renderPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: params.zeroCopy ? sourceTexture : sourceTexture.createView()
      },
      { binding: 1, resource: params.renderSampler }
    ],
  });


  const commandEncoder = device.createCommandEncoder();
  const textureView = context.getCurrentTexture().createView();
  const renderPass = commandEncoder.beginRenderPass({
    colorAttachments: [{
      view: textureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });

  renderPass.setPipeline(params.renderPipeline);
  renderPass.setVertexBuffer(0, vertexBuffer);
  renderPass.setBindGroup(0, bindGroup);
  renderPass.draw(4, 1, 0, 0);
  renderPass.end();

  device.queue.submit([commandEncoder.finish()]);

  // Create a new VideoFrame from the processed WebGPU canvas

  if(params.present) {
    const processedVideoFrame = new VideoFrame(
      webgpuCanvas,
      { timestamp: videoFrame.timestamp, duration: videoFrame.duration });

    return processedVideoFrame;
  } else {
    return null;
  }
}

// WebGPU blur renderer (vertex+fragment shader)
export async function createWebGPUBlurRenderer(segmenter, params) {
  console.log(
    'createWebGPUBlurRenderer zeroCopy: ', params.zeroCopy,
    ' directOutput: ', params.directOutput, ' bilinearFiltering', params.bilinearFiltering);
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
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // Vertex shader WGSL
  const vertexShaderCode = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>
};

@vertex
fn main(@location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = vec2<f32>(uv.x, 1.0 - uv.y);
  return out;
}
`;

  // Fragment shader WGSL
  var fragmentShaderCode;
  if (params.blur) {
    const blurRadius = params.blurRadius || 4;
    fragmentShaderCode = `
@group(0) @binding(0) var inputTexure: ${params.zeroCopy ? 'texture_external' : 'texture_2d<f32>'};
@group(0) @binding(1) var textureSampler: sampler;

struct Uniforms {
    resolution: vec2<f32>,
    blurAmount: f32,
};
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let dims = vec2f(textureDimensions(inputTexure));
  var color = vec3f(0.0, 0.0, 0.0);
  var total = 0.0;
  let blurAmount = 6.0;
  for (var dx = -4; dx <= 4; dx++) {
    for (var dy = -4; dy <= 4; dy++) {
      let offset = vec2f(f32(dx), f32(dy)) * blurAmount / dims;
      let weight = 1.0 / (1.0 + length(vec2f(f32(dx), f32(dy))));
      color += textureSampleBaseClampToEdge(inputTexure, textureSampler, uv + offset).rgb * weight;
      total += weight;
    }
  }
  return vec4f(color / total, 1.0);
}
  `;
  } else {
    fragmentShaderCode =
      `
@group(0) @binding(0) var inputTexture: ${params.zeroCopy ? 'texture_external' : 'texture_2d<f32>'};
@group(0) @binding(1) var textureSampler: sampler;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  var originalColor = textureSampleBaseClampToEdge(inputTexture, textureSampler, uv);
  return originalColor;
}
`;
  }

  const vertexModule = device.createShaderModule({ code: vertexShaderCode });
  const fragmentModule = device.createShaderModule({ code: fragmentShaderCode });

  const renderSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  const uniformBuffer = params.blur ? device.createBuffer({
    // resolution: vec2<f32>, blurAmount: f32.
    // vec2 is 8 bytes, f32 is 4. Total 12. Pad to 16 for alignment.
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  }) : null;

  const renderPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: vertexModule,
      entryPoint: 'main',
      buffers: [vertexBufferLayout],
    },
    fragment: {
      module: fragmentModule,
      entryPoint: 'main',
      targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
    },
    primitive: { topology: 'triangle-strip' },
  });

  const resourceCache = {};

  return {
    render: async (videoFrame) => {
      params = {
        device,
        context,
        renderPipeline,
        webgpuCanvas,
        renderSampler,
        uniformBuffer,
        ...params,
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

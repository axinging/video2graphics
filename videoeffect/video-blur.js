function GetVideoSource(videoInfo) {
  const fps = videoInfo.fps;
  const videoSize = videoInfo.size;
  const codec = videoInfo.codec;
  return `./${videoSize}_${codec}_${fps}fps.webm`;
}

function getMedianValue(array) {
  array = array.sort((a, b) => a - b);
  return array.length % 2 !== 0 ?
      array[Math.floor(array.length / 2)] :
      (array[array.length / 2 - 1] + array[array.length / 2]) / 2;
}

let segmenter = null;
let rendererSwitchRequested = false;

// Load renderer module based on URL parameters
async function loadRendererFromUrl(blur) {
  const params = new URLSearchParams(window.location.search);
  const rendererType = params.get('renderer') || 'webgpu-compute';
  const wgsx = Number(params.get('wgsx') || '8');
  const wgsy = Number(params.get('wgsy') || '8');

  let rendererModule;
  if (rendererType === 'webgpu-compute' && !blur) {
    rendererModule = await import('./webgpu-compute.js');
  } else if (rendererType === 'webgpu-compute' && blur) {
    rendererModule = await import('./webgpu-compute-blur.js');
  } else if (rendererType === 'webgpu-graphics'&& !blur) {
    rendererModule = await import('./webgpu-graphics.js');
  }  else if (rendererType === 'webgpu-graphics'&& blur) {
    rendererModule = await import('./webgpu-graphics.js');
  } else if (rendererType === 'webgl-graphics' && !blur) {
    rendererModule = await import('./webgl-graphics.js');
  } else if (rendererType === 'webgl-graphics'&& blur) {
    rendererModule = await import('./webgl-graphics-blur.js');
  } else {
    throw new Error(`Unknown renderer type: ${rendererType}`);
  }
  return {rendererModule, rendererType, wgsx, wgsy};
}

function loadConfigFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const wgsX = Number(params.get('wgsx') || '8');
  const wgsY = Number(params.get('wgsy') || '8');
  const zeroCopy = params.has('zerocopy') ? (params.get('zerocopy') === 'true' || params.get('zerocopy') === '1') : true;
  const directOutput = params.has('directoutput') ? (params.get('directoutput') === 'true' || params.get('directoutput') === '1') : true;
  const bilinearFiltering = params.has('bilinearfiltering') ? (params.get('bilinearfiltering') === 'true' || params.get('bilinearfiltering') === '1') : false;
  const blur = params.has('blur') ? (params.get('blur') === 'true' || params.get('blur') === '1') : false;
  return { wgs: [wgsX, wgsY], zeroCopy: zeroCopy, directOutput: directOutput, bilinearFiltering: bilinearFiltering, blur: blur };
}

// Initialize blur renderer
async function initializeBlurRenderer() {
  const config = loadConfigFromUrl();
  const {rendererModule, rendererType} = await loadRendererFromUrl(config.blur);
  const useWebGPU = rendererType.startsWith('webgpu');
  const segmenterFunction = null;

  try {
    if (useWebGPU && 'gpu' in navigator) {
      appBlurRenderer = await rendererModule.createWebGPUBlurRenderer(segmenterFunction, config);
      console.log('Using WebGPU for blur rendering');
    } else {
      appBlurRenderer = await rendererModule.createWebGL2BlurRenderer(segmenterFunction, config);
      console.log('Using WebGL2 for blur rendering');
    }
    appProcessedVideo.style.display = 'block';
  } catch (error) {
    console.warn(
        `Failed to initialize ${useWebGPU ? 'WebGPU' : 'WebGL2'} renderer:`,
        error);
    if (useWebGPU) {
      appBlurRenderer =
          await rendererModule.createWebGL2BlurRenderer(segmenterFunction);
      appProcessedVideo.style.display = 'block';
      appCanvas.style.display = 'none';
      if (appProcessedVideo) {
        appProcessedVideo.style.display = 'none';
      }
    }
  }
}

// Process a single VideoFrame
async function processOneFrame(videoFrame) {
  if (!appBlurRenderer) {
    return null;
  }
  try {
    return await appBlurRenderer.render(videoFrame);
  } catch (error) {
    console.error('Error during frame processing in processOneFrame:', error);
    return null;
  }
}

let lastProcessedTime = 0;

// Main processing loop for video element
async function run20fps() {
  appStartRun = performance.now();
  appCount = 0;
  appSegmentTimes.length = 0;

  let frameCount = 0;
  let lastFpsTime = performance.now();
  let actualFps = 0;

  const trackGenerator = new MediaStreamTrackGenerator({kind: 'video'});
  const writer = trackGenerator.writable.getWriter();
  const outputStream = new MediaStream([trackGenerator]);
  if (outputStream && appProcessedVideo) {
    appProcessedVideo.srcObject = outputStream;
  }

  // Limit FPS to 20
  async function processFrames(now, metadata) {
    if (!isRunning || appVideo.ended) {
      writer.close();
      return;
    }

    // Only process if enough time has passed (50ms for ~20fps)
    if (now - lastProcessedTime < 50) {
      appVideo.requestVideoFrameCallback(processFrames);
      return;
    }
    lastProcessedTime = now;

    const videoFrame = new VideoFrame(appVideo, {timestamp: metadata?.mediaTime ? metadata.mediaTime * 1e6 : performance.now() * 1000});
    frameCount++;
    const currentTime = performance.now();
    const deltaTime = currentTime - lastFpsTime;
    if (deltaTime >= 1000) {
      actualFps = (frameCount * 1000) / deltaTime;
      appFpsDisplay.textContent = `FPS: ${actualFps.toFixed(1)}`;
      frameCount = 0;
      lastFpsTime = currentTime;
    }

    const processedFrame = await processOneFrame(videoFrame);

    if (processedFrame) {
      try {
        await writer.write(processedFrame);
      } catch (e) {
        console.error('Error writing frame to generator', e);
      }
      processedFrame.close();
    }
    videoFrame.close();

    appVideo.requestVideoFrameCallback(processFrames);
  }

  appVideo.requestVideoFrameCallback(processFrames);
}

// Main processing loop for video element
async function run() {
  appStartRun = performance.now();
  appCount = 0;
  appSegmentTimes.length = 0;

  // FPS tracking variables
  let frameCount = 0;
  let lastFpsTime = performance.now();
  let actualFps = 0;

  // Use MediaStreamTrackGenerator for output
  const trackGenerator = new MediaStreamTrackGenerator({kind: 'video'});
  const writer = trackGenerator.writable.getWriter();
  const outputStream = new MediaStream([trackGenerator]);
  if (outputStream && appProcessedVideo) {
    appProcessedVideo.srcObject = outputStream;
  }

  // Use requestVideoFrameCallback to grab frames from <video>
  async function processFrames(now, metadata) {
    if (!isRunning || appVideo.ended) {
      writer.close();
      return;
    }

    // Create a VideoFrame from the current <video> element
    const videoFrame = new VideoFrame(appVideo, {timestamp: metadata?.mediaTime ? metadata.mediaTime * 1e6 : performance.now() * 1000});
    frameCount++;
    const currentTime = performance.now();
    const deltaTime = currentTime - lastFpsTime;
    if (deltaTime >= 1000) {
      actualFps = (frameCount * 1000) / deltaTime;
      appFpsDisplay.textContent = `FPS: ${actualFps.toFixed(1)}`;
      frameCount = 0;
      lastFpsTime = currentTime;
    }

    const processedFrame = await processOneFrame(videoFrame);

    if (processedFrame) {
      try {
        await writer.write(processedFrame);
      } catch (e) {
        console.error('Error writing frame to generator', e);
      }
      processedFrame.close();
    }
    videoFrame.close();

    // Continue processing next frame
    appVideo.requestVideoFrameCallback(processFrames);
  }

  appVideo.requestVideoFrameCallback(processFrames);
}

// Global variables for app state
let appStartRun = null;
let appCount = 0;
let appSegmentTimes = [];
let appBlurRenderer = null;
let isRunning = false;

// Get DOM elements for app control
const webgpuRadio = document.getElementById('webgpuRadio');
const displaySizeSelect = document.getElementById('displaySize');
const appStatus = document.getElementById('status');
const appFpsDisplay = document.getElementById('fpsDisplay');
const appVideo = document.getElementById('webcam');
const appProcessedVideo = document.getElementById('processedVideo');
const appCanvas = document.getElementById('output');
const zeroCopyCheckbox = document.getElementById('zeroCopy');
const zeroCopyLabel = document.getElementById('zeroCopyLabel');
const directOutputCheckbox = document.getElementById('directOutput');
const directOutputLabel = document.getElementById('directOutputLabel');
const fakeSegmentationCheckbox = document.getElementById('fakeSegmentation');

// Update display size of video elements (does NOT affect processing resolution)
function updateDisplaySize() {
  const size = 'big';  // displaySizeSelect.value;
  let width, height;

  if (size === 'small') {
    width = 320;
    height = 180;
  } else {
    width = 1280;
    height = 720;
  }

  appVideo.style.width = width + 'px';
  appVideo.style.height = height + 'px';
  appProcessedVideo.style.width = width + 'px';
  appProcessedVideo.style.height = height + 'px';
  appCanvas.style.width = width + 'px';
  appCanvas.style.height = height + 'px';
}

// Initialize compatibility info
function initializeCompatibilityInfo() {
  const hasWebGPU = 'gpu' in navigator;
  if (!hasWebGPU) {
    webgpuRadio.disabled = true;
    webgpuRadio.parentElement.innerHTML =
        '<input type="radio" name="renderer" value="webgpu" disabled /> WebGPU (Not supported in this browser)';
  }
}

function loadFpsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fps = Number(params.get('fps') || '10');
  const size = params.get('size') || '1280x720';
  const codec = params.get('codec') || 'vp9';
  return {fps, size, codec};
}


// Start video processing from a video file
export async function startVideoProcessing() {
  if (isRunning) return;
  try {
    // Get video source URL using GetVideoSource
    const videoInfo = loadFpsFromUrl();
    const videoSrc = GetVideoSource(videoInfo); // You can change codec and size as needed
    appVideo.src = videoSrc;
    appVideo.loop = true;
    appVideo.load();
    await appVideo.play();

    // Wait until dimensions are available
    await new Promise(res => {
      const chk = () => (appVideo.videoWidth > 0) ? res() : setTimeout(chk, 50);
      chk();
    });

    appVideo.style.display = 'block';
    appCanvas.style.display = 'block';
    appProcessedVideo.style.display = 'none';

    isRunning = true;

    await initializeBlurRenderer();
    await run();

  } catch (error) {
    console.error('Failed to start video processing:', error);
  }
}

function stopVideoProcessing() {
  if (!isRunning) return;
  isRunning = false;

  if (appVideo.srcObject) {
    appVideo.srcObject.getTracks().forEach(t => t.stop());
    appVideo.srcObject = null;
  }
  appBlurRenderer = null;
  appFpsDisplay.textContent = 'FPS: --';
}

window.startVideoProcessing = startVideoProcessing;

function updateOptionState() {
  const isWebGPU = webgpuRadio.checked;
  zeroCopyCheckbox.disabled = !isWebGPU;
  zeroCopyLabel.style.color = isWebGPU ? '' : '#aaa';
  directOutputCheckbox.disabled = !isWebGPU;
  directOutputLabel.style.color = isWebGPU ? '' : '#aaa';
};

async function initializeApp() {
  initializeCompatibilityInfo();
  updateDisplaySize();

  document.addEventListener('keydown', (event) => {
    if (event.key === 's' || event.key === 'S') {
      startVideoProcessing();
    }
    if (event.key === 'e' || event.key === 'E') {
      stopVideoProcessing();
    }
  });
}

// Initialize the app
initializeApp();
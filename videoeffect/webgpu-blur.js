function getMedianValue(array) {
  array = array.sort((a, b) => a - b);
  return array.length % 2 !== 0 ? array[Math.floor(array.length / 2)] :
    (array[array.length / 2 - 1] + array[array.length / 2]) / 2;
}

let segmenter = null;
let rendererSwitchRequested = false;


function getZeroCopyFromUrl() {
  const params = new URLSearchParams(window.location.search);
  // 如果没有 zerocopy 参数，直接返回 1
  if (!params.has('zerocopy')) return 1;
  // 有参数时，'true' 返回 1，否则返回 0
  return params.get('zerocopy') === '1' ? 1 : 0;
}

async function loadRendererFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const rendererType = params.get('renderer') || 'webgpucompute';

  let rendererModule;
  if (rendererType === 'webgpucompute') {
    rendererModule = await import('./webgpu-renderer-compute.js');
  } else if (rendererType === 'webgpugraphics') {
    rendererModule = await import('./webgpu-renderer.js');
  } else{
    rendererModule = await import('./webgl-renderer.js');
  }
  return  {rendererModule, rendererType};
}


// Initialize blur renderer based on radio buttons
async function initializeBlurRenderer() {
    const { rendererModule, rendererType } = await loadRendererFromUrl();
    const useWebGPU = (rendererType === 'webgpucompute' || rendererType === 'webgpugraphics');
    const segmenterFunction = null

    try {
      // const rendererModule = await loadRendererFromUrl();
      
      if (useWebGPU && 'gpu' in navigator) {
        const zeroCopy = getZeroCopyFromUrl()==1? true: false;
        const directOutput = true;
        appBlurRenderer = await rendererModule.createWebGPUBlurRenderer(segmenterFunction, zeroCopy, directOutput, loop);
        //appStatus.innerText = 'Renderer: WebGPU';
        console.log('Using WebGPU for blur rendering');
      } else {
        appBlurRenderer = await rendererModule.createWebGL2BlurRenderer(segmenterFunction, loop);
        //appStatus.innerText = 'Renderer: WebGL2';
        console.log('Using WebGL2 for blur rendering');
      }

      // Both renderers now output to a video element via MediaStreamTrackGenerator
      appProcessedVideo.style.display = 'block';
      // appCanvas.style.display = 'none';

    } catch (error) {
      console.warn(`Failed to initialize ${useWebGPU ? 'WebGPU' : 'WebGL2'} renderer:`, error);
      // Fallback to WebGL2 if WebGPU fails
      if (useWebGPU) {
        appBlurRenderer = await rendererModule.createWebGL2BlurRenderer(segmenterFunction);
        // The fallback should also use the video element path
        appProcessedVideo.style.display = 'block';
        appCanvas.style.display = 'none';
        // If for some reason we need to show the canvas, we can do this:
        // appCanvas.style.display = 'block';

        if (appProcessedVideo) {
          appProcessedVideo.style.display = 'none';
        }
      }
    }
}

async function processOneFrame(videoFrame) {
    if (!appBlurRenderer) {
        return null;
    }

    try {
        // Render with blur effect
        return await appBlurRenderer.render(videoFrame);
    } catch (error) {
        console.error("Error during frame processing in processOneFrame:", error);
        return null;
    }
}

async function run() {
  appStartRun = performance.now();
  appCount = 0;
  appSegmentTimes.length = 0;
  
  // FPS tracking variables
  let frameCount = 0;
  let lastFpsTime = performance.now();
  let actualFps = 0;
  
  // Centralized frame processing setup
  const videoTrack = appStream.getVideoTracks()[0];
  const trackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
  appReader = trackProcessor.readable.getReader();

  const trackGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = trackGenerator.writable.getWriter();
  const outputStream = new MediaStream([trackGenerator]);
  if (outputStream && appProcessedVideo) {
      appProcessedVideo.srcObject = outputStream;
  }

  // Main processing loop
  async function processFrames() {
    while (isRunning) {
      if (rendererSwitchRequested) {
        rendererSwitchRequested = false;
        await initializeBlurRenderer();
        const rendererType = 'WebGPU';//document.querySelector('input[name="renderer"]:checked').value === 'webgpu' ? 'WebGPU' : 'WebGL2';
        // Reset counters
        appCount = 0;
        appSegmentTimes.length = 0;
        frameCount = 0;
        lastFpsTime = performance.now();
        appFpsDisplay.textContent = `FPS: --`;
      }

      const result = await appReader.read();
      if (result.done) {
        console.log("Stream has ended.");
        appReader.releaseLock();
        writer.close();
        break;
      }
      const frame = result.value;

      // FPS calculation
      frameCount++;
      const currentTime = performance.now();
      const deltaTime = currentTime - lastFpsTime;
      if (deltaTime >= 1000) {
        actualFps = (frameCount * 1000) / deltaTime;
        appFpsDisplay.textContent = `FPS: ${actualFps.toFixed(1)}`;
        frameCount = 0;
        lastFpsTime = currentTime;
      }

      const processedFrame = await processOneFrame(frame);

      if (processedFrame) {
          try {
            await writer.write(processedFrame);
          } catch (e) {
            console.error('Error writing frame to generator', e);
          }
          processedFrame.close();
      }

      // IMPORTANT: Close the frame to free up resources.
      frame.close();
    }
  }

  // Start the processing loop
  processFrames().catch(e => {
    if (isRunning) { // Only log error if we weren't intentionally stopped
      console.error("Error in processing loop:", e);
      stopVideoProcessing();
    }
  });
}

// Global variables for app state
let appStartRun = null;
let appCount = 0;
let appSegmentTimes = [];
let appBlurRenderer = null;
let appStream = null;
let isRunning = false;
let appReader = null;

// Get DOM elements for app control
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
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

// Function to update URL from UI state
function updateUrlFromUi() {
  const form = document.getElementById('settings-form');

  // When ANY input inside the form changes...
  form.addEventListener('change', () => {
    // 1. Get ALL current UI values instantly using FormData
    const formData = new FormData(form);

    // 2. FormData serializes directly into URLSearchParams
    const params = new URLSearchParams(formData);

    // 3. Update the URL hash (avoids page reload)
    // Use history.replaceState to avoid polluting browser history on every click
    history.replaceState(null, '', '#' + params.toString());
  });
}

// Function to update UI from URL parameters on page load
function updateUiFromUrl() {
  const params = new URLSearchParams(location.hash.substring(1));

  const renderer = params.get('renderer');
  if (renderer) {
    const radio = document.querySelector(`input[name="renderer"][value="${renderer}"]`);
    if (radio) radio.checked = true;
  }

  // Only check these if WebGPU is the selected renderer
  if (document.querySelector('input[name="renderer"]:checked').value === 'webgpu') {
      zeroCopyCheckbox.checked = params.get('zeroCopy') === 'true';
      directOutputCheckbox.checked = params.get('directOutput') === 'true';
  }

  fakeSegmentationCheckbox.checked = params.get('fakeSegmentation') === 'true';

  const displaySize = params.get('displaySize');
  if (displaySize) {
    displaySizeSelect.value = displaySize;
  }
}

// Check browser compatibility
const hasWebGPU = 'gpu' in navigator;

// Function to update display size of video elements (does NOT affect processing resolution)
function updateDisplaySize() {
  const size = 'big';//displaySizeSelect.value;
  let width, height;
  
  if (size === 'small') {
    width = 320;
    height = 180;
  } else {
    width = 1280;
    height = 720;
  }
  
  // Update video elements display size only - processing remains at full resolution
  appVideo.style.width = width + 'px';
  appVideo.style.height = height + 'px';
  appProcessedVideo.style.width = width + 'px';
  appProcessedVideo.style.height = height + 'px';
  appCanvas.style.width = width + 'px';
  appCanvas.style.height = height + 'px';
}

// Initialize compatibility info
function initializeCompatibilityInfo() {
  if (!hasWebGPU) {
    webgpuRadio.disabled = true;
    webgpuRadio.parentElement.innerHTML = '<input type="radio" name="renderer" value="webgpu" disabled /> WebGPU (Not supported in this browser)';
  }
}

async function startVideoProcessing() {
  if (isRunning) return;
  try {
    appStream = await navigator.mediaDevices.getUserMedia({ 
      video: { frameRate: { ideal: 30 }, width: 1280, height: 720 } 
    });
    
    appVideo.srcObject = appStream;
    await new Promise(r => appVideo.onloadedmetadata = r);
    
    // Wait until dimensions are available
    await new Promise(res => {
      const chk = () => (appVideo.videoWidth > 0) ? res() : setTimeout(chk, 50);
      chk();
    });
    
    appVideo.style.display = 'block';
    appCanvas.style.display = 'block';
    appProcessedVideo.style.display = 'none';
    
    isRunning = true;
    startButton.style.display = 'none';
    stopButton.style.display = 'inline-block';
    
    // Now run the video processing
    await initializeBlurRenderer();
    await run();
    
  } catch (error) {
    console.error('Failed to start video processing:', error);
    // appStatus.textContent = 'Error: ' + error.message;
    //startButton.disabled = false;
    // startButton.textContent = 'Start Video Processing';
    if (appStream) {
      appStream.getTracks().forEach(t => t.stop());
      appStream = null;
    }
  }
}

function stopVideoProcessing() {
  if (!isRunning) return;
  isRunning = false;
  
  // Stop any active streams
  if (appVideo.srcObject) {
    appVideo.srcObject.getTracks().forEach(t => t.stop());
    appVideo.srcObject = null;
  }
  if (appStream) {
    appStream.getTracks().forEach(t => t.stop());
    appStream = null;
  }

  if (appReader) {
    appReader.cancel().catch(() => {}); // Ignore cancel errors
    appReader = null;
  }
  
  appBlurRenderer = null;
  
  appFpsDisplay.textContent = 'FPS: --';
}

function updateOptionState() {
  const isWebGPU = webgpuRadio.checked;
  zeroCopyCheckbox.disabled = !isWebGPU;
  zeroCopyLabel.style.color = isWebGPU ? '' : '#aaa';
  directOutputCheckbox.disabled = !isWebGPU;
  directOutputLabel.style.color = isWebGPU ? '' : '#aaa';
};
var loop =4;

async function initializeApp() {
  const urlParams = new URLSearchParams(window.location.search);
  const tmp = urlParams.get('loop');
  loop = tmp == null ?  0 : Number(tmp); // returns NaN if not a number

  // Set initial UI state from URL before doing anything else
  // updateUiFromUrl();

  initializeCompatibilityInfo();
  
  // Set initial display size
  updateDisplaySize();
  startButton.addEventListener('click', startVideoProcessing);
  stopButton.addEventListener('click', stopVideoProcessing);

  // await startVideoProcessing()
}

// Initialize the app
initializeApp();



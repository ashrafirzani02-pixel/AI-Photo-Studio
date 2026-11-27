import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
let landmarkerPromise;

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "IMAGE",
        numFaces: 1
      });
    })().catch(error => {
      landmarkerPromise = null;
      throw error;
    });
  }
  return landmarkerPromise;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Gambar tidak dapat dibaca untuk deteksi wajah."));
    image.src = src;
  });
}

function faceBounds(landmarks, width, height) {
  const xs = landmarks.map(point => point.x * width);
  const ys = landmarks.map(point => point.y * height);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const faceW = maxX - minX;
  const faceH = maxY - minY;
  if (faceW < 24 || faceH < 24) return null;
  const padX = faceW * 0.12;
  const padTop = faceH * 0.10;
  const padBottom = faceH * 0.08;
  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padTop);
  const right = Math.min(width, maxX + padX);
  const bottom = Math.min(height, maxY + padBottom);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Experimental pixel preservation:
 * detect the face in both images, map the original face crop to the generated
 * face bounds, then feather-composite the original pixels over the AI result.
 * If detection/alignment is unreliable, caller should keep the unmodified AI image.
 */
export async function preserveFacePixels(originalSrc, generatedSrc) {
  const landmarker = await getLandmarker();
  const [original, generated] = await Promise.all([
    loadImage(originalSrc),
    loadImage(generatedSrc)
  ]);
  const originalFaces = landmarker.detect(original).faceLandmarks;
  const generatedFaces = landmarker.detect(generated).faceLandmarks;
  if (!originalFaces?.length || !generatedFaces?.length) {
    throw new Error("Wajah tidak terdeteksi pada kedua gambar.");
  }

  const source = faceBounds(originalFaces[0], original.naturalWidth, original.naturalHeight);
  const target = faceBounds(generatedFaces[0], generated.naturalWidth, generated.naturalHeight);
  if (!source || !target) throw new Error("Landmark wajah tidak cukup jelas.");

  const aspectDifference = Math.abs(source.width / source.height - target.width / target.height);
  if (aspectDifference > 0.45) {
    throw new Error("Bentuk area wajah terlalu berbeda untuk digabungkan dengan aman.");
  }

  const patch = document.createElement("canvas");
  patch.width = Math.max(1, Math.round(target.width));
  patch.height = Math.max(1, Math.round(target.height));
  const patchCtx = patch.getContext("2d");
  patchCtx.drawImage(
    original,
    source.x, source.y, source.width, source.height,
    0, 0, patch.width, patch.height
  );

  const mask = document.createElement("canvas");
  mask.width = patch.width;
  mask.height = patch.height;
  const maskCtx = mask.getContext("2d");
  maskCtx.fillStyle = "#fff";
  maskCtx.filter = "blur(10px)";
  maskCtx.beginPath();
  maskCtx.ellipse(
    patch.width * 0.5,
    patch.height * 0.51,
    patch.width * 0.49,
    patch.height * 0.49,
    0, 0, Math.PI * 2
  );
  maskCtx.fill();
  patchCtx.globalCompositeOperation = "destination-in";
  patchCtx.drawImage(mask, 0, 0);
  patchCtx.globalCompositeOperation = "source-over";

  const output = document.createElement("canvas");
  output.width = generated.naturalWidth;
  output.height = generated.naturalHeight;
  const ctx = output.getContext("2d");
  ctx.drawImage(generated, 0, 0);
  ctx.globalAlpha = 0.96;
  ctx.drawImage(patch, target.x, target.y, target.width, target.height);
  ctx.globalAlpha = 1;

  return output.toDataURL("image/png");
}

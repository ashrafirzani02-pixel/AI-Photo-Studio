import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import Delaunator from "delaunator";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
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
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Gambar tidak dapat dibaca untuk deteksi wajah."));
    image.src = src;
  });
}

function pointsFor(landmarks, width, height) {
  return landmarks.map(point => ({ x: point.x * width, y: point.y * height }));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function validatePair(source, target, sw, sh, tw, th) {
  if (source.length < 400 || target.length !== source.length) {
    throw new Error("Landmark wajah tidak lengkap.");
  }
  const bounds = pts => ({
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y))
  });
  const a = bounds(source), b = bounds(target);
  const aw = a.maxX-a.minX, ah = a.maxY-a.minY;
  const bw = b.maxX-b.minX, bh = b.maxY-b.minY;
  if (aw < sw*.045 || ah < sh*.045 || bw < tw*.045 || bh < th*.045) {
    throw new Error("Wajah terlalu kecil untuk diproses dengan aman.");
  }
  const eyeA = distance(source[33],source[263]) / aw;
  const eyeB = distance(target[33],target[263]) / bw;
  if (!Number.isFinite(eyeA) || !Number.isFinite(eyeB) || Math.abs(eyeA-eyeB) > .18) {
    throw new Error("Sudut atau proporsi wajah berbeda terlalu jauh.");
  }
}

function affineFromTriangles(s0,s1,s2,d0,d1,d2) {
  const den = s0.x*(s1.y-s2.y)+s1.x*(s2.y-s0.y)+s2.x*(s0.y-s1.y);
  if (Math.abs(den) < .0001) return null;
  const solve = key => {
    const p=s0[key], q=s1[key], r=s2[key];
    return [
      (p*(s1.y-s2.y)+q*(s2.y-s0.y)+r*(s0.y-s1.y))/den,
      (p*(s2.x-s1.x)+q*(s0.x-s2.x)+r*(s1.x-s0.x))/den,
      (p*(s1.x*s2.y-s2.x*s1.y)+q*(s2.x*s0.y-s0.x*s2.y)+r*(s0.x*s1.y-s1.x*s0.y))/den
    ];
  };
  const u=solve.call(null,"x");
  const v=solve.call(null,"y");
  return [u[0],v[0],u[1],v[1],u[2],v[2]];
}

function drawWarpedMesh(sourceImage, sourcePoints, targetPoints, width, height) {
  const canvas=document.createElement("canvas");
  canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext("2d");
  const coords=targetPoints.flatMap(p=>[p.x,p.y]);
  const triangulation=Delaunator.from(targetPoints,p=>p.x,p=>p.y);
  const triangles=triangulation.triangles;
  for(let i=0;i<triangles.length;i+=3){
    const ia=triangles[i], ib=triangles[i+1], ic=triangles[i+2];
    const s0=sourcePoints[ia],s1=sourcePoints[ib],s2=sourcePoints[ic];
    const d0=targetPoints[ia],d1=targetPoints[ib],d2=targetPoints[ic];
    const matrix=affineFromTriangles(s0,s1,s2,d0,d1,d2);
    if(!matrix) continue;
    ctx.save();
    ctx.beginPath();ctx.moveTo(d0.x,d0.y);ctx.lineTo(d1.x,d1.y);ctx.lineTo(d2.x,d2.y);ctx.closePath();ctx.clip();
    ctx.setTransform(...matrix);
    ctx.drawImage(sourceImage,0,0);
    ctx.restore();
  }
  return canvas;
}

function makeOvalMask(landmarks,width,height) {
  const mask=document.createElement("canvas");
  mask.width=width;mask.height=height;
  const ctx=mask.getContext("2d");
  const points=FACE_OVAL.map(index=>landmarks[index]).filter(Boolean);
  if(points.length!==FACE_OVAL.length) throw new Error("Kontur wajah tidak lengkap.");
  ctx.beginPath();
  ctx.moveTo(points[0].x,points[0].y);
  for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);
  ctx.closePath();
  ctx.fillStyle="#fff";ctx.fill();
  const feather=Math.max(3,Math.round(Math.min(width,height)*.008));
  const softened=document.createElement("canvas");
  softened.width=width;softened.height=height;
  const soft=softened.getContext("2d");
  soft.filter="blur("+feather+"px)";
  soft.drawImage(mask,0,0);
  return softened;
}

/**
 * Experimental landmark mesh preservation.
 * The original face mesh is piecewise-affine warped onto the generated face,
 * then feather-masked to the MediaPipe face oval. If checks fail, no composite
 * is returned and the caller must retain the untouched generated image.
 */
export async function preserveFacePixels(originalSrc, generatedSrc) {
  const landmarker=await getLandmarker();
  const [original,generated]=await Promise.all([loadImage(originalSrc),loadImage(generatedSrc)]);
  const originalResult=landmarker.detect(original);
  const generatedResult=landmarker.detect(generated);
  const originalLandmarks=originalResult.faceLandmarks?.[0];
  const generatedLandmarks=generatedResult.faceLandmarks?.[0];
  if(!originalLandmarks||!generatedLandmarks)throw new Error("Wajah tidak terdeteksi pada kedua gambar.");
  const source=pointsFor(originalLandmarks,original.naturalWidth,original.naturalHeight);
  const target=pointsFor(generatedLandmarks,generated.naturalWidth,generated.naturalHeight);
  validatePair(source,target,original.naturalWidth,original.naturalHeight,generated.naturalWidth,generated.naturalHeight);
  const warped=drawWarpedMesh(original,source,target,generated.naturalWidth,generated.naturalHeight);
  const mask=makeOvalMask(target,generated.naturalWidth,generated.naturalHeight);
  const output=document.createElement("canvas");
  output.width=generated.naturalWidth;output.height=generated.naturalHeight;
  const ctx=output.getContext("2d");
  ctx.drawImage(generated,0,0);
  ctx.save();
  ctx.globalCompositeOperation="destination-in";
  ctx.drawImage(mask,0,0);
  ctx.restore();
  const faceLayer=document.createElement("canvas");
  faceLayer.width=generated.naturalWidth;faceLayer.height=generated.naturalHeight;
  const faceCtx=faceLayer.getContext("2d");
  faceCtx.drawImage(warped,0,0);
  faceCtx.globalCompositeOperation="destination-in";
  faceCtx.drawImage(mask,0,0);
  const finalCanvas=document.createElement("canvas");
  finalCanvas.width=generated.naturalWidth;finalCanvas.height=generated.naturalHeight;
  const finalCtx=finalCanvas.getContext("2d");
  finalCtx.drawImage(generated,0,0);
  finalCtx.drawImage(faceLayer,0,0);
  return finalCanvas.toDataURL("image/png");
}

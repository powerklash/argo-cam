// Scarica i modelli per il riconoscimento di volti e mezzi in data/models, verificandone l'impronta SHA-256.
// Fonte: OpenCV Zoo (github.com/opencv/opencv_zoo), file su Git LFS.
//   node tools/get-models.mjs
//
// Modelli (licenze: YuNet MIT, SFace Apache-2.0, YOLOX Apache-2.0):
//   face_detection_yunet_2023mar.onnx        232.589 byte
//   face_recognition_sface_2021dec.onnx   38.696.353 byte
//   object_detection_yolox_2022nov.onnx   35.858.002 byte
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from '../lib/paths.js';

const DIR = path.join(DATA, 'models');
const BASE = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models';
const MODELS = [
  { file: 'face_detection_yunet_2023mar.onnx', dir: 'face_detection_yunet', size: 232589, sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
  { file: 'face_recognition_sface_2021dec.onnx', dir: 'face_recognition_sface', size: 38696353, sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79' },
  { file: 'object_detection_yolox_2022nov.onnx', dir: 'object_detection_yolox', size: 35858002, sha256: 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063' },
  // Riconoscimento dei singoli animali (impronta visiva dell'animale ritagliato). Facoltativo; licenza Apache-2.0.
  { file: 'image_classification_mobilenetv2_2022apr.onnx', dir: 'image_classification_mobilenet', size: 13964571, sha256: 'c0c3f76d93fa3fd6580652a45618618a220fced18babf65774ed169de0432ad5' },
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
fs.mkdirSync(DIR, { recursive: true });

let failed = false;
for (const m of MODELS) {
  const target = path.join(DIR, m.file);
  if (fs.existsSync(target) && sha(fs.readFileSync(target)) === m.sha256) {
    console.log(`già presente e verificato: ${m.file}`);
    continue;
  }
  const url = `${BASE}/${m.dir}/${m.file}`;
  console.log(`scarico ${m.file} (${(m.size / 1e6).toFixed(1)} MB)…`);
  const res = await fetch(url);
  if (!res.ok) { console.error(`  errore HTTP ${res.status} da ${url}`); failed = true; continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== m.size || sha(buf) !== m.sha256) {
    console.error(`  verifica fallita: ${buf.length} byte, sha256 ${sha(buf)} (atteso ${m.size} byte, ${m.sha256})`);
    failed = true;
    continue;
  }
  fs.writeFileSync(target, buf);
  console.log('  ok, impronta verificata');
}
process.exit(failed ? 1 : 0);

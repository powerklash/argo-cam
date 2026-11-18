// Genera le icone PNG dell'app (192, 512 e apple-touch-icon 180) con lo stesso disegno di public/icon.svg.
//   node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const inPoly = (x, y, pts) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

// Elenco di forme (dal fondo): [test, colore]
const shapes = (rounded) => [
  [(x, y) => (rounded ? inRound(x, y, 0, 0, 512, 512, 112) : true), hex('#0e1116')],
  [(x, y) => inRound(x, y, 48, 48, 464, 464, 88), hex('#1b2230')],
  // occhi piccoli (Argo, il guardiano dai cento occhi), sopra e sotto
  ...[136, 176, 216, 256, 296, 336, 376].flatMap((cx, i) => {
    const dy = [0, -7, -12, -14, -12, -7, 0][i];
    return [
      [(x, y) => inCircle(x, y, cx, 128 + dy, 9), hex('#5cc8ff', 0.8)],
      [(x, y) => inCircle(x, y, cx, 384 - dy, 9), hex('#5cc8ff', 0.8)],
    ];
  }),
  // occhio grande: lente (intersezione di due cerchi), iride, pupilla, riflesso
  [(x, y) => inCircle(x, y, 256, 376, 200) && inCircle(x, y, 256, 136, 200), hex('#3b82f6')],
  [(x, y) => inCircle(x, y, 256, 256, 68), hex('#0e1116')],
  [(x, y) => inCircle(x, y, 256, 256, 40), hex('#5cc8ff')],
  [(x, y) => inCircle(x, y, 274, 238, 12), hex('#ffffff', 0.85)],
];

function render(size, rounded) {
  const list = shapes(rounded);
  const SS = 3;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((pxi + (sx + 0.5) / SS) / size) * 512, y = ((py + (sy + 0.5) / SS) / size) * 512;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const [test, [R, G, B, A]] of list) {
            if (!test(x, y)) continue;
            const na = A + ca * (1 - A);
            cr = (R * A + cr * ca * (1 - A)) / na; cg = (G * A + cg * ca * (1 - A)) / na; cb = (B * A + cb * ca * (1 - A)) / na; ca = na;
          }
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const n = SS * SS, o = (py * size + pxi) * 4;
      px[o] = a ? Math.round(r / a) : 0; px[o + 1] = a ? Math.round(g / a) : 0; px[o + 2] = a ? Math.round(b / a) : 0; px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [file, size, rounded] of [['icon-192.png', 192, true], ['icon-512.png', 512, true], ['apple-touch-icon.png', 180, false]]) {
  fs.writeFileSync(path.join(OUT, file), png(size, render(size, rounded)));
  console.log(`${file} ${size}x${size}`);
}

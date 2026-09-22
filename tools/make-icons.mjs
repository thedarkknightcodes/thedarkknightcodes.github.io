/**
 * tools/make-icons.mjs — builds the four PWA icon PNGs from scratch, with
 * zero npm packages. It hand-draws a calm rounded-square in the app's
 * accent green with a simple white check-mark, then writes real PNG bytes
 * (signature + IHDR + IDAT + IEND, each with a CRC) using only Node's
 * built-in `zlib` module for the compression PNG requires.
 *
 * Why no dependencies: this project has no build step and no npm install
 * step, so a normal image library isn't an option — this script is the
 * whole "library", just for the one thing we need (flat-colour PNGs).
 *
 * Run it with: node tools/make-icons.mjs
 * Re-run it any time you want to change the icon design; it always
 * overwrites the same four files in icons/.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, "..", "icons");

// Colours pulled straight from styles.css's light theme so the icon
// matches the app instead of being a random green.
const ACCENT = [0x3d, 0x6b, 0x5c]; // --accent
const WHITE = [0xff, 0xff, 0xff]; // --accent-contrast

// ---------------------------------------------------------------------------
// tiny drawing helpers — everything below just fills a grid of RGBA bytes
// ---------------------------------------------------------------------------

function newCanvas(size) {
  // RGBA, one byte per channel, starts fully transparent (all zeros).
  return new Uint8ClampedArray(size * size * 4);
}

function setPixel(canvas, size, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  // "Over" blend against whatever's already there, so antialiased edges
  // (alpha between 0 and 255) look like a smooth curve, not jagged steps.
  const a = alpha / 255;
  canvas[i] = canvas[i] * (1 - a) + rgb[0] * a;
  canvas[i + 1] = canvas[i + 1] * (1 - a) + rgb[1] * a;
  canvas[i + 2] = canvas[i + 2] * (1 - a) + rgb[2] * a;
  canvas[i + 3] = Math.max(canvas[i + 3], alpha);
}

function clampCoverage(d) {
  // d > 0.5 => fully inside the shape, d < -0.5 => fully outside,
  // in between => the antialiased edge pixel.
  return Math.max(0, Math.min(1, d + 0.5));
}

// How "inside" a rounded square a point is, used to both fill the shape
// and soften its edge over about 1px.
function roundedSquareCoverage(px, py, size, radius) {
  const half = size / 2;
  const dx = Math.abs(px - half) - (half - radius);
  const dy = Math.abs(py - half) - (half - radius);
  const outsideDist = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2) + Math.min(Math.max(dx, dy), 0) - radius;
  return clampCoverage(-outsideDist);
}

// Distance from a point to a line segment, for drawing the check-mark as
// one thick antialiased stroke instead of single-pixel-wide lines.
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function checkCoverage(px, py, size, safeScale) {
  // The check-mark is drawn inside a centred box that's `safeScale` of the
  // whole canvas — that box IS the padding: a smaller safeScale means more
  // room around the mark before the canvas edge (or a maskable launcher's
  // crop circle) gets anywhere near it.
  const box = size * safeScale;
  const off = (size - box) / 2;
  const at = (u, v) => [off + u * box, off + v * box];
  const [ax, ay] = at(0.28, 0.52);
  const [bx, by] = at(0.44, 0.68);
  const [cx, cy] = at(0.75, 0.32);
  const halfWidth = box * 0.075;
  const d = Math.min(distToSegment(px, py, ax, ay, bx, by), distToSegment(px, py, bx, by, cx, cy));
  return clampCoverage(halfWidth - d);
}

/**
 * Draws one icon into a fresh canvas.
 * - fullBleed: true paints the entire square opaque, edge to edge, with no
 *   rounded corners — required for maskable icons (an OS may crop them
 *   into a circle or squircle, so there must be no transparency at the
 *   edge) and recommended for the Apple touch icon (iOS applies its own
 *   rounding on top).
 * - safeScale: how big the check-mark's bounding box is, as a fraction of
 *   the canvas. Smaller = more padding. Maskable icons need extra padding
 *   (the platform's "safe zone" is the centre 80%; we use noticeably less
 *   than that so the mark survives even an aggressive circular crop).
 */
function drawIcon(size, { fullBleed, safeScale }) {
  const canvas = newCanvas(size);
  const radius = fullBleed ? 0 : size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bg = fullBleed ? 1 : roundedSquareCoverage(x + 0.5, y + 0.5, size, radius);
      if (bg > 0) setPixel(canvas, size, x, y, ACCENT, Math.round(bg * 255));
      const check = checkCoverage(x + 0.5, y + 0.5, size, safeScale);
      if (check > 0) setPixel(canvas, size, x, y, WHITE, Math.round(check * 255));
    }
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// PNG encoding — no dependencies, just the file format's own rules
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Every PNG chunk is: 4-byte length, 4-byte type, the data, 4-byte CRC of
// (type + data). This builds one chunk of any type.
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(canvas, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth: 8 bits per channel
  ihdr[9] = 6; // colour type 6 = RGBA (truecolour + alpha)
  ihdr[10] = 0; // compression method (always 0)
  ihdr[11] = 0; // filter method (always 0)
  ihdr[12] = 0; // interlace method: 0 = none

  // PNG scanlines each need a one-byte "filter type" in front of the raw
  // pixel bytes; 0 ("None") means "just the raw bytes", which is simplest
  // and plenty small at icon sizes.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size * 4; x++) {
      raw[rowStart + 1 + x] = canvas[y * size * 4 + x];
    }
  }
  // PNG's IDAT chunk holds that raw data compressed with zlib — which is
  // exactly the format node's zlib.deflateSync produces by default.
  const idatData = deflateSync(raw);

  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
}

function writeIcon(filename, size, opts) {
  const canvas = drawIcon(size, opts);
  const png = encodePng(canvas, size);
  writeFileSync(path.join(ICONS_DIR, filename), png);
  console.log("wrote icons/" + filename + " (" + size + "x" + size + ", " + png.length + " bytes)");
}

mkdirSync(ICONS_DIR, { recursive: true });
writeIcon("icon-192.png", 192, { fullBleed: false, safeScale: 0.62 });
writeIcon("icon-512.png", 512, { fullBleed: false, safeScale: 0.62 });
writeIcon("maskable-512.png", 512, { fullBleed: true, safeScale: 0.52 });
writeIcon("apple-touch-icon.png", 180, { fullBleed: true, safeScale: 0.6 });

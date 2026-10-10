import { crc32, deflateSync } from "node:zlib";
import { RES, drawOffice, officeLayout, type OfficeModel } from "../web/public/office.js";

/**
 * A still of the office as a PNG, for chat apps that show pictures. The same drawing as the panel's,
 * scaled up without smoothing so the pixels stay pixels.
 */
export function officePng(model: OfficeModel, scale = 4): Uint8Array {
  const { width, height } = officeLayout(model);
  const w = width * scale;
  const h = height * scale;
  // The drawing is RES pixels to a unit of the layout; `scale` pixels to a unit is what the picture ends up as.
  const k = scale / RES;
  const pixels = new Uint8Array(w * h * 4);
  drawOffice(
    {
      rect(x, y, rw, rh, colour) {
        const [r, g, b] = rgb(colour);
        const x0 = Math.max(0, Math.round(x * k));
        const y0 = Math.max(0, Math.round(y * k));
        const x1 = Math.min(w, Math.round((x + rw) * k));
        const y1 = Math.min(h, Math.round((y + rh) * k));
        for (let py = y0; py < y1; py++) {
          for (let px = x0; px < x1; px++) {
            const i = (py * w + px) * 4;
            pixels[i] = r;
            pixels[i + 1] = g;
            pixels[i + 2] = b;
            pixels[i + 3] = 255;
          }
        }
      },
    },
    model,
    0,
  );
  return encodePng(w, h, pixels);
}

function rgb(colour: string): [number, number, number] {
  const n = Number.parseInt(colour.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The smallest PNG writer that works: one IDAT, filter 0 on every row, RGBA 8-bit. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, no filter set, no interlace
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typed = new TextEncoder().encode(type);
  out.set(typed, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

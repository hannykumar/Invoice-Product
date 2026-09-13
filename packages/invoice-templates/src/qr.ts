/**
 * Issue #144 — a QR code, drawn here rather than fetched or imported.
 *
 * The bill has to print with no network, years from now, from the stored document alone. A QR
 * library would be a dependency whose output could change under a reprint, and an image service is
 * a network call. The standard is small and fixed, so it is written out once, following ISO/IEC
 * 18004: byte mode, error correction level M (a quarter of the square may be smudged or folded and
 * it still scans), versions 1 to 15.
 *
 * Every mask gives a square any phone reads; the penalty score only picks the one that reads most
 * easily, which is what the standard asks for.
 */

/** Error-correction codewords per block at level M, by version (index 0 unused). */
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
/** Number of error-correction blocks at level M, by version. */
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
export const MAX_QR_VERSION = 15;

const rawDataModules = (version: number): number => {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
};

const dataCodewords = (version: number): number =>
  Math.floor(rawDataModules(version) / 8) - (ECC_PER_BLOCK_M[version] as number) * (BLOCKS_M[version] as number);

/** The most bytes a version-15 square at level M can hold. */
export const MAX_QR_BYTES = dataCodewords(MAX_QR_VERSION) - 3;

const gfMultiply = (x: number, y: number): number => {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
};

const rsDivisor = (degree: number): number[] => {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
};

const rsRemainder = (data: readonly number[], divisor: readonly number[]): number[] => {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] as number) ^ gfMultiply(coef, factor);
    });
  }
  return result;
};

const alignmentPositions = (version: number): number[] => {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
};

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** A square of dark (`true`) and light modules, without the quiet zone. */
export type QrMatrix = readonly (readonly boolean[])[];

const encodeCodewords = (bytes: readonly number[], version: number): number[] => {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = BLOCKS_M[version] as number;
  const eccLen = ECC_PER_BLOCK_M[version] as number;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const block = data.slice(k, k + len);
    k += len;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, divisor));
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLen - eccLen; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i] as number);
  for (let i = 0; i < eccLen; i++) for (const b of eccBlocks) out.push(b[i] as number);
  return out;
};

const penalty = (m: boolean[][]): number => {
  const size = m.length;
  let score = 0;
  const runs = (get: (i: number, j: number) => boolean): void => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  };
  runs((y, x) => m[y]![x]!);
  runs((x, y) => m[y]![x]!);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y]![x]) dark++;
      if (y + 1 < size && x + 1 < size) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
      }
    }
  }
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
};

/**
 * Encodes text as a QR square, choosing the smallest version that holds it.
 *
 * Throws when the text is longer than a version-15 square can hold, rather than silently cutting
 * it: a payment square that carries half an instruction is worse than none.
 */
export const encodeQr = (text: string): QrMatrix => {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= MAX_QR_VERSION && bytes.length + (version <= 9 ? 2 : 3) > dataCodewords(version)) version++;
  if (version > MAX_QR_VERSION) {
    throw new Error(`That is too long to fit in a scan square (${bytes.length} bytes, at most ${MAX_QR_BYTES}).`);
  }
  const codewords = encodeCodewords(bytes, version);
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFixed = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark;
    fixed[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) setFixed(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  align.forEach((ax, i) =>
    align.forEach((ay, j) => {
      const last = align.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFixed(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const drawFormat = (mask: number): void => {
    const data = mask; // level M is 00, so the format data is the mask number alone
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFixed(8, i, bit(i));
    setFixed(8, 7, bit(6));
    setFixed(8, 8, bit(7));
    setFixed(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFixed(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFixed(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFixed(8, size - 15 + i, bit(i));
    setFixed(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFixed(a, b, dark);
      setFixed(b, a, dark);
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = (((codewords[i >>> 3] as number) >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  const applyMask = (mask: number): void => {
    const rule = MASKS[mask] as (x: number, y: number) => boolean;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y]![x] && rule(x, y)) modules[y]![x] = !modules[y]![x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(modules);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(mask); // masking is its own inverse
  }
  applyMask(best);
  drawFormat(best);
  return modules;
};

/**
 * The square as an SVG that fills whatever box it is placed in.
 *
 * Four modules of white margin are part of the drawing, because a scanner needs that quiet zone and
 * a table border drawn tight against the square would otherwise stop it reading.
 */
export const qrSvg = (text: string, label: string): string => {
  const matrix = encodeQr(text);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  let path = '';
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }),
  );
  const safeLabel = label.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="${safeLabel}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
};

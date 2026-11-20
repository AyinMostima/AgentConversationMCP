#!/usr/bin/env node
// Builds the AGORA icon files from one description of the mark:
//
//   ui/public/logo.svg     favicon of the console
//   ui/public/agora.ico     desktop shortcut (16 to 256 px)
//   docs/images/logo.svg   README
//
// The mark: two crescents facing each other around a central diamond on an
// ink-navy tile (#131B2F). Small icon sizes use a heavier stroke cut so 16 px
// renders stay sharp.
//
//   node scripts/build-icon.mjs
//
// Needs Playwright with Chrome for the .ico (npm install -g playwright); the
// two .svg files are written without it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const INK = '#131B2F';
const LABEL = 'AGORA - AgentConversationMCP';
const round = (value) => Math.round(value * 100) / 100;

/**
 * The two crescents and the diamond on a 512 grid. `weight` is how thick a
 * crescent is at its middle, `reach` how much of the tile the pair fills and
 * `core` the half-diagonal of the diamond.
 */
export function mark({ weight, reach, core }) {
  const radius = 170;
  // A crescent is what one circle keeps when an equal circle, shifted sideways by `weight`, is taken away.
  const half = Math.sqrt(radius ** 2 - (weight / 2) ** 2);
  const gap = 15;
  const top = round(256 - half);
  const bottom = round(256 + half);
  const left = `M${256 - gap} ${top}A${radius} ${radius} 0 1 0 ${256 - gap} ${bottom}A${radius} ${radius} 0 0 1 ${256 - gap} ${top}Z`;
  const right = `M${256 + gap} ${top}A${radius} ${radius} 0 1 1 ${256 + gap} ${bottom}A${radius} ${radius} 0 0 0 ${256 + gap} ${top}Z`;
  const diamond = `M256 ${256 - core}l${core} ${core}-${core} ${core}-${core}-${core}z`;
  return { crescents: `${left}${right}`, diamond, transform: `rotate(-35 256 256) translate(256 256) scale(${reach}) translate(-256 -256)` };
}
export const REGULAR = { weight: 70, reach: 0.84, core: 40 };
export const BOLD = { weight: 100, reach: 0.9, core: 54 };

export function tile(cut, { ink = INK, paper = '#ffffff' } = {}) {
  const shape = mark(cut);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${LABEL}">`,
    `  <rect width="512" height="512" rx="114" fill="${ink}"/>`,
    `  <path transform="${shape.transform}" fill="${paper}" d="${shape.crescents}"/>`,
    `  <path fill="${paper}" d="${shape.diamond}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/** Packs PNG images into one .ico file; Windows reads PNG entries at every size. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

async function main() {
  const svg = tile(REGULAR);
  mkdirSync(join(repoRoot, 'docs', 'images'), { recursive: true });
  writeFileSync(join(repoRoot, 'ui', 'public', 'logo.svg'), svg);
  writeFileSync(join(repoRoot, 'docs', 'images', 'logo.svg'), svg);
  console.log('[OK] ui/public/logo.svg, docs/images/logo.svg');

  let playwright;
  for (const from of [join(repoRoot, 'package.json'), join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'playwright', 'package.json')]) {
    try {
      playwright = createRequire(from)('playwright');
      break;
    } catch {
      // Try the next location.
    }
  }
  if (playwright === undefined) {
    console.error('[WARN] playwright is not installed, so ui/public/agora.ico was left as it is; run: npm install -g playwright');
    process.exitCode = 1;
    return;
  }
  const browser = await playwright.chromium.launch({ channel: 'chrome' });
  const images = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${tile(size <= 48 ? BOLD : REGULAR)}`);
    images.push({ size, png: await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }) });
    await page.close();
  }
  await browser.close();
  writeFileSync(join(repoRoot, 'ui', 'public', 'agora.ico'), ico(images));
  console.log(`[OK] ui/public/agora.ico (${images.map((image) => image.size).join(', ')} px)`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

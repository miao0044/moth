const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SVG = path.join(__dirname, 'icon.svg');
const ICO = path.join(__dirname, 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const svg = fs.readFileSync(SVG);
  const pngPaths = [];
  for (const size of sizes) {
    const outPath = path.join(__dirname, `icon-${size}.png`);
    await sharp(svg, { density: 400 })
      .resize(size, size)
      .png()
      .toFile(outPath);
    pngPaths.push(outPath);
    console.log(`  ${size}x${size} -> ${outPath}`);
  }

  const pngToIco = (await import('png-to-ico')).default;
  const ico = await pngToIco(pngPaths);
  fs.writeFileSync(ICO, ico);
  console.log(`  ico -> ${ICO}`);
}

main().catch(e => { console.error(e); process.exit(1); });

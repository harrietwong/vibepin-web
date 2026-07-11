const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const src = path.resolve("d:/代码/Pinterest flow/图片/LOGO .png");
const out = path.resolve("d:/代码/Pinterest flow/web/public");

fs.mkdirSync(out, { recursive: true });

async function run() {
  // Core logo copy
  await sharp(src).resize(512, 512).png().toFile(path.join(out, "logo.png"));
  await sharp(src).resize(512, 512).png().toFile(path.join(out, "icon-512.png"));

  // PWA icons — with dark background for maskable
  await sharp(src).resize(192, 192).png().toFile(path.join(out, "icon-192.png"));

  // Maskable — add 20% padding so mark sits inside safe zone
  const padded = 512;
  const logoSz = Math.round(512 * 0.8);
  const offset = Math.round((padded - logoSz) / 2);
  await sharp({ create: { width: padded, height: padded, channels: 4, background: { r: 8, g: 14, b: 24, alpha: 1 } } })
    .composite([{ input: await sharp(src).resize(logoSz, logoSz).png().toBuffer(), top: offset, left: offset }])
    .png().toFile(path.join(out, "maskable-icon-512.png"));
  await sharp({ create: { width: 192, height: 192, channels: 4, background: { r: 8, g: 14, b: 24, alpha: 1 } } })
    .composite([{ input: await sharp(src).resize(154, 154).png().toBuffer(), top: 19, left: 19 }])
    .png().toFile(path.join(out, "maskable-icon-192.png"));

  // Apple touch icon
  await sharp(src).resize(180, 180).png().toFile(path.join(out, "apple-touch-icon.png"));

  // Favicons
  await sharp(src).resize(32, 32).png().toFile(path.join(out, "favicon-32x32.png"));
  await sharp(src).resize(16, 16).png().toFile(path.join(out, "favicon-16x16.png"));

  // favicon.ico — multi-size ICO using the 32x32 PNG embedded as ICO
  // Node sharp cannot write .ico natively; write a minimal single-frame ICO manually
  const ico32 = await sharp(src).resize(32, 32).png().toBuffer();
  const ico16 = await sharp(src).resize(16, 16).png().toBuffer();

  // Minimal ICO: ICONDIR + 2 image entries + PNG data
  function writeLe16(buf, offset, val) { buf.writeUInt16LE(val, offset); }
  function writeLe32(buf, offset, val) { buf.writeUInt32LE(val, offset); }
  const ICONDIR_SIZE = 6;
  const ICONDIRENTRY_SIZE = 16;
  const headerSize = ICONDIR_SIZE + ICONDIRENTRY_SIZE * 2;
  const ico32Offset = headerSize;
  const ico16Offset = headerSize + ico32.length;
  const total = ico16Offset + ico16.length;
  const icoBuffer = Buffer.alloc(total);
  // ICONDIR
  writeLe16(icoBuffer, 0, 0);   // reserved
  writeLe16(icoBuffer, 2, 1);   // type: 1 = ICO
  writeLe16(icoBuffer, 4, 2);   // count: 2 images
  // Entry 0: 32x32
  icoBuffer[6] = 32; icoBuffer[7] = 32; icoBuffer[8] = 0; icoBuffer[9] = 0;
  writeLe16(icoBuffer, 10, 1); writeLe16(icoBuffer, 12, 32);
  writeLe32(icoBuffer, 14, ico32.length);
  writeLe32(icoBuffer, 18, ico32Offset);
  // Entry 1: 16x16
  icoBuffer[22] = 16; icoBuffer[23] = 16; icoBuffer[24] = 0; icoBuffer[25] = 0;
  writeLe16(icoBuffer, 26, 1); writeLe16(icoBuffer, 28, 32);
  writeLe32(icoBuffer, 30, ico16.length);
  writeLe32(icoBuffer, 34, ico16Offset);
  ico32.copy(icoBuffer, ico32Offset);
  ico16.copy(icoBuffer, ico16Offset);
  fs.writeFileSync(path.join(out, "favicon.ico"), icoBuffer);

  console.log("Done. Files written to", out);
  fs.readdirSync(out).filter(f => /\.(png|ico|svg)$/i.test(f)).forEach(f => console.log(" ", f));
}
run().catch(e => { console.error(e); process.exit(1); });

// A zip file, built by hand so the app needs no package. Files are stored as they are, uncompressed: photos and videos
// are compressed already. Every entry uses the Zip64 format, so one tested layout holds exports of any size, past
// the plain format's 4 GB and 65,535 files.

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

// Read in pieces, so a large file is never held in memory twice.
async function crc32(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  for (let piece = await reader.read(); !piece.done; piece = await reader.read()) {
    const bytes = piece.value;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Little-endian fields of 2, 4 or 8 bytes.
function fields(...values: [size: 2 | 4 | 8, value: number][]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(values.reduce((sum, [size]) => sum + size, 0));
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const [size, value] of values) {
    if (size === 2) view.setUint16(at, value, true);
    else if (size === 4) view.setUint32(at, value, true);
    else view.setBigUint64(at, BigInt(value), true);
    at += size;
  }
  return bytes;
}

// The zip's own date format, in the computer's local time.
function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const ZIP64 = 45; // the format version that reads Zip64
const UTF8_NAMES = 0x0800;
const UNKNOWN = 0xffffffff; // "see the Zip64 field"

export async function zip(files: { path: string; data: Blob }[], date: Date): Promise<Blob> {
  const { time, day } = dosTime(date);
  const parts: BlobPart[] = [];
  const directory: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const { path, data } of files) {
    const name = new TextEncoder().encode(path);
    const crc = await crc32(data);
    const local = fields(
      [4, 0x04034b50],
      [2, ZIP64],
      [2, UTF8_NAMES],
      [2, 0],
      [2, time],
      [2, day],
      [4, crc],
      [4, UNKNOWN],
      [4, UNKNOWN],
      [2, name.length],
      [2, 20],
    );
    const localZip64 = fields([2, 1], [2, 16], [8, data.size], [8, data.size]);
    parts.push(local, name, localZip64, data);
    directory.push(
      fields(
        [4, 0x02014b50],
        [2, ZIP64],
        [2, ZIP64],
        [2, UTF8_NAMES],
        [2, 0],
        [2, time],
        [2, day],
        [4, crc],
        [4, UNKNOWN],
        [4, UNKNOWN],
        [2, name.length],
        [2, 28],
        [2, 0],
        [2, 0],
        [2, 0],
        [4, 0],
        [4, UNKNOWN],
      ),
      name,
      fields([2, 1], [2, 24], [8, data.size], [8, data.size], [8, offset]),
    );
    offset += local.length + name.length + localZip64.length + data.size;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = offset + directorySize;
  parts.push(
    ...directory,
    // Zip64 end of central directory record, its locator, then the plain end record pointing to them.
    fields(
      [4, 0x06064b50],
      [8, 44],
      [2, ZIP64],
      [2, ZIP64],
      [4, 0],
      [4, 0],
      [8, files.length],
      [8, files.length],
      [8, directorySize],
      [8, offset],
    ),
    fields([4, 0x07064b50], [4, 0], [8, end], [4, 1]),
    fields([4, 0x06054b50], [2, 0], [2, 0], [2, 0xffff], [2, 0xffff], [4, UNKNOWN], [4, UNKNOWN], [2, 0]),
  );
  return new Blob(parts, { type: "application/zip" });
}

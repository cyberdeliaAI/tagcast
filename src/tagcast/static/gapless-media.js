"use strict";

// Local experiment: lossless FLAC-to-fMP4 framing. No transcoding of original FLAC.
const gaplessMedia = (() => {
  const encoder = new TextEncoder();
  const cat = (...items) => { const out = new Uint8Array(items.reduce((n, a) => n + a.length, 0)); let n = 0; for (const a of items) { out.set(a, n); n += a.length; } return out; };
  const u32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const u16 = n => new Uint8Array([(n >>> 8) & 255, n & 255]);
  const box = (name, ...data) => { const content = cat(...data); return cat(u32(content.length + 8), encoder.encode(name), content); };
  const full = (name, flags, ...data) => box(name, u32(flags), ...data);
  const read32 = (a, n) => new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(n);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const crcTable = (bits, poly) => Array.from({length: 256}, (_, i) => { let n = i << (bits - 8); for (let b = 0; b < 8; b++) n = ((n << 1) ^ (n & (1 << (bits - 1)) ? poly : 0)) & ((1 << bits) - 1); return n; });
  const crc8Table = crcTable(8, 7), crc16Table = crcTable(16, 0x8005);
  const crc = (a, start, end, bits = 16) => { const table = bits === 8 ? crc8Table : crc16Table, mask = bits === 8 ? 255 : 65535; let n = 0; for (let i = start; i < end; i++) n = ((n << 8) ^ table[((n >>> (bits - 8)) ^ a[i]) & 255]) & mask; return n; };
  const utf = value => { if (value < 128) return new Uint8Array([value]); let count = 2; while (value >= 2 ** (5 * count + 1)) count++; const out = new Uint8Array(count); for (let i = count - 1; i > 0; i--) { out[i] = 128 | (value & 63); value = Math.floor(value / 64); } out[0] = (256 - 2 ** (8 - count)) | value; return out; };
  function readUtf(a, pos) {
    const first = a[pos++]; if (first < 128) return [first, pos];
    let count = 0; for (let bit = 128; first & bit; bit >>>= 1) count++;
    check(count >= 2 && count <= 7 && pos + count - 1 < a.length, "Invalid FLAC frame number.");
    let value = first & (127 >>> count);
    for (let i = 1; i < count; i++) { const byte = a[pos++]; check((byte & 192) === 128, "Invalid FLAC frame number."); value = value * 64 + (byte & 63); }
    return [value, pos];
  }
  function flacHeader(a, start, info) {
    check(a[start] === 255 && (a[start + 1] & 254) === 248 && !(a[start + 3] & 1), "Invalid FLAC frame.");
    const variable = Boolean(a[start + 1] & 1), block = a[start + 2] >>> 4, rateCode = a[start + 2] & 15;
    const assignment = a[start + 3] >>> 4, depth = (a[start + 3] >>> 1) & 7;
    let [number, p] = readUtf(a, start + 4), samples;
    if (block === 1) samples = 192;
    else if (block >= 2 && block <= 5) samples = 576 * 2 ** (block - 2);
    else if (block === 6) samples = a[p++] + 1;
    else if (block === 7) { samples = (a[p] << 8 | a[p + 1]) + 1; p += 2; }
    else if (block >= 8) samples = 256 * 2 ** (block - 8);
    check(samples > 0, "Invalid FLAC block size.");
    let rate = [info.rate, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000][rateCode];
    if (rateCode === 12) rate = a[p++] * 1000;
    else if (rateCode === 13 || rateCode === 14) { rate = (a[p] << 8 | a[p + 1]) * (rateCode === 14 ? 10 : 1); p += 2; }
    const bits = [info.bits, 8, 12, 0, 16, 20, 24, 32][depth], channels = assignment <= 7 ? assignment + 1 : assignment <= 10 ? 2 : 0;
    check(rate === info.rate && bits === info.bits && channels === info.channels && crc(a, start, p + 1, 8) === 0, "FLAC frame does not match STREAMINFO.");
    return {number, samples, variable, headerEnd: p + 1};
  }
  function parseFlac(a) {
    check(a.length > 42 && String.fromCharCode(...a.subarray(0, 4)) === "fLaC", "Original stream is not native FLAC.");
    let pos = 4, info, last = false;
    while (!last) {
      check(pos + 4 <= a.length, "Truncated FLAC metadata.");
      last = Boolean(a[pos] & 128); const kind = a[pos] & 127, size = a[pos + 1] * 65536 + a[pos + 2] * 256 + a[pos + 3]; pos += 4;
      check(pos + size <= a.length, "Truncated FLAC metadata.");
      if (kind === 0) {
        check(!info && size === 34, "Invalid FLAC STREAMINFO.");
        const data = a.slice(pos, pos + size), rate = data[10] * 4096 + data[11] * 16 + (data[12] >>> 4);
        info = {rate, channels: ((data[12] >>> 1) & 7) + 1, bits: ((data[12] & 1) << 4 | data[13] >>> 4) + 1,
          total: (data[13] & 15) * 2 ** 32 + read32(data, 14), streaminfo: data};
      }
      pos += size;
    }
    check(info && info.total > 0 && info.rate >= 8000 && info.rate <= 192000 && info.channels <= 2 && [16, 24].includes(info.bits), "This FLAC format is outside the gapless trial limits.");
    const frames = []; let samples = 0;
    while (pos < a.length) {
      const h = flacHeader(a, pos, info), expected = h.variable ? samples : frames.length;
      check(h.number === expected, "Non-contiguous FLAC frame numbers.");
      let next = h.headerEnd + 2, checksum = crc(a, pos, next);
      for (; next < a.length - 5; checksum = ((checksum << 8) ^ crc16Table[((checksum >>> 8) ^ a[next]) & 255]) & 65535, next++) {
        if (checksum !== 0 || a[next] !== 255 || (a[next + 1] & 254) !== 248) continue;
        let candidate; try { candidate = flacHeader(a, next, info); } catch { continue; }
        if (candidate.variable !== h.variable || candidate.number !== (h.variable ? samples + h.samples : frames.length + 1)) continue;
        break;
      }
      if (next >= a.length - 5) next = a.length;
      check(crc(a, pos, next) === 0, "FLAC frame checksum failed.");
      frames.push({data: a.subarray(pos, next), samples: h.samples}); samples += h.samples; pos = next;
      check(frames.length <= 100000 && samples <= info.total, "FLAC frame bounds exceeded.");
    }
    check(samples === info.total, "FLAC sample count does not match STREAMINFO.");
    return {...info, frames};
  }
  function streamInfo(rate, channels, bits, total, block) {
    const a = new Uint8Array(34); a.set(u16(block), 0); a.set(u16(block), 2);
    a[10] = rate >>> 12; a[11] = rate >>> 4; a[12] = (rate & 15) << 4 | (channels - 1) << 1 | (bits - 1) >>> 4;
    a[13] = (bits - 1 & 15) << 4 | Math.floor(total / 2 ** 32); a.set(u32(total), 14); return a;
  }
  function pcmFlac(buffer) {
    const {sampleRate: rate, numberOfChannels: channels, length: total} = buffer, bits = 24, block = 4096, frames = [];
    check(channels >= 1 && channels <= 2 && total * channels * 4 <= 128 * 1024 ** 2, "MP3 decoding exceeds the trial memory limit.");
    const planes = Array.from({length: channels}, (_, n) => buffer.getChannelData(n));
    for (let start = 0, number = 0; start < total; start += block, number++) {
      const count = Math.min(block, total - start), head = cat(new Uint8Array([255, 248, 112, (channels - 1) << 4 | 12]), utf(number), u16(count - 1));
      const a = new Uint8Array(head.length + 1 + channels * (1 + count * 3) + 2); a.set(head); a[head.length] = crc(head, 0, head.length, 8);
      let p = head.length + 1;
      for (let c = 0; c < channels; c++) {
        a[p++] = 2; // Verbatim FLAC subframe: decoded PCM, without another lossy encoding.
        for (let i = 0; i < count; i++) { const value = Math.max(-8388608, Math.min(8388607, Math.round(planes[c][start + i] * 8388608))); a[p++] = value >>> 16; a[p++] = value >>> 8; a[p++] = value; }
      }
      a.set(u16(crc(a, 0, p)), p); frames.push({data: a, samples: count});
    }
    return {rate, channels, bits, total, streaminfo: streamInfo(rate, channels, bits, total, block), frames};
  }
  function mp3Info(a) {
    let p = 0;
    if (String.fromCharCode(...a.subarray(0, 3)) === "ID3") { check(a.length >= 10 && ![6, 7, 8, 9].some(i => a[i] & 128), "Invalid MP3 ID3 header."); p = 10 + a[6] * 2097152 + a[7] * 16384 + a[8] * 128 + a[9]; if (a[5] & 16) p += 10; }
    check(p + 40 < a.length && a[p] === 255 && (a[p + 1] & 224) === 224, "Missing MP3 frame header.");
    const version = (a[p + 1] >>> 3) & 3, layer = (a[p + 1] >>> 1) & 3, index = (a[p + 2] >>> 2) & 3, mono = (a[p + 3] >>> 6) === 3;
    check(version !== 1 && layer === 1 && index !== 3, "Unsupported MP3 frame format.");
    const rate = [44100, 48000, 32000][index] / (version === 3 ? 1 : version === 2 ? 2 : 4), channels = mono ? 1 : 2;
    let x = p + 4 + (a[p + 1] & 1 ? 0 : 2) + (version === 3 ? mono ? 17 : 32 : mono ? 9 : 17);
    check(["Xing", "Info"].includes(String.fromCharCode(...a.subarray(x, x + 4))), "MP3 has no reliable gapless metadata; standard playback is used.");
    const flags = read32(a, x + 4); x += 8;
    check(flags & 1, "MP3 has no exact frame count."); const frames = read32(a, x); x += 4;
    if (flags & 2) x += 4; if (flags & 4) x += 100; if (flags & 8) x += 4;
    check(x + 24 <= a.length && /^(LAME|Lavc|Lavf)/.test(String.fromCharCode(...a.subarray(x, x + 9))), "MP3 encoder padding is unknown; standard playback is used.");
    const delay = a[x + 21] * 16 + (a[x + 22] >>> 4), padding = (a[x + 22] & 15) * 256 + a[x + 23];
    const total = frames * (version === 3 ? 1152 : 576) - delay - padding;
    check(total > 0 && total * channels * 4 <= 128 * 1024 ** 2, "MP3 decoding exceeds the trial memory limit.");
    return {rate, channels, total, delay, padding};
  }
  function init(info) {
    const {rate, channels, bits} = info, zeros = n => new Uint8Array(n), matrix = cat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));
    const entry = box("fLaC", zeros(6), u16(1), zeros(8), u16(channels), u16(bits), u16(0), u16(0), u32((rate <= 65535 ? rate : 0) * 65536), full("dfLa", 0, new Uint8Array([128, 0, 0, 34]), info.streaminfo));
    const stbl = box("stbl", full("stsd", 0, u32(1), entry), full("stts", 0, u32(0)), full("stsc", 0, u32(0)), full("stsz", 0, u32(0), u32(0)), full("stco", 0, u32(0)));
    const minf = box("minf", full("smhd", 0, zeros(4)), box("dinf", full("dref", 0, u32(1), full("url ", 1))), stbl);
    const mdia = box("mdia", full("mdhd", 0, u32(0), u32(0), u32(rate), u32(0), u16(0x55c4), u16(0)), full("hdlr", 0, u32(0), encoder.encode("soun"), zeros(12), encoder.encode("Tagcast gapless\0")), minf);
    const trak = box("trak", full("tkhd", 7, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0x100), u16(0), matrix, zeros(8)), mdia);
    const mvhd = full("mvhd", 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2));
    return cat(box("ftyp", encoder.encode("iso6"), u32(1), encoder.encode("iso6mp41dash")), box("moov", mvhd, trak, box("mvex", full("trex", 0, u32(1), u32(1), u32(0), u32(0), u32(0)))));
  }
  function pack(info) {
    const parts = []; let samples = 0, sequence = 1;
    for (let i = 0; i < info.frames.length; i += 16) {
      const frames = info.frames.slice(i, i + 16), base = samples;
      const entries = cat(...frames.map(f => cat(u32(f.samples), u32(f.data.length))));
      const fragment = offset => box("moof", full("mfhd", 0, u32(sequence)), box("traf", full("tfhd", 0x20000, u32(1)), full("tfdt", 0x1000000, u32(Math.floor(base / 2 ** 32)), u32(base)), full("trun", 0x301, u32(frames.length), u32(offset), entries)));
      const moof = fragment(0), data = cat(fragment(moof.length + 8), box("mdat", ...frames.map(f => f.data)));
      samples += frames.reduce((n, f) => n + f.samples, 0); parts.push({start: base / info.rate, end: samples / info.rate, data}); sequence++;
    }
    return {init: init(info), parts, duration: samples / info.rate, key: `${info.rate}/${info.channels}/${info.bits}`, samples, rate: info.rate, maxBlock: info.streaminfo[2] * 256 + info.streaminfo[3]};
  }
  return {parseFlac, pcmFlac, mp3Info, pack};
})();
if (typeof module !== "undefined") module.exports = gaplessMedia;

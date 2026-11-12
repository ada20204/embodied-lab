/* 最小的 MP4 封装：把 WebCodecs 编出来的 H.264 视频帧和 AAC 音频帧写成一个能直接播放的 .mp4。
 * 只支持这里用到的情形：一条视频轨（恒定帧率、没有 B 帧）+ 可选的一条音频轨；每条轨的数据连续放在 mdat 里。
 * 纯函数，浏览器和 node 都能用。 */
(function (root) {
  'use strict';
  const u8 = n => [n & 255], u16 = n => [(n >> 8) & 255, n & 255], u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const str = s => [...s].map(c => c.charCodeAt(0));
  const cat = parts => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  const box = (type, ...kids) => { const body = cat(kids.map(k => k instanceof Uint8Array ? k : Uint8Array.from(k))); return cat([Uint8Array.from(u32(body.length + 8)), Uint8Array.from(str(type)), body]); };
  const full = (type, ver, flags, ...kids) => box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...kids);
  const MATRIX = [].concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

  function esDescriptor(asc) {   // AAC 的 esds：三层描述符套在一起
    const d = (tag, body) => [tag, body.length].concat(body);
    const dsi = d(0x05, [...asc]);
    const dcd = d(0x04, [0x40, 0x15, 0, 0, 0].concat(u32(128000), u32(128000), dsi));
    return d(0x03, u16(1).concat([0], dcd, d(0x06, [2])));
  }

  /** tracks: [{ kind:'video'|'audio', timescale, sampleDur（每个样本的时长，单位 timescale）, samples:[{data:Uint8Array, key:boolean}],
   *             width, height, avcC（视频）, sampleRate, channels, asc（音频） }] */
  function build(tracks) {
    const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    let off = ftyp.length + 8;                                  // mdat 的数据从这里开始
    const data = [];
    for (const t of tracks) { t.offset = off; for (const s of t.samples) { data.push(s.data); off += s.data.length; } }
    const mdat = cat([Uint8Array.from(u32(off - ftyp.length)), Uint8Array.from(str('mdat')), ...data]);
    const MS = 1000, durMs = t => Math.round(t.samples.length * t.sampleDur * MS / t.timescale), total = Math.max(...tracks.map(durMs));
    const trak = (t, id) => {
      const v = t.kind === 'video', n = t.samples.length;
      const entry = v
        ? box('avc1', [0, 0, 0, 0, 0, 0], u16(1), u16(0), u16(0), u32(0), u32(0), u32(0), u16(t.width), u16(t.height), u32(0x480000), u32(0x480000), u32(0), u16(1), new Array(32).fill(0), u16(24), u16(0xffff), box('avcC', t.avcC))
        : box('mp4a', [0, 0, 0, 0, 0, 0], u16(1), u32(0), u32(0), u16(t.channels), u16(16), u16(0), u16(0), u32(t.sampleRate << 16 >>> 0), full('esds', 0, 0, esDescriptor(t.asc)));
      const keys = []; if (v) t.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
      const stbl = box('stbl',
        full('stsd', 0, 0, u32(1), entry),
        full('stts', 0, 0, u32(1), u32(n), u32(t.sampleDur)),
        ...(v ? [full('stss', 0, 0, u32(keys.length), ...keys.map(u32))] : []),
        full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
        full('stsz', 0, 0, u32(0), u32(n), ...t.samples.map(s => u32(s.data.length))),
        full('stco', 0, 0, u32(1), u32(t.offset)));
      const minf = box('minf', v ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
      const mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(n * t.sampleDur), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), str(v ? 'vide' : 'soun'), u32(0), u32(0), u32(0), str(v ? 'VideoHandler' : 'SoundHandler'), u8(0)), minf);
      return box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(durMs(t)), u32(0), u32(0), u16(0), u16(0), u16(v ? 0 : 0x100), u16(0), MATRIX, u32((t.width || 0) << 16), u32((t.height || 0) << 16)), mdia);
    };
    const moov = box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(MS), u32(total), u32(0x10000), u16(0x100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(tracks.length + 1)),
      ...tracks.map((t, i) => trak(t, i + 1)));
    return cat([ftyp, mdat, moov]);
  }
  const api = { build };
  root.Mp4 = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

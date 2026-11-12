// MP4 封装器：盒子大小自洽、样本偏移指对地方、关键帧表和样本数正确
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Mp4 = require('../studio/mp4.js');

const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const type = (b, i) => String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
function walk(b, from, to, out, path) {
  for (let i = from; i < to;) {
    const n = u32(b, i), t = type(b, i); assert.ok(n >= 8 && i + n <= to, `${path}/${t} 的大小越界`);
    out.push({ path: path + '/' + t, at: i, size: n });
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf'].includes(t)) walk(b, i + 8, i + n, out, path + '/' + t);
    i += n;
  }
  return out;
}
const fill = (n, v) => new Uint8Array(n).fill(v);
const video = () => ({ kind: 'video', timescale: 30, sampleDur: 1, width: 1280, height: 720, avcC: new Uint8Array([1, 100, 0, 40, 255, 225, 0, 0, 1, 0, 0]),
  samples: [{ data: fill(10, 1), key: true }, { data: fill(5, 2), key: false }, { data: fill(7, 3), key: true }] });
const audio = () => ({ kind: 'audio', timescale: 48000, sampleDur: 1024, sampleRate: 48000, channels: 1, asc: new Uint8Array([0x11, 0x88]), samples: [{ data: fill(6, 9) }, { data: fill(4, 8) }] });

test('盒子结构自洽：顶层是 ftyp / mdat / moov，所有盒子的大小加起来正好是文件长度', () => {
  const b = Mp4.build([video(), audio()]), boxes = walk(b, 0, b.length, [], '');
  assert.deepEqual(boxes.filter(x => x.path.split('/').length === 2).map(x => x.path), ['/ftyp', '/mdat', '/moov']);
  assert.equal(boxes.filter(x => x.path === '/moov/trak').length, 2);
  for (const need of ['stsd', 'stts', 'stsc', 'stsz', 'stco']) assert.equal(boxes.filter(x => x.path.endsWith('/stbl/' + need)).length, 2, need);
  assert.equal(boxes.filter(x => x.path.endsWith('/stbl/stss')).length, 1, '只有视频轨有关键帧表');
});

test('样本偏移和大小指向 mdat 里正确的字节；关键帧表是第 1、3 帧', () => {
  const b = Mp4.build([video(), audio()]), boxes = walk(b, 0, b.length, [], '');
  const co = boxes.filter(x => x.path.endsWith('/stco')).map(x => u32(b, x.at + 16)), sz = boxes.filter(x => x.path.endsWith('/stsz'));
  assert.equal(b[co[0]], 1); assert.equal(b[co[0] + 10], 2); assert.equal(b[co[0] + 15], 3);      // 视频三帧连续放
  assert.equal(co[1], co[0] + 22); assert.equal(b[co[1]], 9); assert.equal(b[co[1] + 6], 8);      // 音频紧跟其后
  assert.deepEqual([0, 1, 2].map(i => u32(b, sz[0].at + 20 + 4 * i)), [10, 5, 7]); assert.equal(u32(b, sz[0].at + 16), 3);
  const ss = boxes.find(x => x.path.endsWith('/stss')); assert.deepEqual([u32(b, ss.at + 12), u32(b, ss.at + 16), u32(b, ss.at + 20)], [2, 1, 3]);
  const mdat = boxes.find(x => x.path === '/mdat'); assert.equal(mdat.size, 8 + 22 + 10);
});

test('只有视频轨也能封；时长按帧数和帧率算', () => {
  const b = Mp4.build([video()]), boxes = walk(b, 0, b.length, [], '');
  assert.equal(boxes.filter(x => x.path === '/moov/trak').length, 1);
  const mvhd = boxes.find(x => x.path === '/moov/mvhd'); assert.equal(u32(b, mvhd.at + 20), 1000); assert.equal(u32(b, mvhd.at + 24), 100);   // 3 帧 / 30 fps = 100 ms
});

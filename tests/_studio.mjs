// 测试公用：读脚本、编译、排时间轴、提供小鸭子身体位置
import fs from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
export const R = req('../reel/reel.js'), A = req('../reel/arm.js'), K = req('../previz/kin.js'), G = req('../story/motion.js'), S = req('../studio/script.js');
const clips = {}, o = G.makeOut();
const clipOf = c => clips[c] || (clips[c] = G.fromJson(JSON.parse(fs.readFileSync(new URL(`../assets/duck/motions/${c}.json`, import.meta.url)))));
export const rootAt = (c, s) => { G.sample(clipOf(c), s, o); return o.pos.slice(); };
export const clipDur = Object.fromEntries(fs.readdirSync(new URL('../assets/duck/motions/', import.meta.url)).map(f => [f.slice(0, -5), G.duration(clipOf(f.slice(0, -5)))]));
export const scriptNames = fs.readdirSync(new URL('../studio/scripts/', import.meta.url)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
export const readScript = n => JSON.parse(fs.readFileSync(new URL(`../studio/scripts/${n}.json`, import.meta.url)));
export function load(n) {
  const sc = readScript(n), c = S.compile(sc, clipDur), tl = R.build(c.shots, c.bpm, { attack: c.attack });
  const plan = c.rig.arm ? A.plan(tl, rootAt, { base: c.rig.base, mount: c.rig.mount, lookUp: c.subject.lookUp, subjectR: c.subject.radius }) : null;
  return { sc, c, tl, plan };
}

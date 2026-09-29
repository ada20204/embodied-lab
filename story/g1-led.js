/* G1 头部指示灯：状态、颜色规则与"演示一轮对话"的序列。
 * 规则取自参考项目 g1-voice-interaction-pipeline 的源码：
 *   - 灯通过 Unitree AudioClient.LedControl(R, G, B) 控制，颜色是任意 RGB；
 *   - 追问窗口打开（正在聆听）→ 红色常亮（surf_voice_runtime._set_wake_light_red）；
 *   - 回复开始播放、回复播完、窗口超时收起 → 蓝色（unitree_audio_player / _set_wake_light_blue）；
 *   - 窗口因 new_wake / followup_asr_started 关闭时不改灯色；
 *   - 支持 "blink"：unitree_audio_player 每 0.5 秒刷新一次，前半秒亮、后半秒灭（约 1 Hz）。
 * 页面里的灯是模型上的示意，位置也是示意，不连接真机。
 */
(function (root) {
  'use strict';

  const STATES = {
    off: { label: '未接管', rgb: [0, 0, 0], effect: 'solid', why: 'LED 未被程序控制' },
    listen: { label: '聆听', rgb: [255, 0, 0], effect: 'solid', why: 'followup_window_open' },
    reply: { label: '回复 / 待机', rgb: [0, 0, 255], effect: 'solid', why: 'reply playback started -> blue' },
  };

  // 一轮对话里灯的变化（顺序和原因来自参考项目代码）
  const DEMO = [
    { state: 'off', dur: 1.6, text: '待机：灯没有被程序接管' },
    { state: 'listen', dur: 2.2, text: '唤醒后开始聆听：追问窗口打开 → 红', why: 'followup_window_open' },
    { state: 'listen', dur: 2.2, text: '识别与大模型回复：窗口因 followup_asr_started 关闭，灯色不变', why: 'followup_asr_started（不改灯）' },
    { state: 'reply', dur: 2.2, text: '回复开始播放 → 蓝', why: 'reply playback started -> blue' },
    { state: 'reply', dur: 1.6, text: '回复播完 → 蓝', why: 'reply playback finished -> blue' },
    { state: 'listen', dur: 2.2, text: '追问窗口再次打开 → 红', why: 'reply_play_finished → followup_window_open' },
    { state: 'reply', dur: 2.0, text: '超时收起 → 蓝', why: 'followup_window_closed:timeout' },
  ];

  /** 闪烁的亮灭：和参考项目一致，int(t*2) 为奇数时灭 */
  const levelAt = (effect, tSec) => (effect === 'blink' && (Math.floor(tSec * 2) % 2) ? 0 : 1);
  const call = rgb => `LedControl(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  const clamp255 = v => Math.max(0, Math.min(255, Math.round(+v || 0)));
  /** 演示序列在 t 秒时所处的步骤下标；超过总时长返回 -1 */
  function stepAt(t) { let a = 0; for (let i = 0; i < DEMO.length; i++) { a += DEMO[i].dur; if (t < a) return i; } return -1; }
  const demoLength = () => DEMO.reduce((s, d) => s + d.dur, 0);

  const api = { STATES, DEMO, levelAt, call, clamp255, stepAt, demoLength };
  root.G1Led = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

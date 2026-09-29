# Embodied Lab · 具身实验记录

一组具身智能实验的笔记和可交互工具：从拆解 Microduck 的强化学习训练栈，到研究 Pocket 3 当 AI 的身体，再到用越疆 Nova 挂 Pocket 3 做影视运动控制。

**在线访问**：仓库开启 GitHub Pages 后，主页在 `https://<用户名>.github.io/<仓库名>/`，作品集在 `/story/`，运镜预演台在 `/previz/`。

## 作品集（`/story/`）

滚动叙事页：固定的 3D 背景加章节卡片，一台宇树 G1 的数字模型当讲解员。内容是"端侧部署与验证"——把模型放到真实硬件上，量数值和延迟，再接到机器人上。

- 章节：开场 → 双臂与 ACT → G1 语音 → 端侧平台矩阵 → 副线（运镜预演台）。
- 每个结论旁标**证据类型**：真机、板测、仿真、示意、计划。平台矩阵里**没通过的案例也列出来**。
- 讲解员的手势是手工设定的示意姿态，不是宇树的真实动作轨迹；动作编号对应参考项目公开的动作白名单，白名单里没有的手势明确标"页面自定"。
- **可以互动**：拖动画布旋转视角（双击复位，触控板双指缩放）；点击或悬停任意部件会高亮并显示名称，点击 G1 或双臂的关节可以用滑块手动控制，限位来自模型的关节表；“灯光”面板可以调主光方向（俯视拨盘）、高度、强度、环境光、补光、轮廓光、高光和色温，也有几个预设。
- **G1 头部指示灯**：“指示灯”面板可以调 RGB、常亮/闪烁（约 1 Hz），也能“演示一轮对话”。颜色规则取自参考项目源码：`LedControl(R,G,B)`，追问窗口打开（聆听）为红，回复播放、播完、超时为蓝。模型上的灯带位置是示意，页面不连接真机。
- 渲染器 [`story/gl.js`](story/gl.js) 是自己写的 WebGL2（不依赖 Three.js），读 glb 并画带关节的层级模型。
- G1 模型来自 MuJoCo Menagerie（BSD-3-Clause，© Unitree Robotics），抽稀后放在 `assets/g1/`，许可见 [`assets/g1/NOTICE.md`](assets/g1/NOTICE.md)。
- 越疆双臂模型 `assets/nova/` 来源与许可待确认，**已加入 `.gitignore`，不随仓库发布**；缺少它时页面自动降级为文字。

## 运镜预演台

在浏览器里直接用的 Three.js 应用：在程序生成的产品影棚里，用镜头语法（环绕、推拉、揭示、俯拍）设计 Nova + Pocket 3 的运镜。

- 逐帧检查七项：不可达、干涉、超限位、超速、超加速、起停冲击、近奇异；显示最小间隙、腕部奇异余量和峰值速度。
- 整条路径比较多个逆解分支，选问题最少的构型。
- **自动修正**：在参数空间里找最接近原设计、全部通过检查的版本，必要时切换 Pocket 3 的挂法；全部通过时可以继续"优化余量"。
- **Pocket 3 模型**：按公开外形尺寸建模，云台可转动，屏幕显示实时画面；三种挂法（背夹正挂、背夹倒挂、底部安装）。
- **云台分担**：云台做"起始角 → 结束角"的平滑转动，机械臂负责剩下的部分。微俯环绕的手腕总行程从 461° 降到 42°。
- 导出 50 Hz 关节轨迹 CSV（6 轴 + 云台 2 轴）和镜头参数 JSON。

计算核心 [`previz/kin.js`](previz/kin.js) 不依赖任何库，浏览器和 Node 都能跑。

## 笔记

| | |
|---|---|
| [01 Microduck 的强化学习训练栈](notes/01-microduck-rl.md) | mjlab + PPO、执行器建模、奖励设计经验 |
| [02 Pocket 3 作为 AI 的身体](notes/02-pocket3-ai-body.md) | 程序化动画、蓝牙控制、实时性估算 |
| [03 机械臂怎么学技能](notes/03-arm-learning.md) | ACT / VLA / π / agentic / RL，Nova 接 LeRobot |
| [04 影视运动控制：系统架构](notes/04-motion-control.md) | 工作流、数字孪生、AI 摄影指导、MuJoCo |
| [05 运镜预演台开发记录](notes/05-previz-devlog.md) | v1 → v4 的问题、修复和数据 |
| [06 下一步](notes/06-roadmap.md) | 近期计划、双臂与 G1、作品集缺口 |

## 目录

```
index.html          项目主页（在页面里渲染 notes/ 下的笔记）
story/              作品集滚动叙事页（WebGL2 渲染器、G1 姿态与指示灯、页面）
assets/g1/          G1 抽稀网格与关节树（BSD-3-Clause）
previz/index.html   运镜预演台
previz/kin.js       运动学、碰撞、检查、自动修正、云台分配
notes/              笔记（Markdown，GitHub 上也能直接读）
tests/              计算核心的回归测试
.github/workflows/  测试通过后自动发布到 GitHub Pages
```

## 本地运行

主页用 `fetch` 读取笔记，需要通过本地服务器打开：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000/
node --test tests/kin.test.mjs   # 运行测试，需要 Node 18+
```

## 局限

这是**仿真预演**，还没有真机数据：

- Nova 用近似的 UR 型 DH 参数（臂展约 0.85 m），不是官方 URDF；
- Pocket 3 是按外形尺寸建的近似模型；云台限位和角速度是保守估计，未与 DJI 数据核对；
- 碰撞用胶囊体近似，留 2 cm 余量；
- 云台分担要求机械臂和云台同时起步，蓝牙延迟和重复精度还没实测。

## 说明

本项目与 Claude（Anthropic）协作完成。DJI、Osmo Pocket、越疆（Dobot）、宇树（Unitree）等名称归各自所有者，本项目与这些公司无关。

---

**English summary.** Notes and an in-browser motion-control previz tool for a Dobot Nova arm carrying a DJI Osmo Pocket 3. Design shots with a small shot grammar, check every frame (reach, collision, joint limits, velocity, acceleration, start/stop shock, singularity), auto-repair failing shots, and let the Pocket's gimbal share the rotation (wrist travel 461° → 42° on the sample orbit). Simulation only; parameters are approximate. Code is dependency-free JavaScript with Node regression tests; GitHub Actions deploys to Pages.

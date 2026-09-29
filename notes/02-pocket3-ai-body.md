# Pocket 3 作为 AI 的身体

目标：用 DJI Osmo Pocket 3 做一个 AI 的"身体"，让它看起来灵动、有生命力。

## 结论：这件事不需要强化学习

Microduck 用 RL 是因为走路是平衡难题。Pocket 3 的云台内部有大疆自己的闭环，我们只能发"转到哪个角度、多快"这类指令，没有需要学习的平衡问题。一个镜头显得有生命力，关键在动作设计，思路和皮克斯的台灯、Reachy Mini 一样：

- **待机呼吸**：低频噪声驱动微小晃动，永远不完全静止。
- **预备和过冲**：转头前先往反方向轻收一下，到位时稍冲过再回弹。
- **视线优先**：先快速"瞥"过去，身体再慢慢跟上。
- **情绪用参数表达**：好奇是歪头 + 慢速靠近，惊讶是快速后仰，犹豫是小幅左右摆。

架构：相机画面 → 视觉模型（人脸/物体跟踪）→ 大模型决定意图和情绪 → 动作层（程序化动画 + 视线跟踪）→ 云台指令。RL 可以作为后期手段，把"情绪指令"映射成更自然的轨迹。

## 怎么控制 Pocket 3

大疆的 Mobile SDK 不支持 Pocket 系列，只能用社区逆向的协议。

| 通道 | 用途 | 现状 |
|---|---|---|
| USB（UVC） | 视频输入 | 可以当网络摄像头用，延迟最低 |
| BLE（DUML 协议） | 云台控制、姿态遥测 | 遥测约 20 Hz；有项目报告只连 BLE 时电机指令被忽略，需要先建 WiFi |
| BLE → WiFi | 云台控制 + 实时画面 | OsmoDesk 这条路线已跑通 |

lib-osmo-ble 实现了五种云台指令：速度、绝对角度、**带时长的绝对角度**、增量移动、原始 PWM。两个坑：只有 `fff5`（writeWithoutResponse）会真正处理 DUML，写 `fff3` 不报错但被静默丢弃。

Pocket3-Controller 是一个 macOS 原生应用，自带 MCP 服务（抓帧、移动云台、停止云台等），AI 可以直接调用，最适合快速搭原型。

## 能做到多实时

没有人公开测过端到端延迟，以下是按协议推算的：

- BLE 连接间隔 15–50 ms，指令频率上限理论 20–60 Hz；
- 视觉闭环现实速率 10–30 Hz，从画面变化到云台开始动约 100–200 ms，接近人的眼神反应；
- 最大的变数是固件内部的平滑，可能会把预备、过冲这些细节削掉。原始 PWM 模式可能绕过一部分平滑，值得对比。

表情动作用"带时长的绝对角度"（发关键帧，由固件插值），持续跟随用速度指令，待机微动用低速速度指令叠加噪声。

**第一件事是实测**：发阶跃和正弦指令，同时记录 20 Hz 遥测，测出延迟、最大角速度和平滑程度。

## 3D 模型

MakerWorld 上 onzi.space 做的 Osmo Pocket 3 Replica 带 STEP 文件，屏幕、云台臂、摇杆都能活动，零件分开建模，最适合拆成仿真连杆。Sketchfab 有免费模型，适合看外观。

## 来源

- [yigitkonur/lib-osmo-ble](https://github.com/yigitkonur/lib-osmo-ble)
- [ElectronicPaper/OsmoDesk](https://github.com/ElectronicPaper/OsmoDesk)
- [YuhuanStudio/Pocket3-Controller](https://github.com/YuhuanStudio/Pocket3-Controller)
- [xaionaro/reverse-engineering-dji](https://github.com/xaionaro/reverse-engineering-dji)
- [Osmo Pocket 3 Replica · MakerWorld](https://makerworld.com/en/models/2435882-osmo-pocket-3-replica-fully-articulating-step)

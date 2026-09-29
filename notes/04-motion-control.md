# 影视运动控制：系统架构

目标：让 Nova 机械臂挂着 Pocket 3 做影视运动控制（motion control）。核心要求是**平滑、可重复、和相机同步**，这靠经典轨迹规划，不需要 ACT、VLA 或 RL。

## 要实现的功能

1. 关键帧路径：设几个机位，自动生成连贯运动。
2. 可重复：同一条轨迹跑很多遍，拍多条素材再合成。
3. 速度曲线：缓入缓出、变速。
4. Look-at：相机沿路径走时始终对准目标。
5. 同步触发：运动开始时触发录制，最好对齐时间码。

## 工作流

```
Blender（或预演台）设计镜头
   ↓ 导出每帧相机位姿
逆解到 6 轴（+ 云台 2 轴）+ 逐帧检查
   ↓ 关节轨迹
Blender 里回放复核
   ↓ 确认
重采样到伺服周期 → ServoJ 执行，同时触发 Pocket 录制
```

几个技术点：TCP 设在镜头光心（原地摇镜头才没视差）；限制加加速度才不会有顿挫；逆解必须从上一帧出发，避免构型跳变；预演阶段就要检查奇异点；ServoJ 周期要稳定，放独立线程。

## 数字孪生

一个独立的桥接进程读 30004 反馈和 Pocket 的 UVC 画面，通过本地 socket 发给 Blender 插件。Blender 用定时回调更新模型关节，用 `gpu` 模块把实拍画面叠在虚拟相机视图上。桌角和物体轮廓对得上，就说明相机参数、TCP 偏移、场景摆放都标定准了。

## Agentic：Claude 当摄影指导

不让大模型直接输出坐标，而是给它一套**镜头语法**（环绕、推拉、揭示、视差平移、俯拍 + 时长、缓动、焦距、构图），由确定性的编译器转成轨迹。工具通过 MCP 暴露：

```
感知  scene_query / capture_frame
设计  create_shot / edit_shot
检查  validate_shot / render_preview
执行  request_execution（必须经人确认）
回看  review_take
```

安全边界写死在桥接进程里：速度上限、工作空间、急停；没通过检查的镜头直接拒绝执行。认可的镜头存成模板，积累成自己的镜头库。

## 计算核心往哪放

| 选项 | 适合 |
|---|---|
| 网页（Three.js + 手写运动学） | 快速试镜头、手机查看、分享。已经做了，见[运镜预演台](../previz/) |
| Blender 插件 | 正式预演、布景、渲染、接真机、后期合成 |
| MuJoCo + mink | 计算引擎：真实网格碰撞、带约束的 QP 逆解（碰撞避让写成约束）、9 轴协同、动力学验证、GPU 批量试算 |

MuJoCo 没有时间线和曲线编辑，画质也只够检查构图，所以只做后端。计划的分工：Blender 设计和出片，MuJoCo + mink 算，网页做轻量预览，三者共用同一份 CSV/JSON。

## Nova 的 MuJoCo 模型

Nova 不在 MuJoCo Menagerie 里。可用的：`teras-project/hakoniwa-robot-arm`（首个适配 Nova5，MJCF 由工具链生成）；或者用官方 `dobot_description` 里的 URDF 自己转 MJCF，补执行器和 scene.xml。影视运镜主要用运动学，URDF 的连杆尺寸和关节限位准确就够了。

## 来源

- [teras-project/hakoniwa-robot-arm](https://github.com/teras-project/hakoniwa-robot-arm)
- [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie)
- [Dobot-Arm/TCP-IP-ROS-6AXis](https://github.com/Dobot-Arm/TCP-IP-ROS-6AXis)

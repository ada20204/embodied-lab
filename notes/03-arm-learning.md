# 机械臂怎么学技能：路线对比与 Nova 接入

## 五个概念不在同一层

- **agentic** 是系统架构：任务怎么拆、调用什么能力。
- **ACT、VLA、π** 是策略模型：把画面（和指令）翻译成电机动作。
- **强化学习** 是训练方法：可以用来训练上面任何一种策略。

| | 是什么 | 数据需求 | 适合 |
|---|---|---|---|
| ACT | 单任务模仿学习，按动作块预测 | 几十条遥操作示范 | 一台机器人做一件固定的事 |
| VLA | 视觉语言大模型 + 动作输出头 | 大规模跨机器人预训练 + 少量微调 | 听懂人话、泛化到新物体 |
| π 系列 | Physical Intelligence 的 VLA，flow matching 出动作 | 同 VLA | 通用操作。π0.7（2026.4）有组合泛化，能用语言现场指导 |
| agentic | 大模型规划、调用技能、检查结果 | 基本不需要机器人数据 | 长流程、需要推理的任务 |
| RL | 试错 + 奖励优化 | 仿真或真机交互 | 精修精度、速度、成功率 |

现在的主流用法：模仿学习打底，RL 在真机上精修（π 在 2026.3 发了从 VLA 里提取 RL token 做快速在线 RL 的方法）。

建议路线：ACT 跑通"遥操作采集 → 训练 → 部署" → 微调 SmolVLA 或 π0 听懂语言 → 上面加 agentic 层 → 需要更高成功率时再上 RL。

## 越疆 Nova 的控制接口

- TCP/IP 远程控制，官方 SDK 支持 Python、C++、ROS 等。
- **29999 端口**下发指令，只允许一个客户端，要求控制器处于 TCP 模式。
- **30004 端口**推送反馈，可多客户端，无模式限制。
- **ServoJ**：连续流式下发关节目标，学习型策略的输出必须走这条路。MovJ 会阻塞并重新规划加减速，和策略 20–30 ms 一次的更新节奏冲突。
- 官方 ROS2 包带 nova2/nova5 的 MoveIt 配置、URDF 和 Gazebo 仿真。
- 注意固件版本：V4 版 Python SDK 支持 NovaLite 等 V4 机型，初代 Nova 在官方仓库里归在 V3。

## LeRobot 与越疆 SDK 的关系

| | LeRobot | 越疆 SDK |
|---|---|---|
| 定位 | 机器人**学习**框架 | 机器人**控制**库 |
| 解决 | 采数据、训模型、跑策略 | 让这台机械臂动起来 |
| 数据 | LeRobotDataset（MP4 + Parquet），可上传 HF Hub | 没有 |
| 安全 | 基本靠自己 | 碰撞检测、报警、使能管理在控制器里 |

上下层关系：LeRobot 决定做什么动作，越疆 SDK 执行动作。接入只需要写一个 Robot 子类：

```python
class DobotNova(Robot):
    def connect(self):
        self.arm = DobotRobot(ip)                    # 越疆 SDK
        self.arm.robot_control.EnableRobot()
    def get_observation(self):
        return {**读30004口关节角(), "cam_wrist": 相机画面}
    def send_action(self, action):
        action = 限幅(action)                        # 每步变化量 + 工作空间
        ServoJ(action的6个关节角)                    # 流式伺服，不用 MovJ
        夹爪(action["gripper"])
        return action
```

还需要补：遥操作方案（推荐 GELLO 式小主臂）、夹爪、以及上真机前的低速和工作空间限位。

## 来源

- [Physical Intelligence Blog](https://www.pi.website/blog)
- [LeRobot Robots API](https://huggingface.co/docs/lerobot/main/api/robots)
- [Dobot-Arm/TCP-IP-Python-V4](https://github.com/Dobot-Arm/TCP-IP-Python-V4)
- [Dobot-Arm/DOBOT_6Axis_ROS2_V4](https://github.com/Dobot-Arm/DOBOT_6Axis_ROS2_V4)
- [Dobot-Arm/TCP-IP-ROS-6AXis](https://github.com/Dobot-Arm/TCP-IP-ROS-6AXis)

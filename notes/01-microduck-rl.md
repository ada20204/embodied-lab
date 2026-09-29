# Microduck 的强化学习训练栈

Microduck 是 Hugging Face 与 Pollen Robotics 在 2026 年 8 月发布的开源双足机器鸭：25 cm 高、不到 800 g，15 个电机，带摄像头、深度传感器、两个 IMU 和能夹东西的鸭嘴，定价 399 美元。它的 RL 训练代码在 `pollen-robotics/microduck_rl`，是一份很完整的小型双足 sim2real 教材。

## 训练栈

| 部分 | 做法 |
|---|---|
| 仿真 | mjlab（MuJoCo Warp，GPU 并行），默认 4096 个环境 |
| 算法 | PPO（rsl_rl），策略 50 Hz |
| 产物 | 导出 ONNX，观测归一化器烘焙进图里；机器人运行时加载 |
| 时间 | 单卡约 1–2 小时出可用步态；简单特技约 1000 次迭代，步态和恢复 4000–6000 次 |
| 无显卡 | 训练命令加 `--hf-jobs` 放到 Hugging Face Jobs |

任务包括走路（速度跟踪 + 头部姿态）、摔倒恢复、站起、坐站切换、低头捡东西、踢球、前滚翻，以及一整套轮滑任务。每个主任务还有一个 **Backlash 变体**：每个舵机串联 ±1° 齿隙，编码器读的是齿隙输出端，和真机一致。

## 两个关键设计

**统一的 61 维观测**：48 维本体感知 + 13 维指令块（速度 3、头部姿态 4、身体姿态 6）。所有策略共用这个接口，运行时可以在走路、恢复、特技之间热切换。某个任务用不到的指令槽填 0，但不能删。

**执行器建模是 sim2real 的主体**：小舵机驱动 800 g 的机器人，仿真和真机的差距大部分来自执行器。所以用 Rhoban 的 BAM 模型把 XL330 建到电压控制律（反电动势、库仑/Stribeck/随负载摩擦），再对电池电压、电压跌落、指令延迟、摩擦做域随机化。

## 奖励设计经验（AGENTS.md 里总结的）

- RL 按奖励的字面意思优化。没约束的自由度都会被钻空子，要用硬性状态门控定义"什么才算完成"，不要靠小惩罚项去劝。
- 不设"头奖"：到达某状态就每步给奖励，策略会不计代价抢先冲过去。对指令过渡要跟踪一个限速的内部目标。
- 不在坏状态下给正奖励，否则策略会停在最便宜的姿势刷分；用基于势函数的 shaping，只奖励进步量。
- 惩罚项符号要统一检查：wandb 里每个惩罚项的值必须 ≤ 0。
- 正则项分两类：阻碍动作的（角速度惩罚）在动态任务里压低；抑制抖动的（action_rate）等技能学出来再逐步加。
- 全零指令（待机）和原地转圈这类少见指令要单独采样，否则永远学不会。
- 训练前先跑 64 环境 × 5 次迭代的冒烟测试，几乎不花钱，能抓出大部分配置错误。

## 能不能拿来训机械臂

仓库本身不行（观测、关节布局、执行器参数、奖励都是为鸭子写的），但 mjlab + PPO 框架、BAM 执行器辨识、域随机化和奖励设计原则都能复用。机械臂的难点在感知和接触：抓取通常先用仿真真值训练 teacher 再蒸馏成视觉 student，或者直接走遥操作 + 模仿学习。

宇树官方的 `unitree_rl_mjlab` 也基于同一套 mjlab，所以这些经验可以直接迁移到 G1 的运动控制上。

## 来源

- [Meet Microduck · Pollen Robotics](https://pollen-robotics.com/microduck/blog/introducing-microduck/)
- [pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl)
- [microduck_rl AGENTS.md](https://github.com/pollen-robotics/microduck_rl/blob/develop/AGENTS.md)
- [unitreerobotics/unitree_rl_mjlab](https://github.com/unitreerobotics/unitree_rl_mjlab)

# Microduck 模型来源与许可

`duck.glb` / `duck.json` 由 Pollen Robotics 的 [microduck_rl](https://github.com/pollen-robotics/microduck_rl)（提交 `cb70b79`）转换而来。

## 许可：两部分，不一样

- **3D 网格（`duck.glb`）：CC BY-NC-SA**。上游 README 写明"3D model files are licensed under Creative Commons BY-SA-NC"（未标版本号；按常规写法应为 CC BY-NC-SA）。这意味着：要署名、**只能非商业使用**、改编后要用同样的许可分享。`duck.glb` 是原 STL 的抽稀改编版，因此**同样按 CC BY-NC-SA 提供**。
- **关节层级、轴、限位（`duck.json`）**：来自 `robot_walk.xml`，属于项目代码，Apache-2.0，许可全文见同目录 `LICENSE`。

- **动作片段（`motions/*.json`）**：我在 MuJoCo（WASM）里运行 Pollen Robotics 公开的策略权重（Hugging Face `pollen-robotics/microduck-policies`，页面标注 apache-2.0）、用官方沙盒的 MJCF 和 BAM 执行器模型录下的关节轨迹（50 FPS）。它们是仿真数据，不是真机数据；物理模型用到了上面 CC BY-NC-SA 的碰撞网格，所以**同样只能非商业使用**。我这边的仿真里速度指令的跟踪比预期弱（前进指令 0.25 m/s，实际约 0.1 m/s；原地转圈几乎不转，所以没有收录），原因没查清，不要把它当作策略的真实性能。

## 做过的修改

- 取走路版 `src/mjlab_microduck/robot/microduck/robot_walk.xml` 的可视网格（38 个 STL，约 43 万三角面），用顶点聚类抽稀到约 17%（约 7.3 万三角面，1.7 MB；薄壳零件多留了一些面，避免内外表面被合并）；
- 关节层级、轴、限位按 `robot_walk.xml` 原样保留（14 个关节）；材质颜色取自其中的 `<material>`；
- 格式转换为 glb。抽稀会让部件轮廓略微变小，不适合做碰撞或精确尺寸计算。

## 使用提醒

这个模型只能用于非商业目的。如果你要把这个仓库用在商业场合，请换掉 `duck.glb`，或先向 Pollen Robotics 确认。

Microduck 是 Pollen Robotics / Hugging Face 的产品，与本页无关联。

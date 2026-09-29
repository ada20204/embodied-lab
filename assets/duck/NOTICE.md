# Microduck 模型来源与许可

`duck.glb` / `duck.json` 由 Pollen Robotics 的 [microduck_rl](https://github.com/pollen-robotics/microduck_rl)（提交 `cb70b79`）转换而来：

- 取走路版 `src/mjlab_microduck/robot/microduck/robot_walk.xml` 的可视网格（38 个 STL，约 43 万三角面），用顶点聚类抽稀到约 17%（约 7.3 万三角面，1.7 MB；薄壳零件多留了一些面，避免内外表面被合并）；
- 关节层级、轴、限位按 `robot_walk.xml` 原样保留（14 个关节）；
- 材质颜色取自 `robot_walk.xml` 的 `<material>`；
- 原项目版权归 Pollen Robotics，Apache License 2.0，许可全文见同目录 `LICENSE`。

本目录的文件相对原文件做过修改（格式转换和网格抽稀）。抽稀会让部件轮廓略微变小，不适合做碰撞或精确尺寸计算。

Microduck 是 Pollen Robotics / Hugging Face 的产品，与本页无关联。

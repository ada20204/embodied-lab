# G1 模型来源与许可

`g1.glb` / `g1.json` 由 [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie) 的 `unitree_g1`（29 自由度 rev 1.0）转换而来：

- 只取可视网格，用顶点聚类抽稀到约 12% 的三角面（51 个 STL 共 35 MB → 约 1 MB）；
- 关节层级、轴、限位按 `g1.xml` 原样保留；
- 原模型版权归 Unitree Robotics，BSD-3-Clause，许可全文见同目录 `LICENSE`。

抽稀会让部件轮廓略微变小（最大约 7 mm），不适合做碰撞或精确尺寸计算。

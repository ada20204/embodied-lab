# G1 模型来源与许可

`g1.glb` / `g1.json` 由 [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie) 的 `unitree_g1`（29 自由度 rev 1.0）转换而来：

- 只取可视网格（35 个），用 meshoptimizer 的二次误差简化生成两档：`g1.glb` 约 26% 三角面（约 10 万，2.0 MB），`g1_lo.glb` 约 4%（首屏用，约 0.45 MB）；法线按 40° 折角分裂，以 int8 存储；生成脚本 `tools/build_meshes.py`；
- 关节层级、轴、限位按 `g1.xml` 原样保留；
- 原模型版权归 Unitree Robotics，BSD-3-Clause，许可全文见同目录 `LICENSE`。

简化后的网格只用于展示，不适合做碰撞或精确尺寸计算。

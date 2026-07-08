使SSM能够区分并保留相关信息，同时过滤掉无关信息。假设系统输入为 $u(t) \in \mathbb{R}$，中间状态为 $x(t) \in \mathbb{R}^N$，输出为 $y(t) \in \mathbb{R}$，则选择性状态空间模型（Selective State Space Model）的方程如下：

```math
\begin{cases}
x'(t) = A x(t) + B u(t) \\
y(t) = C x(t) + D u(t)
\end{cases} \tag{3}


其中 `$A \in \mathbb{R}^{N \times N}$` 表示状态矩阵，`$B \in \mathbb{R}^{N \times 1}$`，`$C \in \mathbb{R}^{1 \times N}$` 为投影参数，`$D \in \mathbb{R}$`。

为了使SSM适用于深度学习场景，采用零阶保持（Zero-Order Hold, ZOH）对SSM进行离散化，定义如下：


```math
```math
\begin{cases}
\overline{A} = \exp(\Delta A) \\
\overline{B} = (\Delta A)^{-1} (\exp(\Delta A) - I) \cdot \Delta B
\end{cases} \tag{4}


其中 `$\Delta$` 是一个可学习参数，称为步长。随后可得到新的方程（式5）：


```math
```math
\begin{cases}
x_k = \overline{A} x_{k-1} + \overline{B} u_k \\
y_k = C x_k + D u_k
\end{cases} \tag{5}


### 3.4.2 全向视觉状态空间模块（Omni-directional Visual State Space Module）

由于视觉数据的非因果性，直接将图像分块并输入SSM会面临方向敏感性问题。不同的扫描策略[21][23][25]缓解了这一问题。Vision Mamba[21]执行正向和反向扫描，VMamba[23]分别沿水平和垂直方向执行正向和反向扫描，RSMamba[25]在正向和反向扫描之外引入了随机扫描。由于猕猴的活动和运动范围多样，其姿态和动作在不同角度和方向上可能各不相同，导致猕猴图像的空间特征分布更加多样化。为此，我们使用全向选择性扫描模块（Omni-directional Selective Scanning Module, OSSM）分别在水平、垂直、对角线和反对角线方向上进行双向扫描，从而增强模型在多个方向上的特征提取能力。

VSSBlock的结构如图3所示：首先，输入数据经过层归一化（layer normalization）后分为两个分支。第一

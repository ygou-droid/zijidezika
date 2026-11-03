---
name: settings-card-glass-unify
overview: 让设置面板卡片（.settings-card）与其他三个主面板使用完全一致的深色毛玻璃：同基色 rgba(20,25,35,var(--panel-bg-alpha))、同常驻 blur(20px) saturate(1.2)、同高光边框与阴影，并修复因祖先 .settings-panel 自带 backdrop-filter 导致卡片磨砂失效、底色显得更黑的问题。
todos:
  - id: dedupe-settings-card
    content: 重构 style.css 中 .settings-card 为纯布局规则，删除重复的 background/border/shadow/backdrop-filter
    status: completed
  - id: fix-panel-backdrop
    content: 移除 .settings-panel 的 backdrop-filter，并把遮罩调整为先 rgba(8,6,16,0.18) 左右的浅压暗
    status: completed
    dependencies:
      - dedupe-settings-card
  - id: verify-visual
    content: 使用 [skill:playwright-cli] 截图对比设置面板与聊天面板，确认磨砂与底色一致后收尾
    status: completed
    dependencies:
      - fix-panel-backdrop
---

## 用户要求

设置面板（居中的 `.settings-card`）与其他面板（聊天 / 联系人 / 字卡）观感不一致：底色更黑、看不到毛玻璃磨砂。需要让它与其他面板完全一致。

补充反馈：去重 + 移除父级 `backdrop-filter` 后，仍有「一定黑」，只是不明显 —— 需要把残留的黑也去掉。

## 现状与根因

- 根因一（已修）：父层 `.settings-panel` 自带 `backdrop-filter: blur(2px)`，建立 backdrop root，令 `.settings-card` 的 `blur(20px)` 采不到桌面 → 磨砂失效。
- 根因二（已修）：`.settings-card` 在 937 行还留有一份旧的 `rgba(38,32,54,0.82)` / `blur(24px)` 玻璃声明，靠书写顺序被 2105 分组规则覆盖，属于重复声明。
- 根因三（本次要修）：`.settings-panel` 的全屏压暗 `rgba(8,6,16,0.18)` 是**整屏均匀**的。卡片底色 `rgba(20,25,35,var(--panel-bg-alpha))` 是半透明的，这 18% 黑会透过卡片渗上来；而聊天/联系人/字卡直接压在壁纸上，没有这层，所以设置卡片总比它们深一点 —— 面板透明度越高越不明显，越低越明显。

## 期望结果

- 设置卡片所在区域背后**零额外压暗**，与其他三个面板采样到完全相同的背景（壁纸 + `#spaceVeil`）。
- 卡片底色 / 边框 `rgba(255,255,255,0.15)` / 阴影 / `blur(20px) saturate(1.2)` 与另外三个面板完全一致，跟随 `--panel-bg-alpha` 实时变化。
- 保留「弹窗聚焦感」：压暗只留在卡片四周，卡片本身不被染色。
- 尺寸 `min(440px, 92vw)`、`max-height: min(760px, 86vh)`、内部滚动、`cardPopIn` 动画不变。

## 技术方案

纯 CSS，只改 `style.css`。

1. **遮罩改为「中心透明 + 四周压暗」的径向渐变**，替掉整屏均匀的 0.18：

```css
.settings-panel {
/* 卡片区域完全不压暗，只在四周收边；这样卡片背后就是纯壁纸，与其他面板同源 */
background: radial-gradient(120% 120% at 50% 50%,
rgba(8, 6, 16, 0) 0%,
rgba(8, 6, 16, 0) 42%,
rgba(8, 6, 16, 0.30) 100%);
}
```

120% 半径下 42% 停靠点 ≈ 0.5 屏半高，可完整覆盖最高的卡片（760px @ 900 高屏），保证卡片四角也在透明区内。

2. `.settings-panel` 继续**不写** `backdrop-filter`（backdrop root 会毁掉卡片磨砂）。
3. `.settings-card` 保持纯布局（939 行），玻璃观感只由 2105 分组规则提供，不新增第二处声明。

## 关键取舍

- 遮罩的聚焦作用从「整屏压暗」变成「四周渐暗」，观感上弹窗依然突出，但卡片背后不再叠黑 —— 这是让两者绝对同色的唯一办法。
- 若用户觉得四周压暗不够，只调最后一个 `0.30`，不影响卡片颜色。

## 验证方式

- 按用户要求**不下载浏览器、不截图**：静态检查 `style.css` 花括号配平、`.settings-card` 玻璃声明仍只有一处、`.settings-panel` 无 `backdrop-filter`。
- 由用户在 `http://127.0.0.1:3000/` 自行目视确认。
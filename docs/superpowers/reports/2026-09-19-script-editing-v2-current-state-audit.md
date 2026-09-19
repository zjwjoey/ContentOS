# ContentOS Script Editing V2 当前状态审计

## 基线

- 分支：`codex/script-editing-v2-rule-editorial-layer`
- 来源分支：`codex/hybrid-media-script-editing-v1`
- Base SHA：`f318da93be6724fed87822c1ce9de5fe19ffb4a8`
- `origin/main`：`42c9b2f1eb80fddf63bef67dd8932ec448cabcd9`
- 当前差异：相对 main ahead 48、behind 0；本地 `local-media/` 为未跟踪目录，不纳入提交。

## 当前能力

V1 与 MIX 兼容链路保持稳定；V2 已具备确定性的 EditorialPlan/ResolvedEditorialPlan、规则规划、1–3 镜头场景、精确语音时长守恒、字幕/Hero Text、BGM/ducking、片头片尾、锁定/换片、revision、durable job、历史与复制。素材按路径去重，外部素材带来源与缩略图，输出根目录做授权校验并以确定性文件名原子落盘。

## 收口核验

- Final implementation SHA：`942730e`；本地分支相对远端推送前为 ahead 1，推送后应为 0/0。
- `pnpm typecheck`、`pnpm lint`、`pnpm format`、`pnpm build`、`pnpm --dir apps/web build` 全部通过。
- `pnpm test` 271/271；V1 27/27；V1.5 19/19；V2 9/9；migration 9/9；browser 4/4；FFmpeg 十组合矩阵 10/10。
- `pnpm doctor` 通过，仅保留全局 pnpm bin 未加入 PATH 的既有警告；`local-media/` 仍为本地未跟踪素材目录，不纳入提交。

## GO/NO-GO

GO / READY FOR REVIEW：V2 P0/P1 收口完成，完整隔离数据库门禁、浏览器验收、输出文件与外部缩略图交付均已验证。Logo overlay 仍是可选 P2，不阻塞当前发布。

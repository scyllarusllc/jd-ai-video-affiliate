# 轻量流程

自己运营时不依赖 `desktop/` 桌面软件：商品资料用 Markdown 管理，账号用独立 Chrome 配置隔离，由 Claude Code 按 `.claude/skills/jd-video/SKILL.md` 执行操作。

## 准备

1. 在 `accounts.conf` 中列出账号名和平台。
2. 对每个账号执行 `workflow/bin/jd-account open <name>`，在打开的 Chrome 中自行登录，并安装 Claude in Chrome 扩展（每个配置需单独安装一次）。

账号的 Chrome 配置保存在 `~/.local/share/jd-affiliate/chrome/<name>/`，不进入仓库。

## 处理一个商品

在项目根目录启动 Claude Code，说明要做的商品即可，例如「用 jd-video 流程做这个商品：<链接>」。也可以手动执行：

```bash
workflow/bin/jd-new storage-basket 100312007386 https://item.jd.com/100312007386.html "日式大号收纳篮"
workflow/bin/jd-account open doubao-1
workflow/bin/jd-check products/storage-basket/v1.mp4
workflow/bin/jd-stats
```

每个商品的进度、实验记录和发布草稿都在 `products/<slug>/商品.md`。流程和规则见 [SKILL.md](../.claude/skills/jd-video/SKILL.md)，制作方法见 [视频提示词与制作策略](../docs/video-prompt-strategy.md)。

`jd-check` 只检查格式、分辨率、时长和音轨，商品是否匹配、完整播放和听检仍需人工完成。最终发布由你在京东后台亲自提交。

发布后，把播放、点击、订单和预估佣金按日期追加到商品的「发布后数据」表（累计值），`jd-stats` 会汇总所有商品，用来判断平台是否给 AI 视频流量。建议先发 10–20 条，再决定是否扩大规模。

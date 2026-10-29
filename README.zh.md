# dsh-session-cleaner（会话清理器）

[English](README.md) | 中文

**Session Cleaner** 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件（bundle），为 Web 界面补上缺失的破坏性会话操作，直接集成在会话列表和聊天界面中：

- **删除整个会话** —— 侧边栏会话行的"…"菜单，或聊天界面会话标题栏的垃圾桶按钮。该会话的全部历史记录将被永久删除。
- **从任意消息处截断** —— 每条已完成的助手消息都会出现"从此处删除…"操作。之前的内容会 fork 到一个同名延续会话中，原会话随后被删除，所选消息及其后的内容全部消失。

两种操作在真正删除前都会弹窗确认。

## 工作原理

DeepSeek Harness 的会话日志在设计上是只追加（append-only）的，官方没有提供删除会话的服务。本插件只使用正规扩展点实现：

1. `workspaceRegistry.archiveSession(id, { stopActivity: true })` 通过已组合的活动提供者停止正在运行的轮次、子代理、后台任务和定时提醒，并隐藏该会话。
2. 删除 JSONL 持久化根目录（`<dsh-home>/sessions/<项目目录>/<session-id>/`）下该会话自己的日志目录——删除前会严格校验目录内确实存在会话日志——同时删除其投影缓存记录。
3. `workspaceRegistry.unarchiveSession(id)` 清掉归档标记，不残留过期 id。工作区注册表在读取时会过滤没有日志的会话 id，会话因此从所有界面消失。
4. "从此处删除"先用 `ctx.sessions.fork({ atSeq })`（`increaseTitle: false`）把所选消息之前的内容 fork 成同名延续会话，再删除原会话。

Client 半通过同源 POST 调用 `/session-cleaner/api/*` 访问 Host 半，与所有受信任浏览器端一样经由 `ctx.connection.requestRejection()` 鉴权。

## 安装

dsh CLI：

```bash
dsh --profile <你的-profile> plugin install git+https://github.com/<owner>/dsh-session-cleaner.git
```

或在 Web 界面：**插件 → 安装 → Git**，填入仓库地址。本地检出的目录可直接传给 `plugin_manager` 的 `install_bundle`。

### 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `root` | `dshHomePath('sessions')` | 本插件执行删除的 JSONL 会话持久化根目录。若你修改过 `dsh-session-persistence-jsonl` 的 `root`，请同步修改此配置。 |

## 安全性

- 有任务正在运行的会话会先通过工作区活动提供者停止（而非静默杀掉），然后再删除。
- 目录内没有可识别的 `session*.jsonl*` 日志文件时，绝不删除。
- 会话 id 会先校验为 UUID，仅用于在配置的根目录下*查找*目录；id 内容永远不会被当作路径前缀使用。
- 删除是永久的，除你自己的备份外没有撤销手段。

## 已知限制

- 侧边栏列表从 Host 工作区状态刷新；如删除后行仍残留，刷新一次页面即可。
- 从助手回复处删除时会保留该回复对应的*用户提问*（它会成为延续会话的结尾）；如需一并删除，请从用户消息后的下一条助手消息处删除。
- "从此处删除"会改变会话 id（它是前缀的 fork）。

## 许可证

[MIT](LICENSE)

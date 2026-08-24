# Flow Codeblock MCP Plugin

Flow Codeblock 的公开 MCP 插件包。它只包含本地 MCP 适配器、Codex Skill 和接口规则，不包含 Flow-codeblock Rust 服务、数据库或 Bun 执行器源码。

## 服务地址

默认服务地址为：

```text
http://103.40.14.90:53002
```

也可以通过 `FLOW_CODEBLOCK_BASE_URL` 覆盖。生产环境建议将服务放在 HTTPS 域名后面；当前 HTTP 地址不适合在公网传输真实 Token。

## 快速安装 MCP Server

客户端需要安装 Bun 1.4.0 或更高版本，然后使用 npm 包启动本地 stdio MCP Server：

```bash
bunx --bun flow-codeblock-mcp@0.1.1
```

配置环境变量：

```bash
export FLOW_CODEBLOCK_BASE_URL=http://103.40.14.90:53002
export FLOW_CODEBLOCK_TOKEN='flow_xxx'
```

每个用户都应使用管理员单独创建的 Token。不要把真实 Token 提交到仓库或写进公共配置。

## 客户端配置

支持本地 stdio MCP 的客户端可以使用：

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-mcp@0.1.1"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "http://103.40.14.90:53002",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

Cursor、KimiCode、WorkBuddy 等客户端的配置字段名称可能略有不同，但都需要同一个 stdio 命令、参数和两个环境变量。仅支持远程 Streamable HTTP 的客户端不适用于当前第一版。

## Codex Plugin

仓库根目录包含：

```text
.codex-plugin/plugin.json
.mcp.json
skills/flow-codeblock/
```

在 Codex 中导入此插件目录后，Codex 会加载 `flow-codeblock` Skill，并通过 `.mcp.json` 使用 npm MCP Server。Skill 要求脚本发布前先预览和确认，并单独生成 `script-interface-doc.v1` JSON；MCP 不提供删除脚本工具。

## MCP 工具

工具覆盖 Token 信息、脚本查询、接口文档、预览、发布、执行、统计、锁定、解锁和所有权转移。服务端继续负责认证、配额、限流、危险模式、模块白名单、审计和 Web worker lane 路由。

## 许可证

MIT

# flow-codeblock-mcp

Flow Codeblock 的本地 stdio MCP Server。它只调用 Flow Codeblock Rust REST API，不在用户电脑执行脚本；用户 JavaScript 仍由服务端 Bun Supervisor 执行。

## 安装

客户端可以直接通过 Bun 从 npm 下载固定版本：

```bash
bunx --bun flow-codeblock-mcp@0.1.0
```

需要 Bun 1.4.0 或更高版本。

## 环境变量

```bash
export FLOW_CODEBLOCK_BASE_URL=http://103.40.14.90:53002
export FLOW_CODEBLOCK_TOKEN='flow_xxx'
```

`FLOW_CODEBLOCK_TOKEN` 必须是管理员为当前用户创建的独立 Token。不要把真实 Token 写入公开仓库、npm 包或提交到客户端配置文件。

生产环境建议将 `FLOW_CODEBLOCK_BASE_URL` 替换为 HTTPS 域名。该地址是 Rust 服务的 REST API 地址，不是 MCP 或 Streamable HTTP 地址。

## 通用 stdio 配置

支持本地 stdio MCP 的客户端可以使用以下配置：

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-mcp@0.1.0"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "http://103.40.14.90:53002",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

如果客户端提供环境变量或密钥管理功能，应使用该功能保存 Token。MCP Server 不要求把 Token 放入工具参数。

## Codex Plugin

仓库根目录同时包含 Codex Plugin 和 `flow-codeblock` Skill。安装插件后，Codex 会自动加载 Skill，并通过 `.mcp.json` 启动本 npm MCP 包。

Skill 会指导模型先预览再发布脚本和独立接口文档 JSON；MCP 不提供删除脚本工具。锁定、解锁和所有权转移必须使用验证码流程。

## 工具

提供 `flow_token_info`、脚本列表/读取/文档、所有权操作、预览、发布、执行和统计工具。所有权限、配额、限流、危险模式和模块白名单由服务端执行。

# 项目协作约束

1. 回复使用简体中文。
2. 本项目运行时为 Bun 1.4.0，依赖版本必须保持锁定。
3. 修改 MCP 工具、Skill、权威规则或 npm 包内容时，默认递增 `package.json`、`mcp-server/package.json` 和 MCP Server 自报版本，并同步 README 示例。
4. 发布前必须运行 `bun run prepack`，确认 MCP 元数据和工具契约测试全部通过。
5. 不得提交 Token、验证码、Cookie、Authorization 或其他敏感凭据。

## 验证

```bash
bun install --cwd mcp-server --frozen-lockfile
bun run prepack
npm pack --dry-run --json
```

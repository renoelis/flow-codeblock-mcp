# 接口文档

本文档基于当前代码实现，补齐全部对外接口与主要字段说明。

## 认证
- 普通 Token 与管理员 Token 通过请求头传递，支持：
  - `accessToken: <TOKEN>`
  - `access-token: <TOKEN>`
  - `Authorization: Bearer <TOKEN>`
- 管理员接口要求 `accessToken` 为管理员 Token。
- `/flow/codeblock/{scriptId}` 默认使用脚本绑定 Token，可用 `qingcodeToken` 临时覆盖。
- Token 级限流触发时响应头会包含 `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`，并返回 `Retry-After`。
- `RateLimit-Limit` 格式：`<limit>;w=<windowSeconds>`，`RateLimit-Reset` 为剩余秒数。

## 执行 lane 配置

- Web worker 池始终启动并与 Standard worker 池隔离；`test_tool.enabled` 只控制网页测试页面。
- 网页测试请求必须带 `x-flow-test-tool: 1`；MCP 脚本执行请求必须带 `X-Flow-Execution-Origin: mcp`。普通 HTTP 请求不带上述标识，进入 Standard lane。
- MCP 标识始终选择 Web lane；普通 HTTP 请求始终选择 Standard lane。

MCP Server 使用 `FLOW_CODEBLOCK_TOKEN` 调用 API，不对 API 响应中的 Token 做二次脱敏；`flow_token_info` 会返回当前 Token 的完整元数据。请由 MCP 客户端负责保护会话历史和调试输出。

## 通用约定
- `Content-Type: application/json`。
- `qingcodeTimeout` 单位为毫秒，查询参数优先级高于请求体。
- `codebase64`（执行接口）与 `code_base64`（脚本接口）均为 Base64 编码的 JS 代码。
- 日期格式：`YYYY-MM-DD`；时间格式：`YYYY-MM-DD HH:mm:ss`。

## 响应格式

### 标准成功响应（大部分接口）
```json
{
  "success": true,
  "data": {},
  "message": "success",
  "timestamp": "2025-01-01 12:00:00",
  "request_id": "uuid"
}
```

### 标准错误响应
```json
{
  "success": false,
  "error": {
    "message": "错误信息",
    "type": "ValidationError",
    "details": {}
  },
  "timestamp": "2025-01-01 12:00:00",
  "request_id": "uuid"
}
```

`error.details` 常见字段：
- `field`/`reason`：参数校验错误
- `retryAfter`：限流剩余等待秒数（429）
- `remainingAttempts`：验证码剩余尝试次数
- `limitInfo`：限流内部信息（存在时）

Token 级限流响应使用 `TokenRateLimitError`，`error.details.retryAfter` 表示等待秒数，且响应包含 `Retry-After`、`RateLimit-Limit`、`RateLimit-Remaining` 与 `RateLimit-Reset` 头。

### 执行接口响应说明
- `POST /flow/codeblock` 返回 `{ success, result, timing, timestamp, request_id }`，`timing` 包含 `executionTime`/`totalTime`（毫秒）。
- `POST /flow/codeblock` 失败时 `error` 包含 `type`/`message`，可能带 `stack`。
- `GET|POST /flow/codeblock/{scriptId}` 成功时直接返回脚本执行结果（JSON 或字符串）；失败时返回 `success=false` 的错误结构，并包含 `timing`。
- `X-Request-ID` 由服务端为每个 HTTP 请求动态生成，并通过响应头及适用的 JSON 响应返回；调用方传入的同名请求头会被忽略。
- 跨域成功响应通过 `Access-Control-Expose-Headers: X-Request-ID` 暴露服务端追踪 ID；`X-Request-ID` 不在允许调用方发送的请求头白名单中。
- 两类执行接口不提供业务重试幂等：重复或并发调用在通过认证、限流、配额和参数校验后均会独立执行、扣减配额并写入统计。
- 代码执行接口不读取 `Idempotency-Key`；该请求头仅适用于其已声明支持的其他接口。

## 错误类型对照

`error.type` 的取值来源于 `crates/flow-web/src/lib.rs`。下表为兼容接口常见含义（不同接口可能有差异，以实际实现为准）。

| error.type | 说明 | 常见 HTTP 状态 |
| --- | --- | --- |
| AuthenticationError | 缺少或无效凭证 | 401 |
| AuthorizationError | 权限不足或管理员 Token 无效 | 403 |
| ValidationError | 参数校验失败 | 400 |
| BadRequestError | 请求格式/内容错误 | 400 |
| NotFoundError | 资源不存在 | 404 |
| RateLimitError | 全局限流/配额不足 | 429 |
| TokenRateLimitError | Token 级限流 | 429 |
| IPRateLimitError | IP 级限流 | 429 |
| TokenExpiredError | Token 过期 | 401/410 |
| TokenInactiveError | Token 已禁用 | 403/410 |
| QuotaExceededError | 配额耗尽 | 429 |
| ExecutionTimeoutError | 执行超时 | 400 |
| ExecutionError | 代码执行错误 | 400 |
| ScriptError | 脚本相关错误（聚合型） | 400/404/409/429 |
| DuplicateScriptError | 脚本代码重复 | 409 |
| ScriptQuotaExceededError | 脚本数量配额超限 | 429 |
| ScriptLockedError | 脚本已锁定，禁止编辑、回滚与删除 | 423 |
| ScriptOwnerError | 非脚本所有者执行锁定、解锁、释放或转移 | 403 |
| ScriptOwnershipNotClaimedError | 脚本当前没有可释放或管理的所有者 | 409 |
| ScriptOwnershipTransferNotReadyError | 所有权转移无效、过期或缺少前序验证 | 409 |
| VersionNotFoundError | 脚本版本不存在 | 404 |
| IPNotAllowedError | IP 不在白名单 | 403 |
| ServiceUnavailableError | 服务不可用/熔断/同步中 | 503 |
| InternalError | 服务器内部错误 | 500 |
| CORSError | 跨域被拒 | 403 |

## 数据结构

### TokenInfo
- `id`/`ws_id`/`email`/`access_token`/`created_at`/`expires_at`/`operation_type`/`is_active`
- `rate_limit_per_minute`/`rate_limit_burst`/`rate_limit_window_seconds`
- `quota_type`/`total_quota`/`remaining_quota`/`quota_synced_at`
- `max_scripts`/`current_scripts`/`updated_at`

Token 掩码规则（`GET /flow/tokens`）：仅提供 `ws_id` 或仅提供 `email` 时，`access_token` 展示前 15 位 + `***`；提供 `token`，或同时提供 `ws_id` 和 `email` 时返回完整值。

### CodeScript
- `id`/`ws_id`/`email`/`description`/`code_base64`/`code_hash`/`code_length`
- `version`/`ip_whitelist`/`created_at`/`updated_at`
- `available_versions`（可选）
- `lock`：`is_locked`/`locked_at`/`owner_name`/`owner_display_name`/`owner_email_hint`。`owner_name` 是所有者填写的姓名；历史脚本为空时，`owner_display_name` 回退为邮箱 `@` 前部分。`owner_email_hint` 仅为中段脱敏提示，不返回所有者完整邮箱。

### QuotaLog
- `id`/`token`/`ws_id`/`email`
- `quota_before`/`quota_after`/`quota_change`/`action`
- `request_id`/`execution_success`/`execution_error_type`/`execution_error_message`
- `created_at`

### ScriptListItem（脚本列表返回项）
- `id`/`description`/`version`/`code_length`/`updated_at`/`lock`

上述 `TokenInfo`、`CodeScript`、`QuotaLog` 与 `ScriptListItem` 中的业务时间字段（`created_at`、`expires_at`、`quota_synced_at`、`updated_at`）均按上海时区输出为 `YYYY-MM-DD HH:mm:ss`；空值保持为 `null`。`specific_date` 和 `expires_at` 请求参数仍兼容 RFC3339 输入。

### ScriptStatsOverview（单脚本统计）
- `period.start_date`/`period.end_date`
- `summary.total_executions`/`success_count`/`failed_count`/`success_rate`/`avg_execution_time_ms`/`max_execution_time_ms`
- `summary.script_id`/`summary.latest_version`/`summary.latest_code_length`/`summary.latest_description`
- `daily_trend[]`（按日趋势，见 ScriptDailyTrend）
- `top_scripts[]`（可选，见 ScriptTopItem）

### ScriptDailyTrend
- `date`/`total`/`success`/`failed`

### ScriptTopItem
- `script_id`/`description`/`executions`/`success_rate`/`avg_time_ms`

### GlobalScriptStats（全局统计）
- `period.start_date`/`period.end_date`
- `summary.total_scripts`/`active_scripts`/`total_versions`/`quota_usage`/`total_executions`
- `summary.success_count`/`failed_count`/`success_rate`/`avg_execution_time_ms`/`max_execution_time_ms`
- `summary.error_stats`（见 GlobalErrorStats）
- `summary.cache_stats`（可选，见 GlobalCacheStats）
- `top_scripts[]`（`rank`/`script_id`/`description`/`executions`/`success_rate`/`avg_time_ms`）
- `daily_trend[]`（`date`/`total`/`success`/`failed`）

### GlobalErrorStats
- `quota_exceeded`/`ip_blocked`/`not_found`/`cache_update_failed`

### GlobalCacheStats
- `hit_count`/`miss_count`/`hit_rate`

### ModuleInfo
- `name`/`version`/`installed`/`size`/`description`/`license`

### ModuleBlacklistDetail
- `blacklist[]`：服务启动时加载并交给 Bun Supervisor 的禁用模块列表
- `count`：禁用模块数量

### ModuleStatsResponse（模块统计列表）
- `query.type`=single_date|date_range
- `query.date` 或 `query.start_date`/`query.end_date`
- `summary.total_executions`/`total_modules`/`require_usage_rate`/`basic_feature_count`（可选）
- `modules[]`：`module`/`usage_count`/`success_count`/`failed_count`/`success_rate`/`active_days`/`percentage`

### ModuleDetailStats（模块详细统计）
- `module`
- `period.type`=single_date|date_range
- `period.date` 或 `period.start_date`/`period.end_date`/`period.days`
- `summary.total_usage`/`total_success`/`total_failed`/`success_rate`/`active_days`/`avg_usage_per_day`
- `daily_trend[]`：`date`/`usage_count`/`success_count`/`failed_count`/`success_rate`
- `top_users[]`：`rank`/`token`/`ws_id`/`email`/`usage_count`/`percentage`

### UserActivityStatsResponse（用户活动统计）
- `query.page`/`page_size`/`sort_by`/`order`
- `query.type`=single_date|date_range
- `query.date` 或 `query.start_date`/`query.end_date`
- `summary.unique_tokens`/`unique_users`/`total_calls`/`avg_calls_per_user`
- `summary.success_calls`/`failed_calls`/`overall_success_rate`/`require_usage_rate`
- `pagination.page`/`page_size`/`total_records`/`total_pages`/`has_next`/`has_prev`
- `users[]`：`rank`/`token`/`ws_id`/`email`/`total_calls`/`success_calls`/`failed_calls`/`success_rate`
- `users[]`：`require_calls`/`basic_calls`/`require_percentage`/`avg_execution_time_ms`（可选）/`first_call_at`（可选）/`last_call_at`（可选）

### TokenCacheStats（Token 缓存统计）
- `hot_cache.hits`/`misses`/`evictions`/`hit_rate`
- `hot_cache.size`/`max_size`/`utilization_percent`
- `warm_cache.hits`/`warm_cache.misses`
- `cold_storage.hits`/`cold_storage.misses`
- `performance.total_requests`/`total_hit_rate`/`hot_hit_rate`
- `redis_enabled`

### RateLimitStats（限流统计）
- `enabled`/`backend`/`redis_enabled`/`allowed`/`denied`/`errors`

### CacheWritePoolStats（缓存写入池统计）
- `total_submitted`/`total_processed`/`total_success`/`total_failed`/`total_timeout`
- `submit_blocked`/`submit_rejected`/`shutdown_dropped`/`success_rate`
- `workers`/`active_workers`/`queue_size`/`queue_used`/`queue_available`/`is_running`

### ScriptCleanupResult（脚本清理结果）
- `trigger`/`started_at`/`finished_at`/`duration_ms`
- `expired_scripts_deleted`/`orphan_scripts_deleted`
- `old_stats_deleted`/`orphan_stats_deleted`
- `error`（可选）/`skip_reason`（可选）

## 接口详情

### 健康与状态

#### GET /
- 认证：无（全局 IP 限流）
- 响应：`data={service, version, status}`

#### GET /health
- 用途：存活检查（liveness）
- 认证：无，不参与业务限流
- 响应：`data={status: "ok"}`

#### GET /health/ready
- 用途：就绪检查（readiness），供负载均衡器判断实例是否可接收请求
- 认证：无，不参与业务限流
- 响应：就绪时返回 200 和 `data={status: "ready"}`；未就绪时返回 503 和 `data={status: "not_ready"}`
- 判定：服务已完成启动且未进入关闭流程，MySQL、启用状态下的 Redis 以及 Bun Supervisor 池探活均成功
- 满并发属于暂时饱和，不会令实例退出就绪状态

#### GET /flow/health
- 认证：管理员
- 默认返回存活状态；使用 `mode=ready` 或 `mode=readiness` 返回系统健康详情
- 任一必需依赖探活失败时返回 503；满并发时返回 200
- 字段：
  - `data.service`/`data.version`/`data.status`（healthy|degraded|unhealthy）
  - `data.checks.database`/`redis`/`executor`
  - `data.issues[]`（可选，异常原因）
  - `data.database.status`/`data.database.ping`
  - `data.redis.status`/`data.redis.ping`
  - `data.runtime.status`（healthy|saturated|unavailable）/`maxConcurrent`/`currentExecutions`/`totalExecutions`/`successRate`
  - `data.memory.sys`

#### GET /flow/status
- 认证：管理员
- 响应：运行状态、缓存与限流统计、内存与限制等信息
- 字段：
  - `data.status`/`data.uptime`/`data.startTime`/`data.runtimeVersion`/`data.engine`
  - `data.memory.rss`/`data.memory.executor`
  - `data.memory.executorStats`（可选）：`currentExecutions`/`maxConcurrent`/`queueLength`/`total`/`successful`/`failed`/`successRate`
  - `data.cache.codeCompilation`/`data.cache.codeValidation`：`size`/`hits`/`misses`/`capacity`
  - `data.limits.executionTimeout`/`maxCodeLength`/`maxConcurrent`/`maxResultSize`
  - `data.limits.database`/`data.limits.redis`
  - `data.extra.rate_limiter`（可选）/`data.extra.token_cache`（可选）

#### GET /flow/limits
- 认证：管理员
- 响应：执行限制、缓存配置、限流、数据库/Redis 参数等
- 字段：
  - `data.execution.maxCodeLength`/`maxInputSize`/`maxResultSize`/`timeout`/`allowConsole`
  - `data.concurrency.maxConcurrent`
  - `data.cache.codeCacheSize`
  - `data.circuitBreaker.enabled`/`minRequests`/`failureRatio`/`timeout`/`maxRequests`/`windowSec`
  - `data.rateLimit.preAuthIP`/`postAuthIP`/`globalIP`
  - `data.database`/`data.redis`/`data.tokenCache`
- 说明：部分字段会附带 `*Str` 的格式化字符串便于展示

### 测试工具

#### GET /flow/test-tool
- 认证：无（全局 IP 限流）
- 说明：返回 HTML 测试页面；若开启 Session，会下发 Session Cookie

### 代码执行

#### POST /flow/codeblock
- 认证：Token；认证成功使用认证后 IP 桶与 Token 桶，认证客户端错误仅使用认证前 IP 桶
- 请求体：
  - `codebase64`：必填
  - `input`：可选，默认 `{}`
  - `qingcodeTimeout`：可选（毫秒）
- 查询参数：`qingcodeTimeout`（可选，优先级高于 body）
- 说明：`qingcodeTimeout` 会做最小/最大阈值校验，超限返回 `ValidationError`
- 成功响应：`{success, result, timing, timestamp, request_id}`
  - `timing.executionTime` 为 executor 调用耗时；`timing.totalTime` 为请求解析完成后至 executor terminal result 的控制器总耗时，均为毫秒
  - `result` 可能是 JSON 对象/数组、字符串或 `null`
- 失败响应：`{success:false, error, timing, timestamp, request_id}`（通常 400）
  - `error.type`/`error.message`/`error.stack`（可选）
- 请求追踪：服务端自动生成 `X-Request-ID`，调用方传入值会被忽略。

#### GET /flow/codeblock/{scriptId}
#### POST /flow/codeblock/{scriptId}
- 认证：无（脚本 Token + IP 白名单校验）；使用脚本执行 IP 桶与 Token 桶
- MCP 调用：使用 `accessToken`，无需网页 Cookie 或 CSRF；同时携带 `X-Flow-Execution-Origin: mcp` 选择 Web lane。认证、配额、限流、危险模式、模块白名单、审计和统计规则不变。
- 查询参数：
  - `qingcodeToken`：可选，覆盖脚本绑定 Token
  - `qingcodeTimeout`：可选
  - 其他 query 参数会放入 `input.query`
- POST 请求体：解析为 JSON，放入 `input.body`（如果包含 `qingcodeTimeout` 会被移除）
- 输入结构：`input={query, header, body}`
- 说明：`qingcodeTimeout` 会做最小/最大阈值校验，超限返回 `ValidationError`
- 请求追踪：服务端自动生成 `X-Request-ID`，调用方传入值会被忽略。
- 响应：成功时直接返回脚本结果（JSON 或字符串）；失败时返回错误结构（含 `timing`）
- 重定向：若脚本返回 JSON 对象且包含 `flow_redirect_url`（字符串），服务端将返回 3xx 并设置 `Location`
  - `flow_redirect_code` 可选，仅支持 301/302/303/307/308
  - 未提供 `flow_redirect_code` 时：GET/HEAD 默认 302，其他方法默认 303
  - `flow_redirect_url` 非法将返回 `ValidationError`
- 额外限制：POST 请求体大小受 `server.max_request_body_mb` 限制

### Token 自助查询

#### GET /flow/token/self
- 认证：Token
- 响应：`data={count, tokens:[TokenInfo]}`（返回完整 access_token）

#### POST /flow/token/request-verify-code
- 认证：无（全局 IP 限流）
- 请求体：`{ws_id, email}`
- 说明：若启用 `verify_code.session_enabled`，必须携带绑定当前客户端 IP 和 User-Agent 的 `flow_page_session` Cookie；验证码接口不要求 CSRF Token。入口会在解析 JSON 前校验并续期页面 Session。
- 响应：`data={message}`，用于提示验证码已发送
- 失败：触发频率限制时返回 429（`error.details.retryAfter`）

#### POST /flow/token/verify-and-query
- 认证：无（全局 IP 限流）
- 请求体：`{ws_id, email, code}`
- 说明：若启用 `verify_code.session_enabled`，必须携带 `flow_page_session` Cookie；提供 `code` 或已有 `flow_verify_session` 都不能替代入口页面 Session，且验证码接口不要求 CSRF Token。
- 响应：`data={count, tokens:[TokenInfo]}`
- 失败：验证码错误时 `error.details.remainingAttempts` 可能返回剩余次数
- 失败：验证码验证成功但没有匹配 Token 时返回 404 `NotFoundError`

### Token 管理（管理员）

#### POST /flow/tokens
- 认证：管理员
- 请求体：
  - `ws_id`/`email`/`operation`(add|set|unlimited) 必填
  - `days`（add）/`specific_date`（set）
  - `quota_type`(time|count|hybrid)/`total_quota`
  - `rate_limit_per_minute`/`rate_limit_burst`/`rate_limit_window_seconds`
  - `max_scripts`
- 校验规则：
  - `operation=add` 时必须提供 `days` 且为正整数
  - `operation=set` 时必须提供 `specific_date`
  - `quota_type=count|hybrid` 时必须提供 `total_quota` 且为正整数
  - 设置 `rate_limit_burst`/`rate_limit_window_seconds` 时必须提供 `rate_limit_per_minute`
  - `max_scripts` 需为正整数
- 说明：不支持旧字段 `per_minute`/`burst`/`window_seconds`
- 响应：`TokenInfo`

#### GET /flow/tokens
- 认证：管理员
- 查询参数：`token`/`ws_id`/`email`（至少一个）
- 查询优先级：非空 `token` 优先，存在时忽略 `ws_id` 和 `email`；否则依次按 `ws_id + email`、仅 `ws_id`、仅 `email` 查询
- 返回范围：仅返回 `is_active=1` 的 Token；空字符串参数视为未提供
- 展示规则：`token` 或 `ws_id + email` 查询返回完整 Token；仅 `ws_id` 或仅 `email` 查询返回脱敏 Token
- 响应：`data={count, tokens:[TokenInfo]}`

#### PUT /flow/tokens/{token}
- 认证：管理员
- 可选请求头：`Idempotency-Key`
- 请求体：
  - `operation`(set|unlimited) 必填
  - `specific_date` 或 `expires_at`
  - `rate_limit_per_minute`/`rate_limit_burst`/`rate_limit_window_seconds`
  - `quota_type`
  - `quota_operation`(add|set|reset) 或 `reset_quota=true`
  - `quota_amount` 或 `total_quota`
  - `max_scripts`
- 校验规则：
  - `operation=set` 时必须提供 `specific_date` 或 `expires_at`
  - `quota_type=count|hybrid` 时必须提供 `quota_operation`
  - `quota_operation=add|set` 时必须提供 `quota_amount`
  - `quota_operation=reset` 可选 `quota_amount`（为空则重置为当前 `total_quota`）
  - `max_scripts` 需为正整数
- 说明：不支持旧字段 `per_minute`/`burst`/`window_seconds`
- 响应：更新后的 `TokenInfo`

#### DELETE /flow/tokens/{token}
- 认证：管理员
- 语义：在同一 MySQL 事务内停用 Token 并写入缓存失效 outbox；Redis 删除或跨实例失效广播失败时返回 `503`，调用方可安全重试同一请求以完成投递。
- 响应：成功无 data；Token 不存在返回 `404`

#### GET /flow/tokens/{token}/quota
- 认证：管理员
- 响应：
  - `time` 模式：`{quota_type, message}`
  - 其他模式：`{quota_type, total_quota, remaining_quota, consumed_quota, quota_synced_at}`

#### GET /flow/tokens/{token}/quota/logs
- 认证：管理员
- 查询参数：`page`、`page_size(1-1000, 默认 100)`、`start_date`、`end_date`
- 响应：`data={logs:[QuotaLog], total, page, page_size, total_pages}`

#### GET /flow/quota/cleanup/stats
- 认证：管理员
- 响应：启用时返回统计信息；未启用时 `enabled=false`
- 字段：`table_name`/`retention_days`/`cleanup_interval`/`batch_size`
- `cleanup_timeout_seconds`/`lock_wait_timeout_seconds`/`max_batches_per_run`
- `last_cleanup_time`/`last_success_time`/`last_error_time`/`last_error`
- `consecutive_failures`/`last_cleanup_count`/`total_cleaned_count`
- `last_cleanup_status`/`next_cleanup_time`

#### POST /flow/quota/cleanup/trigger
- 认证：管理员
- 响应：`data.message` 提示执行状态（排队/执行中/已完成）
- 失败：服务未运行时返回 503

#### GET /flow/cache/stats
- 认证：管理员
- 响应：TokenCacheStats

#### DELETE /flow/cache
- 认证：管理员
- 响应：成功无 data

#### GET /flow/rate-limit/stats
- 认证：管理员
- 响应：`data.rate_limit` 为 RateLimitStats，`data.write_pool` 为 CacheWritePoolStats（未启用时 `enabled=false`）

#### DELETE /flow/rate-limit/{token}
- 认证：管理员
- 响应：清除 Token 限流结果

#### GET /flow/cache-write-pool/stats
- 认证：管理员
- 响应：CacheWritePoolStats

### 脚本管理（Token 认证）

#### POST /flow/scripts
- 认证：Token
- 请求体：
  - `code_base64`：必填
  - `description`：可选
  - `ip_whitelist`：可选字符串数组（空数组或 null 表示不限制）
  - `interface_doc`：可选 `script-interface-doc.v1` 对象；代码和文档在同一事务中保存为版本 1
- 成功状态：`200 OK`
- 响应：`data={script_id, version}`

#### PUT /flow/scripts/{scriptId}
- 认证：Token
- 请求体（全可选）：
  - `expected_version`：可选正整数；提供后服务端在行锁内校验当前版本，冲突返回 `409 VersionConflictError`
  - `code_base64`
  - `description`
  - `ip_whitelist`（数组或 null；null 清除白名单，省略表示保持原值）
  - `interface_doc`（规范化前的 `script-interface-doc.v1` 对象）
  - `rollback_to_version`
- 限制：`code_base64` 与 `rollback_to_version` 不能同时提供
- 相同代码：仅更新其他提供的元数据，不创建版本，响应中的 `code_changed=false`
- 回滚：`rollback_to_version` 必须小于当前版本
- 脚本锁定时返回 `423 ScriptLockedError`
- 响应：`data={script_id, version, previous_version, code_changed}`

#### POST /flow/scripts/validate
- 认证：Token；只做认证、限流和脚本/文档校验，不写数据库、不扣执行配额。
- 请求体：`code_base64`（创建或代码变更时必填，更新仅描述/IP 时可省略）、`script_id`（更新或文档校验时提供）、`ip_whitelist`、`interface_doc`。
- 响应：`data.valid`、`data.code_hash`、`data.code_length`、规范化后的 `data.interface_doc` 和 `data.warnings`。

#### DELETE /flow/scripts/{scriptId}
- 认证：Token
- 成功状态：`200 OK`
- 响应：`data={script_id}`
- 脚本锁定时返回 `423 ScriptLockedError`

#### POST /flow/scripts/{scriptId}/owner-challenge
- 认证：Token
- 请求体：`{action:"lock"|"unlock"|"release", email}`
- 向可用的所有者邮箱发送一次性验证码。首次锁定可认领未设置所有者的存量脚本；已有所有者时邮箱必须匹配。

#### POST /flow/scripts/{scriptId}/lock 与 POST /flow/scripts/{scriptId}/unlock
- 认证：Token
- 锁定请求体：`{email, code, owner_name}`；`owner_name` 去除首尾空白后须为 1-100 个字符，且不能包含控制字符。解锁请求体：`{email, code}`。
- 验证码严格绑定脚本 ID、操作类型与邮箱，成功后响应 `data.is_locked`、`data.locked_at`、`data.owner_name`、`data.owner_display_name` 与中段脱敏的 `data.owner_email_hint`。解锁保留已认领的所有者和姓名。

#### POST /flow/scripts/{scriptId}/release-ownership
- 认证：Token
- 请求体：`{email, code}`；验证码必须通过 `owner-challenge` 的 `release` 动作申请，并使用当前所有者邮箱。
- 仅未锁定且已有所有者的脚本可以释放。成功后原子清除所有者邮箱和姓名，作废所有待确认的所有权转移并追加审计记录；响应中的 `owner_name`、`owner_display_name`、`owner_email_hint` 均为 `null`。
- 释放后脚本保持未锁定，下一位持有同一 Token 的用户可以通过首次锁定流程重新认领。

#### POST /flow/scripts/{scriptId}/ownership-transfers
- 认证：Token
- 请求体：`{authorizer_email, new_owner_email, new_owner_name}`；兼容旧字段 `{current_owner_email, new_owner_email, new_owner_name}`。二者只能提供一个授权邮箱，`new_owner_name` 校验规则与锁定请求相同。
- `authorizer_email` 可为当前所有者邮箱，或脚本创建时绑定 Token 的登记邮箱；服务端仅在 MySQL 行锁事务中确认邮箱匹配，不向该邮箱发送验证码。校验通过后，验证码仅发送至 `new_owner_email`，响应包含不透明的 `transfer_id`。

#### POST /flow/scripts/{scriptId}/ownership-transfers/{transferId}/confirm
- 认证：Token
- 请求体：`{email, code}`
- 新所有者确认后原子切换所有者，锁定状态保持不变。

#### GET /flow/scripts/{scriptId}
- 认证：Token
- 查询参数：`version`（可选；`0` 或省略表示当前版本，正整数表示指定历史版本）
- 响应：
  - `data.available_versions`/`data.current_version`
  - `data.data[]`：每个版本包含 `id/version/description/code_base64/code_length/code_hash/created_at/updated_at/ip_whitelist`

#### GET /flow/scripts
- 认证：Token
- 查询参数：`page`、`size(1-100, 默认 20)`、`keyword`、`sort`(updated_at|created_at|executions, 默认 updated_at)、`order`(asc|desc, 默认 desc)
- `keyword` 同时匹配脚本描述和脚本 ID；排序并列时按脚本 ID 使用相同方向稳定排序
- 响应：`data={scripts:[ScriptListItem], total, current_page, total_pages, max_allowed, remaining}`

#### GET /flow/scripts/{scriptId}/stats
- 认证：Token
- 查询参数：`date` 或 `start_date`/`end_date`（YYYY-MM-DD）
- 默认范围：最近 7 天
- 响应：`ScriptStatsOverview`

### 脚本管理（管理员）

#### POST /flow/admin/scripts/{scriptId}/ownership-recovery
- 认证：管理员
- 请求体：`{action:"unlock"|"assign_owner", owner_email?, owner_name?, reason}`
- `reason` 必填，最长 500 字符；`assign_owner` 必须提供 `owner_email` 与 `owner_name`，并会保持脚本锁定。恢复动作仅用于应急恢复，会追加审计记录；管理员 Token 不会绕过普通脚本编辑或删除锁定。

#### GET /flow/scripts/stats
- 认证：管理员
- 查询参数：`date` 或 `start_date`/`end_date`、`page`、`page_size(1-100, 默认 10)`
- 默认范围：最近 7 天
- 响应：`GlobalScriptStats`

#### GET /flow/scripts/cleanup/stats
- 认证：管理员
- 响应：
  - `enabled`/`running`/`interval_minutes`/`timeout_seconds`/`note`
  - `last_result`（可选，见 ScriptCleanupResult）
  - `last_result_at`（可选）/`next_run_at`（可选）

#### POST /flow/scripts/cleanup/trigger
- 认证：管理员
- 响应：`ScriptCleanupResult`，`data.message` 提示执行状态
- 失败：已有清理任务在运行时返回 409

### 统计（管理员）

#### GET /flow/stats/modules
- 认证：管理员
- 查询参数：`date`、`start_date`、`end_date`、`module`、`sort_by`、`order`
- 规则：`date` 与 `start_date/end_date` 二选一；范围最长 31 天；未提供日期时默认当天
- 说明：`module`/`sort_by`/`order` 目前不影响结果，排序固定为 `usage_count desc`
- 响应：ModuleStatsResponse

#### GET /flow/stats/modules/{module_name}
- 认证：管理员
- 查询参数：`date`、`start_date`、`end_date`
- 规则：`date` 与 `start_date/end_date` 二选一；范围最长 31 天；未提供日期时默认当天
- 响应：ModuleDetailStats

#### GET /flow/stats/users
- 认证：管理员
- 查询参数：`date`、`start_date`、`end_date`、`page`、`page_size`、`min_calls`、`sort_by`、`order`、`ws_id`
- 规则：`date` 与 `start_date/end_date` 二选一；范围最长 31 天；未提供日期时默认当天
- 分页：`page_size` 最大 100，`page*page_size` 最大 10000
- 默认：`sort_by=total_calls`，`order=desc`
- 说明：`ws_id` 目前不影响结果
- 响应：UserActivityStatsResponse

### 模块管理（管理员）

#### GET /flow/modules
- 认证：管理员
- 查询参数：`include_size`(默认 true)
- 响应：`data={modules:[ModuleInfo], total_count, total_size, size_calculated}`

#### GET /flow/modules/blacklist
- 认证：管理员
- 响应：`data=ModuleBlacklistDetail`
- 说明：返回当前运行实例启动时加载的只读黑名单快照

#### GET /flow/modules/{name}
- 认证：管理员
- 响应：`ModuleInfo`

模块安装、卸载、同步以及黑名单写入和 reload 不提供 HTTP API。模块依赖由 `config/modules.json` 和 `executor/bun.lock` 锁定，在镜像构建阶段安装；新增、删除或升级模块后必须重新构建并发布镜像。模块黑名单由宿主机只读挂载，修改后重启服务生效。

### 安全管理（管理员）

#### GET /flow/security/dangerous_patterns
- 认证：管理员
- 响应：`data={identifiers, members, identifier_count, member_count, count, config_path}`

危险模式更新和 reload 不提供 HTTP API。管理员需在宿主机修改 `security.dangerous_patterns_path` 指向的只读挂载文件，并重启服务加载配置。

### 静态资源

#### GET /flow/assets/*
- 说明：静态资源由 `StaticAssets` 管理。以下扁平路径是长期保留的兼容别名：Ace 相关文件映射到 `assets/codemirror/`，`/flow/assets/logo.png` 映射到 `assets/elements/LOGO.png`。
- 常见路径如下：
  - `/flow/assets/ace.js`
  - `/flow/assets/mode-javascript.js`
  - `/flow/assets/mode-json.js`
  - `/flow/assets/theme-monokai.js`
  - `/flow/assets/worker-javascript.js`
  - `/flow/assets/worker-json.js`
  - `/flow/assets/ext-searchbox.js`
  - `/flow/assets/logo.png`
  - `/flow/assets/verify-code.js`
  - `/flow/assets/test-tool/test-tool.css`
  - `/flow/assets/test-tool/test-tool.js`
  - `/flow/assets/script-manager/{filepath...}`

## 示例

### 执行代码：`POST /flow/codeblock`
```bash
curl -X POST http://localhost:3002/flow/codeblock \
  -H 'Content-Type: application/json' \
  -H 'accessToken: <TOKEN>' \
  -d '{
    "codebase64": "Y29uc3Qge2EsIGJ9ID0gaW5wdXQ7IHJldHVybiB7c3VtOiBhICsgYn07",
    "input": {"a": 1, "b": 2},
    "qingcodeTimeout": 3000
  }'
```

### 上传脚本：`POST /flow/scripts`
```bash
curl -X POST http://localhost:3002/flow/scripts \
  -H 'Content-Type: application/json' \
  -H 'accessToken: <TOKEN>' \
  -d '{
    "code_base64": "Y29uc3Qge2EsIGJ9ID0gaW5wdXQ7IHJldHVybiB7c3VtOiBhICsgYn07",
    "description": "sum demo",
    "ip_whitelist": ["127.0.0.1/32"],
    "interface_doc": {
      "schema_version": "script-interface-doc.v1",
      "title": "求和接口",
      "summary": "接收两个数字并返回它们的和",
      "endpoint": {"methods": ["POST"], "description": "校验两个数字并返回求和结果"},
      "request": {"query": [], "headers": [], "body": {
        "content_type": "application/json",
        "schema": {"type": "object", "properties": {
          "a": {"type": "number", "description": "第一个加数", "example": 1},
          "b": {"type": "number", "description": "第二个加数", "example": 2}
        }},
        "example": {"a": 1, "b": 2}
      }},
      "responses": [{"status": 200, "description": "求和成功", "content_type": "application/json", "schema": {"type": "object", "properties": {
        "sum": {"type": "number", "description": "两个数字的和", "example": 3}
      }}, "example": {"sum": 3}}],
      "logic_description": "读取并校验 a、b 两个数字，执行加法计算后返回 sum；参数缺失或类型错误时返回明确的业务错误响应。"
    }
  }'
```

### 预览脚本变更：`POST /flow/scripts/validate`
```bash
curl -X POST http://localhost:3002/flow/scripts/validate \
  -H 'Content-Type: application/json' -H 'accessToken: <TOKEN>' \
  -d '{
    "code_base64": "Y29uc3Qge2EsIGJ9ID0gaW5wdXQ7IHJldHVybiB7c3VtOiBhICsgYn07",
    "interface_doc": {"schema_version":"script-interface-doc.v1","title":"健康检查","summary":"返回服务当前状态","endpoint":{"methods":["GET"],"description":"读取并返回服务健康状态"},"responses":[{"status":200,"description":"服务正常","content_type":"application/json","schema":{"type":"object"},"example":{}}],"logic_description":"读取服务运行状态并返回健康检查结果；服务异常时返回对应的错误响应。"}
  }'
```

### 执行脚本：`POST /flow/codeblock/{scriptId}`
```bash
curl -X POST "http://localhost:3002/flow/codeblock/d9b2...?qingcodeToken=<TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{"a": 1, "b": 2}'
```

### 创建 Token（管理员）：`POST /flow/tokens`
```bash
curl -X POST http://localhost:3002/flow/tokens \
  -H 'Content-Type: application/json' \
  -H 'accessToken: <ADMIN_TOKEN>' \
  -d '{
    "ws_id": "ws_123",
    "email": "user@example.com",
    "operation": "add",
    "days": 30,
    "quota_type": "time",
    "total_quota": 3600,
    "rate_limit_per_minute": 60,
    "rate_limit_burst": 10,
    "rate_limit_window_seconds": 60,
    "max_scripts": 50
  }'
```

## 脚本接口文档

脚本接口文档使用 `script-interface-doc.v1` 规范化 JSON 保存到脚本版本快照中。文档接口沿用脚本管理的 `accessToken` 鉴权、限流和权限模型，不会出现在公开脚本执行响应或执行缓存中。

### `GET /flow/scripts/{script_id}/documentation?version=...`

读取当前版本或指定历史版本的接口文档。未保存文档时 `data.document` 为 `null`；历史版本只读。响应的 `data` 包含 `version`、`current_version`、`is_current`、`is_locked`、`has_documentation` 和 `document`。

### `POST /flow/scripts/{script_id}/documentation`

只校验和规范化，不写数据库。请求支持以下两种形式：

```json
{"document":{"schema_version":"script-interface-doc.v1","title":"健康检查","summary":"返回服务当前状态","endpoint":{"methods":["GET"],"description":"读取并返回服务健康状态"},"responses":[{"status":200,"description":"服务正常","content_type":"application/json","schema":{"type":"object"},"example":{}}],"logic_description":"读取服务运行状态并返回健康检查结果；服务异常时返回对应的错误响应。"}}
```

```json
{"raw_document": "{\"openapi\":\"3.0.3\",\"paths\":{...}}", "format": "json"}
```

只接受 JSON，不接受 YAML；`title`、`summary`、`logic_description`、`endpoint.methods`、`endpoint.description` 和至少一个响应必填。查询参数、请求头的 `name/type/required/description/example` 必填；请求体和响应体的 `content_type/schema/example` 必填，Schema 根节点必须有 `type`，嵌套字段节点必须有 `type/description/example`。Web 页面录入时 `endpoint.path` 可以省略；MCP 创建时也可以省略，更新时填写实际脚本路径。Flow Codeblock API 会根据请求 URL 中的当前脚本 ID 生成 `/flow/codeblock/{script_id}`，不会用传入 path 覆盖系统路径。方法只允许 `GET`/`POST`，并固定按 `GET`、`POST` 顺序规范化。仅含 `GET` 时不保存 `request.body`，包含 `POST` 时请求体和响应体 `Content-Type` 固定为 `application/json`。同一位置参数不能重复，最多 100 个查询参数、100 个请求头、50 个响应和 100 个应用引用，规范化文档最大 256 KiB。响应会返回 `data.document` 和敏感字段 `warnings`。

### `PUT /flow/scripts/{script_id}/documentation`

请求格式与 `POST` 相同，另可带 `expected_version` 正整数。服务端在数据库行锁内校验期望版本，冲突返回 `409 VersionConflictError`。代码或文档 canonical JSON 发生变化时生成新脚本版本；重复保存相同文档、只修改描述或 IP 白名单不会增加版本。锁定脚本、历史版本均不能写入；回滚会恢复代码、描述、IP 白名单和接口文档快照。

示例：

```bash
curl -X PUT 'http://localhost:3002/flow/scripts/demo12345678901234567890/documentation' \
  -H 'Content-Type: application/json' -H 'accessToken: <TOKEN>' \
  -d '{"document":{"schema_version":"script-interface-doc.v1","title":"客户查询","summary":"根据客户编号查询客户信息","endpoint":{"methods":["GET"],"description":"校验客户编号并查询客户资料"},"request":{"query":[{"name":"customer_id","type":"string","required":true,"description":"客户编号","example":"C10001"}],"headers":[]},"responses":[{"status":200,"description":"查询成功","content_type":"application/json","schema":{"type":"object"},"example":{}}],"logic_description":"校验客户编号后查询客户资料，成功时返回客户信息；客户不存在或参数无效时返回明确错误响应。"}}'
```

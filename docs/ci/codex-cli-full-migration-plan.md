# CCHP Automation: Codex CLI + multi-agent v2 完整迁移计划

状态: implemented migration record

本文档是从旧引擎迁移到 Codex CLI + multi-agent v2 的实施记录。文中的旧路径和旧行号用于保留迁移基线与 parity provenance;生产入口已经完成 cutover,并由 `scripts/codex-removal-gate.sh` 阻止旧引擎重新进入生产路径。

## 1. 结论和目标架构

### 1.1 结论

迁移前 OpenCode/OMo 负责了五类职责:

1. 模型调用和 shell/file/MCP 工具执行;
2. OMo Sisyphus 协调器和 background task;
3. Ultra review 的 child 调度、并发上限、超时和叶子权限;
4. `todowrite` 到 GitHub sticky comment 的进度镜像;
5. OpenCode plugin 形式的 artifact guard、plan guard、context-mode 和 rtk hook.

Codex CLI 已提供模型执行、sandbox/approval、MCP、JSONL event、resume、app-server protocol 和 multi-agent v2 工具,但它没有一个可以直接替代 CCHP 可靠性边界的 `spawn` CLI 子命令。因而迁移不能只是把 `opencode run` 改成 `codex exec`。

### 1.2 目标架构

```text
.github/workflows/run.yml
  -> install pinned Codex CLI
  -> prepare isolated CODEX_HOME and trusted config
  -> prepare repo, token sidecar, GH wrapper, MCP servers
  -> src/codex/supervisor.ts
       -> production: codex app-server over stdio JSON-RPC
       -> compatibility/fallback: codex exec --json
       -> native multi-agent v2 capability gate
       -> explicit Codex child adapter when v2 gate is unavailable
       -> event parser and parent/child graph
       -> deadlines, interrupt, kill, reconcile
       -> TODO/progress heartbeat
       -> usage/token ledger
       -> review finalizer
  -> scripts/cleanup.sh
```

所有模型和子 agent 都由 Codex CLI 执行。CCHP supervisor 只拥有生命周期、权限、凭据、事件、账本和发布闸门,不再把这些可靠性保证寄托在模型是否正确调用某个 plugin 上。

### 1.3 非目标

- 不保留 OpenCode 作为生产 fallback。
- 不安装或加载 `oh-my-openagent`。
- 不把 OMo agent 名称伪装成 Codex agent 名称而继续依赖其内部协议。
- 不改变 route task 分类、prompt 文本、GitHub 权限范围、review artifact schema 或 finalizer 业务规则。
- 不把用户机器的全局 Codex 配置、全局 `AGENTS.md`、全局 skills 或全局 MCP 带入 CI run。
- 不要求任何调用仓库重命名、增删或重写现有 workflow inputs、repository/org variables、secrets 或 provider JSON。Codex 版本和内部配置是 engine-owned implementation detail,不能成为新的 caller 必填项。

## 2. 研究基线和已确认事实

### 2.1 仓库和 Codex 源码版本

| 项目 | 值 |
| --- | --- |
| 目标仓库 | `CCH-HQ/cchp-automation` |
| 当前分支 | `action-run-debug` |
| 当前基线 commit | `6137a675bf628baaf16ca67bcbab4ccbfcbf90d5` |
| Codex source clone | `/tmp/codex-source.COnt5C` |
| Codex source tag | `rust-v0.146.0` |
| Codex source commit | `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` |
| 本机 Codex CLI | `codex-cli 0.146.0` |
| 本机 feature | `multi_agent_v2: stable true` |
| 本机并发上限 | `max_concurrent_threads_per_session = 11` |

### 2.2 Codex CLI 运行边界

- `codex exec --json` 输出 JSONL,事件至少包括 `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`。
- `turn.completed.usage` 包含 `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`;它不保证包含 `total_tokens`。
- `--output-last-message` 和 `--output-schema` 可以把最终文本和结构化结果落盘。
- `resume` 通过 `thread/list` 和 `thread/resume` 维持 session history; resume 测试覆盖不重复 replay usage。
- headless `exec` 对 command/file approval request 不会等待人类,而是拒绝 server request;生产运行必须使用预批准且受 sandbox 限制的配置。
- `codex app-server --stdio` 提供 `thread/start`, `thread/resume`, `thread/list`, `thread/read`, `turn/start`, `turn/interrupt` 以及 `thread/tokenUsage/updated` 等 JSON-RPC 能力。

### 2.3 multi-agent v2 运行边界

源码证据:

- `codex-rs/core/src/config/mod.rs:1258-1309`: `MultiAgentV2Config` 提供并发数、wait timeout、namespace、model/reasoning override、wait 开关和 `non_code_mode_only`。
- `codex-rs/features/src/feature_configs.rs:80-115`: `[features.multi_agent_v2]` TOML schema, timeout 上限为 3600000ms。
- `codex-rs/core/src/tools/spec_plan.rs:1030-1080`: 注册 `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent` 等 namespaced tools。
- `codex-rs/core/src/agent/control/spawn.rs:600-724`: fork 前 flush parent rollout,支持 full history 或 `LastNTurns`,并清理 inherited usage hints。
- `codex-rs/core/src/agent/control.rs:455-546`: completion watcher 订阅 child status,channel 断开时 fallback 查询 status,完成后向 direct parent 发送结果。
- `codex-rs/agent-graph-store/src/store.rs:13-59`: parent/child edge 持久化和 descendants BFS。
- `codex-rs/state/migrations/0021_thread_spawn_edges.sql`: spawn edge storage。

已确认的限制:

- 没有独立的 `codex spawn` 非交互 CLI 命令。
- 没有发现一个可以保证所有 parent 最终恢复的全局 reconciliation loop。
- 因此 CCHP 必须实现 supervisor-owned graph,deadline,heartbeat,reconcile 和 process-group kill。

## 3. 迁移基线功能清单

以下清单是迁移的完整范围。每项都必须在新的实现和验收矩阵中出现。

| 迁移前 OpenCode/OMo 功能 | 迁移前入口 | Codex owner |
| --- | --- | --- |
| OpenCode 安装 | `.github/workflows/run.yml:158-182` | pinned Codex installer step |
| OMo/插件安装 | `scripts/prepare-env.sh:388-422` | 删除 OMo, Codex config + CCHP MCP/supervisor |
| route/task classification | `src/route/*` | 保持不变 |
| prompt templates | `src/route/prompts.ts:31-113` | 保持不变,改为 Codex prompt input |
| compact prompt | `scripts/compact-prompt.sh` | 保持文件契约,增加 Codex resume injection |
| provider/model map | `scripts/run.sh:292-373` | `src/codex/providers.ts` + trusted TOML |
| caller vars/secrets ABI | `.github/workflows/run.yml:31-46,203-228` | 原名原值直读,`src/codex/caller-contract.ts` 内部转换 |
| small model | `CCHP_BOT_SMALL_MODEL` | Codex `review_model`/agent model mapping |
| extra instructions | `CCHP_BOT_EXTRA_INSTRUCTIONS` | trusted `AGENTS.md`/prompt include list |
| fff | `prepare-env.sh:274-293` | stdio MCP allow-list, read-only |
| Serena | `prepare-env.sh:305-349` | stdio MCP allow-list, read-only |
| rtk hook | `prepare-env.sh:352-380` | shell command wrapper + output reducer, no OpenCode hook |
| context-mode | `prepare-env.sh:388-404` | CCHP-owned context MCP/index, no plugin bypass |
| OMo Sisyphus | `run.sh:255-289` | Codex root + native v2 tools |
| background child task | OpenCode task/background | native v2 + explicit child adapter |
| Ultra review | `opencode/plugin/ultra-review-runner.ts` | `src/codex/review-runner.ts` |
| leaf read-only reviewer | OpenCode agent permission | custom Codex reviewer TOML + supervisor policy |
| artifact path guard | `review-artifact-guard.ts` | supervisor preflight + MCP server guard |
| plan compaction guard | `plan-guard.ts` | `ctx/plan.md` + Codex prompt/hook + supervisor resume |
| TODO sticky mirror | `progress-comment.ts` | event/TODO adapter + `src/publish/sticky.ts` |
| GitHub App token rotation | 迁移前 `gh-token-refresher.ts` sidecar | supervisor 内存轮换 + typed broker;不创建 token file |
| GH wrapper/git credential helper | `run.sh:95-182` | 保持不变,加入 child env allow-list |
| permission/fork handling | `permissions.sh` + workflow token scope | Codex sandbox/approval + wrapper restrictions |
| MCP comment/review publication | `src/mcp/server.ts` | 保持 protocol,扩展 Codex MCP schema |
| review ledgers | `ctx/review/*` | 保持 schema,由 supervisor 写入 |
| review finalizer | `scripts/review-finalize.sh` | 保持闸门,改为 Codex completion source |
| auto-approve kill switch | `CCHP_DISABLE_AUTO_APPROVE` | Codex verdict policy adapter |
| external static scan | `scripts/external-scan.sh` | 保持步骤和阻断语义 |
| cleanup | `scripts/cleanup.sh` | 增加 Codex process/config/DB cleanup |
| runtime telemetry | OpenCode/OMo config | Codex analytics off, RTK telemetry off |

## 4. 目标目录和文件 ownership

新增文件必须按以下 ownership 创建,不把 supervisor 逻辑塞回巨大 shell 文件。

```text
codex/
  agents/
    root.toml
    reviewer.toml
    explorer.toml
    planner.toml
    implementer.toml
  prompts/
    root.md
    review-coordinator.md
    review-leaf.md
    context-index.md
  schemas/
    root-output.json
    review-result.json
    child-result.json
  config.toml.template

src/codex/
  cli.ts                    # codex binary/version/capability probes
  config.ts                 # isolated CODEX_HOME and trusted TOML generation
  caller-contract.ts        # unchanged workflow inputs/vars/secrets parser
  providers.ts              # CCHP provider -> Codex model_providers mapping
  provider-bridge.ts        # Responses-compatible local protocol bridge
  app-server.ts             # stdio JSON-RPC client and request correlation
  exec-adapter.ts           # codex exec --json adapter
  events.ts                 # JSONL/app-server event normalization
  graph.ts                  # parent/child graph and durable state
  supervisor.ts             # root state machine and process-group lifecycle
  child-adapter.ts          # explicit Codex child process/thread fallback
  deadlines.ts              # run/child/no-progress/heartbeat timers
  progress.ts               # TODO and event -> sticky comment adapter
  usage.ts                  # exact usage and billing ledger
  permissions.ts            # task/fork -> sandbox/approval/tool policy
  artifacts.ts              # review artifact contract and path guard
  review-runner.ts           # 10-way bounded review scheduler
  context-index.ts           # CCHP-owned context store/search/execute policy
  exit.ts                    # Codex/runtime/finalizer -> workflow exit map

scripts/
  install-codex.sh
  prepare-codex-env.sh
  run-codex.sh
  codex-capability-smoke.sh
  codex-child-fixture.sh

tests/codex/
  config.test.ts
  caller-contract.test.ts
  provider.test.ts
  provider-bridge.test.ts
  events.test.ts
  app-server.test.ts
  graph.test.ts
  deadlines.test.ts
  progress.test.ts
  usage.test.ts
  permissions.test.ts
  artifacts.test.ts
  review-runner.test.ts
  context-index.test.ts
  supervisor.integration.test.ts
  codex-cli.contract.test.ts
  fixtures/*.jsonl
```

原 `opencode/` 目录已在删除阶段整体移除。迁移期间使用的 parity
内容已经迁入 `codex/review/reference-library`;生产 workflow 和 runtime
不再引用原目录。

## 5. 配置、provider 和 secret contract

### 5.1 调用仓库 ABI 冻结

迁移必须保持现有 caller workflow 原封不动可运行。`claude-code-hub-plus/.github/workflows/cchp-bot.yml` 是当前实际调用契约,实现时不得要求该文件修改 `with`, `secrets` 或 Actions variables。

#### 5.1.1 workflow_call inputs

以下 input 名称、类型、required 属性、默认值和 trim/fallback 行为全部冻结:

| input | 类型 | required | 当前默认值 | engine env/行为 |
| --- | --- | --- | --- | --- |
| `default_branch` | string | false | `main` | `BOT_DEFAULT_BRANCH`,空白回退 `main` |
| `roadmap_project` | string | false | empty | `BOT_ROADMAP_PROJECT`,空白回退 empty |
| `roadmap_policy` | string | false | `.github/cchp-automation/roadmap-policy.md` | `BOT_ROADMAP_POLICY` |
| `semver_workflow` | string | false | empty | `BOT_SEMVER_WORKFLOW`,运行时回退 `semver-guard` |
| `semver_marker` | string | false | empty | `BOT_SEMVER_MARKER`,运行时回退 `cchp-semver-guard` |
| `tech_stack` | string | false | empty | `BOT_TECH_STACK`,保留现有通用 fallback |
| `languages` | string | false | empty | `BOT_LANGUAGES`,保留现有语言 fallback |

不得增加 `codex_version`, `codex_model_provider`, `codex_api_key`, `CCHP_CODEX_ENABLED` 等 caller input 或 variable。Codex binary version由 `cchp-automation` 自己 pin,caller 继续只引用 `@latest` 或明确 engine ref。

#### 5.1.2 reusable-workflow secrets

workflow boundary 名称和 caller 存储名称保持不变:

| caller secret | reusable-workflow secret | required | runner env/用途 |
| --- | --- | --- | --- |
| `CCHP_APP_CLIENT_ID` | `app-client-id` | true | token minting + rotation sidecar |
| `CCHP_APP_PRIVATE_KEY` | `app-private-key` | true | token minting + rotation sidecar;Codex 启动前 unset |
| `CCHP_BOT_PROVIDER_KEYS` | `provider-keys` | false | 原 JSON `provider -> API key`,映射为 provider-specific env |
| `HEROUI_AUTH_TOKEN` | `heroui-token` | false | package registry/toolchain |
| `SEE_API_KEY` | `see-api-key` | false | SEE toolchain |

继续禁止 `secrets: inherit`。不得要求 caller 把 provider keys 拆成多个 secrets,也不得要求新增 `OPENAI_API_KEY`, `CODEX_API_KEY` 或 Codex auth secret。Supervisor 直接解析原 JSON,真实 provider key 只传给 provider bridge 进程;Codex root/child 不得继承 `CCHP_BOT_PROVIDER_KEYS` 或 `CCHP_PK_*`。

#### 5.1.3 caller repository/org variables

以下变量名称和 value format 全部冻结:

| variable | required | 原格式 | Codex 内部使用 |
| --- | --- | --- | --- |
| `CCHP_BOT_PROVIDERS` | true | JSON provider map | 严格解析后生成 provider bridge routes 和 Codex `model_providers` |
| `CCHP_BOT_MODEL` | true | `provider/model`,只在第一个 `/` 处分割 | 选择 provider route 和 upstream model |
| `CCHP_BOT_SMALL_MODEL` | false | `provider/model` | reviewer/explorer/summary custom agent model;空则 main model |
| `CCHP_BOT_EXTRA_INSTRUCTIONS` | false | JSON string array | 按原顺序解析为 trusted instruction bundle;解析失败仍回退 `[]` |
| `CCHP_DISABLE_AUTO_APPROVE` | false | non-empty kill switch | APPROVE 强制降级 COMMENT |
| `CCHP_BOT_OPENCODE_VERSION` | false,legacy no-op | arbitrary string | workflow 不读取;迁移后仍被忽略,不得改作 Codex version |

2026-08-05 对实际 caller `CCH-HQ/claude-code-hub-plus` 的只读点验结果:

- live variables 包含 `CCHP_BOT_MODEL` 和 `CCHP_BOT_PROVIDERS`;
- live `CCHP_BOT_MODEL` 是 `provider/model` 结构;
- live provider 使用 `format="openai-responses"`,含 `base_url` 和 `models.gpt-5.6-sol`;
- live model 字段包含 `context`, `output`, `vision`;
- live secrets 的名称与上表完全一致;
- 未读取、打印或复制任何 secret value。

`src/codex/caller-contract.ts` 必须一次性完成解析和归一化,输出 `NormalizedCallerContract`。其输入只来自现有 env,不得读一套平行的 Codex env。解析失败必须在启动 Codex 前返回 exit 2 和不含 secret 的字段级错误。

#### 5.1.4 冻结 JSON schema

`CCHP_BOT_PROVIDERS` 继续接受当前 shape:

```ts
type CallerProviders = Record<string, {
  format: "openai-responses" | "openai-compatible" | "anthropic"
  base_url: string
  headers?: Record<string, string>
  models: Record<string, {
    upstream_id?: string
    context?: number
    output?: number
    vision?: boolean
    reasoning?: boolean
    compact_threshold?: number
  }>
}>
```

`CCHP_BOT_PROVIDER_KEYS` 继续接受:

```ts
type CallerProviderKeys = Record<string, string>
```

provider env sanitizer 必须与当前 shell 完全一致: provider id 转 uppercase,所有非 `[A-Z0-9]` 字符替换为 `_`,前缀为 `CCHP_PK_`。例如 `gpt-cchp` 固定映射为 `CCHP_PK_GPT_CCHP`。这些 env 只存在于 provider bridge。冲突检测是新增的内部安全校验:两个不同 provider id 若产生同一个 env name,必须在 Codex 启动前失败,不能覆盖彼此。

### 5.2 隔离 CODEX_HOME

每次 run 创建 `${BOT_WORKDIR}/codex-home` 并导出 `CODEX_HOME`。配置生成规则:

1. `codex/config.toml.template` 是仓库内受审查模板。
2. `src/codex/config.ts` 只写入经过 schema 校验的最终 TOML。
3. `codex exec` 使用 `--ignore-user-config --strict-config`; pinned `codex app-server` 只支持 `--strict-config`,其用户配置隔离由 run-scoped `CODEX_HOME` 保证。
4. 不读取 runner 用户的 `~/.codex/config.toml`,全局 agents,全局 skills 或 MCP。
5. `CODEX_HOME/auth.json` 只在明确使用 Codex auth flow 时存在,Unix mode 必须为 `0600`。
6. provider API key 只进入 provider bridge env,不得写入 TOML,不得进入 Codex/root/child env。
7. CCHP App private key 在 sidecar 启动前只存在于 sidecar env,在启动 Codex 前必须 `unset`。
8. 生成配置、环境快照、事件日志和错误日志必须通过 secret scrubber,禁止输出 `BEGIN ... PRIVATE KEY`, provider key 和完整 GitHub token。

### 5.3 CCHP provider 到 Codex provider

调用仓库的 provider JSON 不直接改写为 Codex TOML,而是先由 `src/codex/providers.ts` 归一化,再由 runner-local `src/codex/provider-bridge.ts` 暴露统一 Responses endpoint。这样可以在 caller format 不变的前提下,完整支持 Codex 当前只接受的 `wire_api="responses"`。

每个 caller provider 生成一个本地 route:

```text
caller provider <id>
  -> http://127.0.0.1:<ephemeral-port>/providers/<encoded-id>/v1
  -> provider-bridge
  -> original base_url + headers + provider key
```

Codex provider id 不能直接复用 caller provider id。`src/codex/providers.ts` 为每个 caller id 生成稳定内部 id `cchp_<sanitized>_<short-hash>`,从而避免 caller 使用 `openai`, `amazon-bedrock`, `ollama`, `lmstudio` 等 Codex reserved id 时被迫改配置。原 caller id 继续用于 model binding,provider-key lookup,bridge route,日志和 usage ledger。

Codex 只看到内部配置:

```toml
model = "<upstream_id-or-model-key>"
model_provider = "cchp_<sanitized>_<short-hash>"

[model_providers.cchp_<sanitized>_<short-hash>]
name = "<original-provider-id>"
base_url = "http://127.0.0.1:<port>/providers/<encoded-id>/v1"
env_key = "CCHP_CODEX_BRIDGE_TOKEN_<SHORT_HASH>"
wire_api = "responses"
```

Supervisor 为每个 run 生成随机 loopback bridge token,只将该 token 交给 Codex,bridge 验证 token 后才转发请求。这个 token 不能访问原始 upstream,不能跨 run 使用,cleanup 时销毁。真实 provider key 仍按原 sanitizer 注入 bridge env。若 caller provider 没有对应 key且上游需要认证,bridge 在首个上游请求前返回结构化 `MISSING_PROVIDER_KEY`,但不能要求 caller 改成 Codex-native secret。

`CCHP_BOT_PROVIDERS` 的每个字段映射如下:

| CCHP 字段 | Codex 字段 | 约束 |
| --- | --- | --- |
| provider id | normalized caller id -> namespaced Codex id | 原值非空;Codex 内部 id 自动避开 reserved names |
| `base_url` | provider bridge upstream | 只能来自 trusted caller variable,不能被 PR project config 改写 |
| provider key | bridge-only `CCHP_PK_*` env | key 内容不写 TOML/日志/Codex env;Codex `env_key` 指向 per-run bridge token |
| `headers` | bridge upstream headers | 原值原样使用,日志只记录 header names |
| `format=openai-responses` | Responses passthrough adapter | request/stream/error/usage 保持 Responses 语义 |
| `format=openai-compatible` | Chat/compatible -> Responses adapter | 完整转换 messages,input,tools,tool outputs,stream,error,usage |
| `format=anthropic` | Anthropic Messages -> Responses adapter | 完整转换 system,input,image,reasoning,tools,stream,error,usage |
| `context` | Codex `model_context_window` | 必须是正整数 |
| `output` | bridge `max_output_tokens` enforcement | 保持现有上限,同时写 usage/anomaly ledger |
| `reasoning` | model reasoning capability | false 时禁止 effort override |
| `upstream_id` | bridge upstream model id + Codex model | 未提供时使用 model map key |
| `vision` | bridge input modality guard | false 时在上游请求前拒绝 image input |
| `compact_threshold` | `model_auto_compact_token_limit` | `round(context * threshold)`,缺省保持当前 0.9 语义 |

provider bridge 必须实现完整的双向协议转换:

1. text/system/developer/user input;
2. image attachment and modality validation;
3. reasoning effort and reasoning summaries where upstream supports;
4. function/tool definition, tool call id, arguments and tool outputs;
5. streaming delta ordering and terminal event;
6. cancellation and client disconnect propagation;
7. HTTP status, structured error, retry-after and rate-limit normalization;
8. input/cached/cache-write/output/reasoning/total usage normalization;
9. model id rewrite through `upstream_id`;
10. configured output cap and stream idle timeout。

不允许对 `anthropic` 或 `openai-compatible` 返回 “Codex 不支持,请修改 caller config”。兼容 bridge 是完整迁移的一部分。当前 live caller 的 `openai-responses` route 必须走零语义转换的 passthrough fast path。

拒绝条件:

- `CCHP_BOT_MODEL` 不存在 provider/model binding;
- provider format 不是已实现的 Responses-compatible format;
- provider id 为空、包含控制字符或 provider object 含未识别字段;
- API key 为空白;
- `requires_openai_auth` 与 env-key provider 语义冲突;
- project-local config 尝试覆盖 `model_provider`, `model_providers`, `openai_base_url`, `chatgpt_base_url`, `notify`, `profile` 或 OTEL。
- provider key JSON 不是 object、值不是 string、缺少 main provider key 且上游要求 auth,或 sanitizer 发生碰撞;
- `CCHP_BOT_SMALL_MODEL` 非空但 provider/model 不存在;
- instruction JSON 不是 string array 时按现有行为回退 `[]`,同时只记录不含原值的 warning。

### 5.4 model and agent role mapping

- root/implementer/planner: `CCHP_BOT_MODEL`, reasoning effort `xhigh`。
- explorer/reviewer: `CCHP_BOT_MODEL` 或显式 small model, reasoning effort `low`/`medium`,sandbox `read-only`。
- reviewer agent: `edit`, `task`, arbitrary shell and publication tools all denied; only read/search, fixture input and artifact write API allowed。
- planner: only `${BOT_WORKDIR}/ctx/plan.md` is writable; no repository write。
- fork review/engage: base GitHub token, read-only Codex sandbox, no code write.
- same-repo implementer: workspace-write only when route classifier sets `BOT_CAN_WRITE=1` and token scope is write.

`CCHP_BOT_SMALL_MODEL` 若使用不同 provider,对应 custom agent TOML 必须同时设置 `model_provider` 和 `model`;不得错误继承 main provider。`CCHP_BOT_EXTRA_INSTRUCTIONS` 中的每一项按原顺序解析: trusted repo/local file 做 canonical path 校验后读取,HTTPS URL 以固定 timeout/size 下载到 `ctx/instructions`,记录 SHA256,并作为 untrusted supplemental context 注入。调用仓库不需要改变数组内容。

## 6. sandbox, approval, MCP 和外部工具

### 6.1 sandbox/approval matrix

| 任务 | sandbox | approval | Codex tools |
| --- | --- | --- | --- |
| `pr_opened` same repo | `read-only` | `never` | read, search, MCP review metadata |
| `pr_opened` fork | `read-only` | `never` | pre-fetched context + allow-listed metadata MCP |
| `engage` fork | `read-only` | `never` | issue/PR comment metadata only |
| `ci_fix` same repo | `workspace-write` | `never` | shell via allow-list, git push through credential helper |
| `reaction_execute` | `workspace-write` | `never` | implementation and tests |
| `roadmap_sync` | `read-only` | `never` | project GraphQL MCP only |
| explicit reviewer child | `read-only` | `never` | no write/publication |

`danger-full-access` is prohibited in workflow runtime. `--dangerously-bypass-approvals-and-sandbox` is prohibited by command construction and test grep. Approval mode output must use public `on-request` only for interactive diagnostics; headless automation uses a deliberate `never` plus safe sandbox, and any rejected request is a terminal policy failure rather than a hang.

### 6.2 MCP migration

`src/codex/config.ts` generates `[mcp_servers.*]` using Codex's mutually exclusive transport contract:

- stdio uses `command`, `args`, `env`, `env_vars`, `cwd`;
- HTTP uses `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`;
- `command` and `url` cannot coexist;
- plaintext `bearer_token` is rejected;
- `required=true` startup failure produces a non-zero run;
- `enabled_tools` and `disabled_tools` are checked before launch;
- per-tool `approval_mode` is explicit;
- OAuth credential names include `environment_id` to prevent cross-run collision.

Required servers after cutover:

1. `cchp_github`: typed Octokit MCP, scoped to `BOT_REPO`, route task and trusted target;
2. `fff`: read-only file/content search, if installed;
3. `serena`: read-only symbol/reference search, with all write and shell tools excluded;
4. `cchp_context`: new CCHP-owned context MCP, only for `${BOT_WORKDIR}/ctx`.

The context-mode replacement is complete, not a deletion: `src/codex/context-index.ts` must implement the currently used context contract as MCP tools: bounded command execution under the same Codex sandbox, FTS5/indexed snippets, artifact references for oversized output, and `ctx/` persistence. It may not bypass Codex sandbox or expose `/proc`, home credentials, or arbitrary external directories. Every exposed tool gets an allow-list and timeout.

`rtk` is retained as a binary command wrapper and output reducer. It is no longer an OpenCode plugin hook. `run-codex.sh` prepends `rtk` only for commands explicitly selected by `src/codex/permissions.ts`; direct shell commands remain available only under the task permission matrix.

## 7. Codex event and protocol adapter

### 7.1 app-server adapter

`src/codex/app-server.ts` launches:

```text
codex app-server --stdio --strict-config
```

The app-server boundary is an isolated run-scoped `CODEX_HOME` plus
`--strict-config`. The pinned app-server CLI does not expose
`--ignore-user-config`; that flag remains valid only for standalone
`codex exec` invocations that intentionally bypass generated user config.

It must provide:

- JSON-RPC request id correlation;
- bounded write/read queues;
- stderr capture with secret scrubbing;
- `thread/start`, `thread/resume`, `thread/list`, `thread/read`;
- `turn/start`, `turn/interrupt`;
- server request handling for MCP elicitation and approval rejection;
- graceful `thread/unsubscribe`, child process SIGINT, SIGTERM and SIGKILL escalation;
- protocol-version logging and hard failure on unknown required fields.

### 7.2 exec adapter

`src/codex/exec-adapter.ts` builds fresh attempts as:

```text
codex exec --json --ephemeral --strict-config \
  --sandbox <mode> --output-last-message <file> --output-schema <schema> -
```

`--ignore-user-config` is opt-in only for standalone invocations that do not depend on the generated `CODEX_HOME/config.toml`. Explicit children must load their run-scoped provider, MCP and role configuration, so they never set that flag. Resume attempts use `codex exec --json --strict-config resume <session> -` and retain the original sandbox.

It must parse every stdout line as JSON before forwarding it. A malformed line, unexpected event type or missing terminal event is a failed attempt, never an ignored warning.

### 7.3 normalized event contract

`src/codex/events.ts` converts app-server and exec events to:

```ts
type CchpEvent =
  | { type: "thread_started"; threadId: string; at: string }
  | { type: "turn_started"; threadId: string; turnId: string; at: string }
  | { type: "item"; threadId: string; turnId?: string; itemId: string; itemType: string; status: string; at: string }
  | { type: "todo"; threadId: string; todos: Todo[]; at: string }
  | { type: "collab"; parentThreadId: string; operation: "spawn" | "send" | "followup" | "wait" | "interrupt" | "close"; childId?: string; status: string; at: string }
  | { type: "usage"; scope: "thread" | "turn"; threadId: string; turnId?: string; usage: Usage; at: string }
  | { type: "turn_completed"; threadId: string; turnId: string; status: "completed" | "failed" | "interrupted"; at: string }
  | { type: "error"; code?: string; message: string; at: string }
```

Unknown events are persisted under `ctx/codex/events-unknown.jsonl` and fail the current run if they could affect lifecycle or usage. They are not silently dropped.

## 8. Native multi-agent v2 and explicit child adapter

### 8.1 Capability gate

Before production root execution, `codex-capability-smoke.sh` must run in a fresh `CODEX_HOME` and verify:

1. `codex --version` equals the pinned version;
2. `codex features list` reports `multi_agent_v2` stable and enabled;
3. generated `[features.multi_agent_v2]` is accepted under `--strict-config`;
4. root can create one `explorer` child;
5. child completion reaches the direct parent;
6. parent can `wait_agent`, `send_message`, `followup_task`, `interrupt_agent`; native Codex 0.146.0 has no `close_agent`, so native close is the `interrupt_agent` + `wait_agent` terminal sequence;
7. child and root terminal states are observable through app-server notifications;
8. a dead-parent completion does not block child termination (the deterministic lost-child/reconcile assertion is covered by `supervisor.test.ts` and the pre-cutover matrix);
9. per-thread usage is visible through `thread/tokenUsage/updated` or a documented app-server read path;
10. process-group interrupt stops root and all descendants within the deadline (the deterministic process-group assertion is covered by `app-server.test.ts` and the pre-cutover matrix; the live smoke asserts the interrupt request and stream cancellation boundary);
11. every native child request exposes no collaboration tools; `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent` and `list_agents` are root-only.

The gate is a required CI artifact. If any item fails, production uses the explicit child adapter for that run and emits `codex_v2_gate=failed` in the run manifest. This is a complete, tested execution mode, not an unimplemented placeholder.

### 8.2 Native v2 mode

In v2 mode the root prompt contains an explicit coordinator contract:

- use namespaced `agents.spawn_agent` for independent work;
- declare child id, role, deadline and expected artifact before spawn;
- wait for every child with bounded timeout;
- use `send_message` only for an existing child;
- use `followup_task` only after a terminal or explicitly interrupted child;
- use `interrupt_agent` on deadline or parent cancellation;
- never let a reviewer child publish GitHub comments or write code;
- write completion evidence into `ctx/review` or `ctx/child-results` only.

Only the root coordinator receives native v2 collaboration tools. Every optional and built-in child role is overridden by a run-scoped role file: `reviewer` and `explorer` use the small-model alias; `planner`, `implementer`, `default` and `worker` use the main-model alias. The aliases map back to the caller's unchanged provider/model JSON in the loopback bridge and remain marked as non-v2 leaf models.

The hard capability boundary is the role config applied before Codex creates the child session. Every leaf role sets `[agents].enabled = false`, `[features].multi_agent = false`, and `[features.multi_agent_v2].enabled = false`. In the pinned `rust-v0.146.0` source, `apply_role_to_config` runs before `effective_multi_agent_version_for_spawn`; the resulting config override resolves the child session to `multi_agent_version = disabled` instead of inheriting the root's V2 session. The capability smoke captures the real child Responses request and requires `native_child_collaboration_tools` to be an empty array. A child therefore cannot spawn, message, wait for or interrupt another agent even if its prompt is compromised.

The supervisor listens to `collab_tool_call` and graph events, records parent/child edges, and does not treat a model message saying “done” as completion. It also rejects any `spawnAgent` whose sender is not the root before admission or graph mutation; this is the second fail-closed boundary behind capability isolation. Completion requires a Codex terminal status plus a validated result artifact.

### 8.3 Explicit child mode

`src/codex/child-adapter.ts` is mandatory and fully implemented for the shared collaboration contract. Native v2 has no `close_agent` catalog entry; its terminal close semantics are `interrupt_agent` followed by `wait_agent`. The explicit adapter additionally exposes `close_agent` through its MCP server:

| v2 operation | explicit adapter |
| --- | --- |
| `spawn_agent` | start a new `codex exec --json` or app-server thread with role TOML and input fixture |
| `send_message` | `turn/start` on the child thread with a message envelope |
| `followup_task` | `resume` child thread or app-server `turn/start` after terminal state |
| `wait_agent` | wait on normalized child terminal event with bounded deadline |
| `interrupt_agent` | `turn/interrupt`, then process-group TERM/KILL if needed |
| `close_agent` | mark graph edge closed, stop child process/thread and persist reason |

Every child gets a stable `run_id`, `parent_run_id`, `child_id`, `role`, `deadline_at`, `sandbox`, `token_scope` and `result_path`. The parent is resumed by the supervisor with a signed result envelope, not by an unbounded model wait.

## 9. Supervisor state machine and reliability controls

### 9.1 Root states

```text
INIT -> CONFIGURED -> ROOT_STARTING -> ROOT_RUNNING
ROOT_RUNNING -> ROOT_DRAINING -> FINALIZING -> SUCCEEDED
ROOT_RUNNING -> FAILED | TIMED_OUT | CANCELLED
ROOT_DRAINING -> FAILED | TIMED_OUT
FINALIZING -> SUCCEEDED | FAILED
```

All transitions are append-only in `ctx/codex/supervisor.jsonl`. A process exit without a recorded terminal state is `FAILED/LOST`, not success.

### 9.2 Child states

```text
DECLARED -> STARTING -> RUNNING -> WAITING -> COMPLETED
RUNNING/WAITING -> FAILED | TIMED_OUT | INTERRUPTED | LOST
```

The graph store must enforce one parent per child, idempotent edge upsert, stable child ordering, Open/Closed edge status, BFS descendant listing and closure of descendants during cleanup.

### 9.3 Hard deadlines

The defaults are fixed and can only be reduced by workflow inputs:

| Timer | Default | Action |
| --- | ---: | --- |
| whole run | 43200s | interrupt root, TERM process group after 15s, KILL after another 15s |
| review child | 1800s | interrupt child, TERM after 10s, KILL after 20s |
| general child | 1800s | same as review child |
| heartbeat | 60s | publish progress or stale marker |
| no semantic progress warning | 300s | publish warning event/comment |
| no semantic progress terminal | 1200s | interrupt root and mark `NO_PROGRESS_TIMEOUT` |
| child no-event reconcile | 120s | query app-server status/thread/read |
| parent resume grace | 120s | retry resume once, then fail the parent |

The supervisor uses monotonic timers, not model timestamps. No run may remain alive after the whole-run deadline plus 30s kill grace.

### 9.4 Reconciliation

Every 30s the supervisor:

1. compares OS process group membership with graph Open edges;
2. queries each non-terminal child status;
3. closes edges whose child is terminal;
4. marks missing child results as `LOST` and emits a machine-readable failure;
5. resumes the parent exactly once when a child result is ready and parent is live;
6. retries parent resume once after a transient app-server disconnect;
7. fails the run if the parent cannot be resumed within 120s;
8. never waits forever on a closed event channel.

## 10. TODO, progress and stalled-run handling

### 10.1 Canonical TODO source

The canonical TODO list is the root supervisor ledger at `ctx/codex/todo.json`. Codex `todo_list` items are imported into it. A model-only text list is not canonical. Native v2 child TODOs stay under their child id and cannot overwrite root progress.

### 10.2 Progress events

`src/codex/progress.ts` updates the existing sticky marker format `<!-- cchp-bot:progress:<task> -->` through the existing Octokit/MCP publisher. It must render:

- task id and root run id;
- progress bar and completed/total counts;
- current in-progress item;
- root and child counts by state;
- last event time and last semantic progress time;
- token usage summary without secrets;
- stale or timed-out warning when applicable.

The publisher is fail-open for GitHub network errors, but the local ledger update is fail-closed. A failed comment publish cannot hide a stalled local run.

### 10.3 No-progress rules

Semantic progress includes a new TODO state, terminal child event, validated artifact write, successful test command, Git operation, MCP publication or final agent message. Raw reasoning deltas and repeated identical events do not reset the timer.

At 5 minutes without semantic progress the ledger records a warning. At 20 minutes the supervisor interrupts the root and writes `NO_PROGRESS_TIMEOUT`; the workflow exits non-zero. The acceptance harness uses a 1s scaled clock to test both thresholds.

## 11. Review and artifact parity

### 11.1 Review scheduler

`src/codex/review-runner.ts` replaces `opencode/plugin/ultra-review-runner.ts` with the same frozen contract:

- maximum 10 active children;
- maximum 200 tasks in one batch;
- 30 minute per-child deadline;
- roles: finder, verifier, refuter, reproducer, adjudicator, completeness;
- no nested delegation for leaf reviewers;
- no GitHub publication from leaf reviewers;
- parent cancellation interrupts queued and active children;
- every result is `completed`, `timed_out` or `failed` with reason and session id.

Native v2 is used when the capability gate passes. Explicit child mode uses the same task schema and result schema, so finalizer behavior is identical in both modes.

### 11.2 Artifact path and ledger contracts

The following paths and schemas remain stable:

```text
${BOT_WORKDIR}/ctx/review-manifest.json
${BOT_WORKDIR}/ctx/review/manifest.json
${BOT_WORKDIR}/ctx/review/coverage.json
${BOT_WORKDIR}/ctx/review/candidate-ledger.json
${BOT_WORKDIR}/ctx/review/verification-ledger.json
${BOT_WORKDIR}/ctx/review/final-report.md
${BOT_WORKDIR}/ctx/reply.md
${BOT_WORKDIR}/ctx/review-finalized.json
```

`src/codex/artifacts.ts` must canonicalize paths and reject every write outside `ctx/review` or the single allowed `ctx/reply.md`. The finalizer still requires manifest hash, base/head comparison, complete coverage, five correctness passes per hunk, four verifiers per candidate, terminal findings, and three dry gap sweeps.

### 11.3 Plan guard

`ctx/plan.md` is the only planner write path. On compaction or parent resume:

1. supervisor injects the absolute plan path into the next prompt;
2. root must read the complete file before any action;
3. a missing or unreadable plan is a terminal planning failure;
4. the plan path and digest are recorded in the run manifest.

This replaces `experimental.session.compacting` and does not depend on an OpenCode hook.

## 12. Token, usage and tracing ledger

### 12.1 Two usage layers

The ledger distinguishes:

1. `raw_completion_usage`: one upstream response completion, never replayed or estimated;
2. `thread_cumulative_usage`: Codex accumulated usage for a thread, used for progress and quota display.

Each record contains:

```text
run_id, attempt_id, thread_id, parent_thread_id, child_id, turn_id,
provider, model, started_at, completed_at,
input_tokens, cached_input_tokens, cache_write_input_tokens,
output_tokens, reasoning_output_tokens, total_tokens,
codex_rollout_budget_units, source_event, source_offset, is_replay
```

### 12.2 Deduplication rules

- A raw completion is unique by `(billing_scope_id, thread_id, turn_id, response_id)`.
  One Codex turn may contain multiple upstream response completions during tool
  loops; distinct response ids are billed independently.
- A JSONL `turn.completed` usage event is unique by `(attempt_id, turn_id)`.
- A replayed `thread/tokenUsage/updated` event updates the cumulative snapshot but never adds a billable row.
- Root and child rows are separate. A parent total is not added again when child rows are present.
- Missing fields are `null` or zero according to the Codex schema, never guessed from text length.
- Pricing is applied only after the ledger has passed deduplication.

### 12.3 Token anomaly controls

The supervisor emits `TOKEN_ANOMALY` when:

- input tokens exceed configured context window;
- the same `(thread_id, turn_id, response_id)` reappears with changed terminal
  usage, or one response id is attributed to multiple billable scopes;
- child usage appears in both parent and child billable scopes;
- a prompt baseline exceeds 16,000 input tokens in the isolated smoke;
- usage jumps by more than 3x the previous turn without a context/artifact reason.

An anomaly blocks final success for acceptance and production until it is classified as provider-reported or an implementation error.

## 13. File-by-file implementation path

本节保留迁移执行时的 locked imperative plan,用于审计实现与原计划的
对应关系;其中 `Add`, `Implement`, `Replace`, `Remove` 等命令式措辞是历史
执行步骤,不是当前待办。当前完成状态以第 18 节和 CI acceptance evidence
为准。

### Phase A: contract and fixtures

1. Add `tests/codex/fixtures` for normal completion, malformed JSONL, child spawn, child completion, child timeout, parent dead, missing result, no progress, duplicate usage and MCP required failure.
2. Freeze the current route/prompt and review artifact snapshots.
3. Add `src/codex/types.ts` with strict discriminated unions; reject unknown event and ledger fields.
4. Add `scripts/codex-capability-smoke.sh` and a fake Codex binary fixture for deterministic lifecycle tests.

Exit gate: fixtures prove every terminal state and every required ledger field before workflow changes begin.

### Phase B: installation and isolated configuration

1. Add `scripts/install-codex.sh` with an engine-owned pinned version constant, SHA256 verification, architecture mapping and `codex --version` assertion;不得增加 caller input/variable。
2. Replace the OpenCode install block in `.github/workflows/run.yml:158-182` with the pinned Codex installer.
3. Add `src/codex/caller-contract.ts` to read the existing inputs/env/secrets contract without renaming or new required values.
4. Add `src/codex/providers.ts` and strict caller JSON validation described in section 5.
5. Add `src/codex/provider-bridge.ts` with all three existing format adapters and the Responses passthrough fast path.
6. Add `src/codex/config.ts` to create `CODEX_HOME`, trusted agents, local bridge provider entries, MCP entries, sandbox/approval values and feature flags.
7. Add `codex/agents/*.toml`, `codex/prompts/*.md`, `codex/schemas/*.json`.
8. Extend `scripts/compact-prompt.sh` only to preserve Codex plan path, not to change prompt content.

Exit gate: the unmodified actual caller workflow and redacted production-shape fixture generate a valid Codex config;config smoke proves isolated config, strict schema, provider binding, all three format adapters, secret absence, agent role values and MCP transport validation.

### Phase C: protocol and supervisor

1. Implement `src/codex/app-server.ts` from the checked-in app-server protocol fixtures.
2. Implement `src/codex/exec-adapter.ts` for JSONL compatibility.
3. Implement `src/codex/events.ts` and normalize both transports to `CchpEvent`.
4. Implement `src/codex/graph.ts`, `src/codex/deadlines.ts` and `src/codex/supervisor.ts`.
5. Implement process-group lifecycle and signal escalation.
6. Persist state after every transition and fsync terminal manifest before exit.

Exit gate: integration tests pass normal, failed, interrupted, timeout, child loss and parent resume scenarios with deterministic fake time.

### Phase D: multi-agent v2 and fallback

1. Add v2 config and trusted role TOML, including run-scoped `default` and `worker` overrides plus internal main/small leaf model aliases.
2. Add capability gate and store its JSON report in `ctx/codex/capability.json`.
3. Implement native v2 event/graph adapter.
4. Implement explicit child adapter for all five operations in section 8.3.
5. Implement bounded concurrency with global root/session cap 10 for review, never relying solely on Codex default 11.
6. Implement parent resume envelope and missing-result reconciliation.
7. Reject non-root native spawns before admission/graph mutation and prove rejected descendants cannot create graph or review-admission records.
8. Record the real tool catalog of a native child and fail the capability gate if any collaboration tool is exposed.

Exit gate: every v2 operation and every fallback operation has a success, timeout, interrupt and lost-child test; root collaboration remains functional, every child is capability-isolated as a leaf, and supervisor recovery fails closed on any non-root spawn evidence.

### Phase E: progress, usage, review and security

1. Implement TODO import and root-only sticky progress.
2. Implement no-progress warning/termination.
3. Implement usage ledger and pricing boundary.
4. Port Ultra review scheduler and artifact guard.
5. Port plan guard and context index MCP.
6. Reconnect `src/mcp/server.ts`, GH wrapper and token sidecar under Codex env allow-list.
7. Implement auto-approve kill switch and final verdict adapter.

Exit gate: review finalizer accepts a Codex-generated artifact set and rejects each incomplete or forged fixture.

### Phase F: workflow cutover and deletion

1. Replace `scripts/run.sh` invocation in `.github/workflows/run.yml` with `scripts/run-codex.sh`.
2. Keep external scan and cleanup steps in the same order.
3. Add workflow env for pinned Codex version, whole-run deadline, child deadline, no-progress deadline and isolated `CODEX_HOME`.
4. Add CI jobs for Codex binary smoke, fake protocol integration and the complete pre-cutover acceptance matrix.
5. Run fixture parity inside CI without executing the old and new engines concurrently on a live GitHub event;compare route,prompt,artifact,exit and usage contracts offline.
6. After every route task passes the pre-cutover matrix,publish one engine release and move `latest` once;the actual caller remains unchanged and all tasks switch together.
7. Remove OpenCode installation, `OPENCODE_*` env, `opencode/` plugins, OMo installation/config and OMo-specific flags only after the deletion gate passes.

## 14. Test matrix

### 14.1 Unit tests

- exact snapshot of the 7 workflow inputs, 5 reusable secrets and 6 caller variables,including defaults/required flags;
- unchanged caller env -> `NormalizedCallerContract` parsing;
- provider-key sanitizer parity and collision rejection;
- provider JSON -> Codex TOML mapping and unsupported provider rejection;
- Responses passthrough request/SSE/error/usage parity;
- OpenAI-compatible request/tool/stream/usage -> Responses conversion;
- Anthropic Messages request/tool/image/reasoning/stream/usage -> Responses conversion;
- `upstream_id`, `context`, `output`, `vision`, `reasoning`, `compact_threshold` mapping;
- main/small model using same and different providers;
- extra instructions file/URL ordering,hash,size,timeout and malformed-array fallback;
- strict config unknown-field and project denylist behavior;
- sandbox/approval/fork permission matrix;
- MCP stdio/HTTP mutual exclusion, required startup semantics, allow/deny tools, env source and credential namespace;
- JSONL framing and every event variant;
- app-server JSON-RPC correlation, reconnect and unknown notification handling;
- graph idempotence, stable ordering, Open/Closed edges and descendants;
- deadline clock, interrupt escalation and no-progress detection;
- TODO merge/root-only filtering and sticky rendering;
- raw/cumulative usage deduplication and token anomaly detection;
- artifact canonicalization and review finalizer input validation;
- context index bounded output and path restrictions;
- exit code mapping.

### 14.2 Contract tests against the pinned Codex binary

- run the checked-in `claude-code-hub-plus` caller fixture without editing its `with`, `secrets` or variable names;
- parse the live production provider shape after redaction and generate the exact Codex local-provider TOML;
- prove no `OPENAI_API_KEY`, `CODEX_API_KEY`, new Codex secret or Codex workflow input is required;
- `codex exec --json` emits parseable JSONL and terminal event;
- `thread.started` and `turn.completed` appear exactly once per successful attempt;
- `--output-last-message` contains only successful final agent message;
- `--output-schema` rejects invalid schema and returns structured JSON text;
- `resume --last` appends without duplicate usage;
- required MCP failure exits non-zero;
- approval request in headless mode is rejected and does not hang;
- `multi_agent_v2` tools are present under the configured namespace;
- `wait_agent=false` removes only the wait tool;
- app-server emits token usage and collab lifecycle notifications;
- `turn/interrupt` reaches terminal interrupted state.

### 14.3 Supervisor integration tests

Use a fake Codex server and a real pinned Codex smoke:

1. root success runs finalizer;
2. root failure skips finalizer and exits mapped non-zero;
3. child success wakes parent once;
4. child timeout interrupts and closes edge;
5. missing child result becomes `LOST` and parent receives failure envelope;
6. parent dead does not keep child alive;
7. parent resume disconnect is retried once then fails within 120s;
8. no progress warns at 300s and terminates at 1200s;
9. whole run is killed by 43200s + 30s;
10. duplicate usage is not double counted;
11. progress comment failure does not change local run result;
12. finalizer rejection changes a successful Codex exit to non-zero;
13. fork review cannot write code or access private key;
14. same-repo implementer can write only the clone and `ctx`;
15. child process environment contains only approved variables;
16. Codex root/child environment never contains `CCHP_BOT_PROVIDER_KEYS`, `CCHP_PK_*`,App private key or upstream bearer tokens;only the per-run loopback bridge token is present.

### 14.4 Review and artifact tests

- 10 concurrent tasks run, 11th waits, 30-minute deadline is enforced;
- 200-task upper bound and invalid task schema rejection;
- leaf child cannot call nested task, bash or GitHub publication tools;
- five correctness passes, four verifiers, terminal verdict and three gap sweeps are required;
- artifact writes outside `ctx/review` are rejected, including symlink traversal;
- stale or missing manifest hash blocks finalizer;
- `CCHP_DISABLE_AUTO_APPROVE` changes APPROVE to COMMENT and never the reverse.

### 14.5 CI and runner tests

The existing gates remain mandatory:

```text
bun test
bunx tsc --noEmit
bash scripts/compact-prompt.test.sh
bash scripts/external-scan.test.sh
actionlint
zizmor(min-severity=medium)
```

Add:

```text
bash scripts/codex-capability-smoke.sh
bun test tests/codex/*.test.ts
bash scripts/codex-child-fixture.sh --all
```

The pre-cutover acceptance matrix must cover at least one task for every route task, same-repo and fork PR, read-only and writable mode, all provider mappings, child v2 pass and explicit fallback.

## 15. Exact acceptance gates

The migration is accepted only when all gates below are true. A skipped gate is a failed migration.

### Gate A: binary and configuration

- pinned version is logged and matches the approved SHA;
- the actual caller workflow can invoke the migrated reusable workflow without any file,variable or secret change;
- all 7 existing inputs preserve name,type,required/default and trim/fallback behavior;
- all 5 reusable secret names and caller mappings remain byte-for-byte unchanged;
- all existing `CCHP_BOT_*` variable names and JSON value shapes are accepted directly;
- no new required caller input,variable or secret exists;
- `CCHP_BOT_PROVIDER_KEYS` remains one JSON object and is never split into per-provider caller secrets;
- original provider keys are parsed directly but are visible only to provider bridge,never to Codex root/child;
- `CCHP_BOT_OPENCODE_VERSION` remains an ignored legacy no-op and is not reused as a Codex version control;
- no run reads user config or untrusted project provider settings;
- strict config rejects unknown fields;
- no private key, API key or full GitHub token occurs in config, env capture, event logs or artifacts;
- `GH_TOKEN` scope exactly mirrors base/write route decision;
- `CODEX_HOME/auth.json`, when present, is mode `0600`;
- unsupported provider format and missing model binding fail before model launch.
- `openai-responses`, `openai-compatible` and `anthropic` caller formats all complete their protocol bridge contract tests;
- the live production-shape `openai-responses` fixture uses the passthrough fast path and preserves model,context,output and vision behavior.

### Gate B: execution lifecycle

- every successful run has one `thread.started` and one terminal turn event;
- every failed/interrupted/timeout run has a persisted terminal supervisor state;
- no process survives beyond configured deadline plus 30s;
- SIGINT/interrupt is attempted before TERM/KILL;
- a child cannot remain Open after its process/thread is terminal;
- missing result and dead parent are visible as explicit failure states.

### Gate C: multi-agent behavior

- native v2 capability gate passes the live catalog/isolation checks in section 8.1 and the deterministic dead-parent/process-group checks in the pre-cutover matrix, or the explicit child adapter is selected and its full contract passes;
- root and child concurrency never exceed 10 review workers;
- spawn, send, followup, wait and interrupt each have a native-v2 and explicit test; explicit `close_agent` and native interrupt+wait close equivalence each have a real test;
- parent wake is delivered exactly once for one child terminal result;
- no child result is accepted without terminal status and schema-valid result artifact;
- reviewer child has no write, nested task, shell or GitHub publication path.

### Gate D: progress and TODO

- root TODO list is visible in `ctx/codex/todo.json`;
- sticky progress is updated at least every 60s while the run is live;
- a 5-minute silent fixture produces a warning;
- a 20-minute silent fixture terminates non-zero with `NO_PROGRESS_TIMEOUT`;
- child TODO changes never overwrite root TODO;
- GitHub publish failure does not erase local progress evidence.

### Gate E: usage and cost

- root and each child have distinct ledger scopes;
- no request-level/attempt-level or replay double counting exists in fixture and acceptance runs;
- all five JSONL usage dimensions are persisted, plus calculated `total_tokens`;
- raw completion and cumulative snapshots are distinguishable;
- isolated two-word smoke input is at most 16,000 input tokens;
- a 3x usage jump is blocked and reported as `TOKEN_ANOMALY` until classified.

### Gate F: review and release

- finalizer passes on a complete Codex artifact fixture;
- finalizer rejects missing coverage, bad hash, incomplete verification and forged terminal verdict;
- successful Codex exit followed by finalizer rejection returns non-zero;
- all existing review comments, labels, merge and auto-approve semantics remain unchanged;
- existing Bun/shell/actionlint/zizmor CI is green;
- the complete pre-cutover acceptance matrix is green for every route task before moving `latest` and removing OpenCode.

### Gate G: removal

Gate G is implemented by:

```bash
bash scripts/codex-removal-gate.test.sh
bash scripts/codex-removal-gate.sh
```

The gate performs a case-insensitive scan of production code and live operator
docs. It removes only the exact ignored `CCHP_BOT_OPENCODE_VERSION` token before
scanning, so no file or line receives a broad exception. Historical migration
provenance and the vendored parity corpus are explicit non-production surfaces.
It also asserts that the old runtime directory/scripts and legacy finalizer
wiring remain deleted. Both the gate behavior test and the real-repository gate
run in CI.

## 16. Rollout, rollback and observability

### 16.1 Historical pre-cutover acceptance and one-step cutover sequence

1. 在 engine repo 内使用 caller workflow snapshot、redacted live provider-shape fixture 和 mock secrets 完成全事件矩阵 E2E,不要求 caller 增加 feature flag。
2. 在隔离 acceptance repository 使用与生产 caller 完全相同的 `uses`, `with`, `secrets` mapping 和 variable names,覆盖 read-only/write,fork/same-repo,review/implementation。
3. 对 `openai-responses`, `openai-compatible`, `anthropic` bridge 分别执行真实 Codex CLI contract run。
4. 所有 Gate A-F 通过后,发布新的 engine release并一次性移动 `latest` tag,实际 caller 文件保持不变。
5. 首批真实事件必须覆盖 manual dispatch,engage,ci_fix,roadmap,review,merge/reaction;任何异常通过 engine ref rollback,不在 caller 增加 Codex-specific configuration。
6. 稳定后执行 Gate G;原 production path 已删除,当前由 Gate G 防止回归。

### 16.2 Rollback

Rollback is a workflow reference switch to the last released CCHP automation
ref, not a runtime guess. It never restores an in-tree legacy runtime and never
runs two engines concurrently for the same event. Rollback evidence must include
run id, route task, Codex version, supervisor state, child graph, usage ledger
and finalizer result.

Rollback 不修改 caller variables、secrets 或 provider JSON。只允许把 `uses: ...@latest` 临时切到上一个 engine tag/SHA,或由 engine owner 回移 `latest`。

本次 cutover 的 pre-migration rollback baseline 记录为
`6137a675bf628baaf16ca67bcbab4ccbfcbf90d5`。发布后若需回退,应优先把
consumer 的 reusable-workflow ref 指回以该 baseline 为祖先的最后一个已发布
engine tag/SHA,而不是恢复已删除的 in-tree legacy runtime。

### 16.3 Required observability fields

Every run log and final manifest records:

```text
run_id, task, repository, pr_or_issue, base_sha, head_sha,
codex_version, codex_source_sha, adapter_mode, v2_gate,
root_thread_id, child_ids, process_group_id,
started_at, ended_at, terminal_state, exit_code,
last_event_at, last_semantic_progress_at,
root_usage, child_usage, token_anomalies,
finalizer_state, cleanup_state
```

## 17. Documentation and configuration updates

Implemented and updated:

- `README.md`: Codex runtime prerequisites, provider variables, deadlines and local smoke commands;
- `docs/ci/codex-cli-full-migration-plan.md`: this locked plan and implementation status table;
- `docs/ci/agent-toolchain.md`: replace OpenCode/OMo setup with Codex config, MCP and role TOML;
- `.github/workflows/run.yml`: pinned Codex inputs and least-privilege env;
- `.github/workflows/ci.yml`: new contract and capability gates;
- consumer integration documentation: exact `CCHP_BOT_PROVIDERS`, `CCHP_BOT_MODEL`, provider-key and Codex version contract.

Consumer documentation must state: callers continue using the existing inputs, `CCHP_BOT_*` variables and five secrets;Codex config is generated only inside the reusable workflow。不得向 consumer 文档增加 Codex-native TOML、`OPENAI_API_KEY` 或 new secret setup steps。

No documentation may instruct users to install OpenCode or OMo after Gate G.

## 18. Completion checklist

Final implementation evidence captured on 2026-08-06:

- real registry install: `@openai/codex` `0.146.0`, source tag
  `rust-v0.146.0`, source commit
  `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`, wrapper SHA-256
  `8050af14387e23b8d46026f023f0c1d33a2eefb39267bf36abe8cec2cec17b49`,
  Linux x64 native SHA-512
  `7ecc2fc86a6b00f08c88e12e7bfecc28c93ba428e1f6464825f257e62f5ab667e798661b602714859b041fd2c43f4fb4b79c723ea0db7cd5d8ecd4b1215b97c4`,
  npm registry integrity and wrapper/platform SLSA provenance were verified
  against the same source tag and commit, and the engine-owned absolute binary
  reported the exact version `codex-cli 0.146.0`;
- real pinned-Codex capability run `local-20260806-capability-v4`: both
  `explicit-exec` and `native-v2` passed with eight provider requests per mode;
  both mode artifacts were validated as current-run evidence and the parent
  observed the completed child output (`parent_observed_child == true`);
- full repository validation: `bunx tsc --noEmit` passed and `bun test` passed
  `485` tests in `56` files with `2260` assertions;
- run-owned pre-cutover matrix `local-20260806-precutover-v2`: `225` focused
  tests in `24` files with `1356` assertions, typecheck, credential-sanitized
  environment preparation and restart/token-scope runtime harness all passed;
- `install-codex.test.sh`, capability/pre-cutover fail-closed wrapper tests,
  external-scan tests, removal Gate G, `actionlint`, `zizmor` and
  `git diff --check` all passed;
- the production caller contract remains `7` inputs, `5` secrets and `6`
  repository/organization variables. Its provider JSON, provider-key JSON and
  model fields are parsed directly without caller-side conversion.
- finalizer retry and crash recovery use a stable idempotency key derived from
  immutable run provenance; review attestation must echo the same key before
  terminal success is allowed;
- usage accounting accepts multiple distinct provider responses in one Codex
  turn, deduplicates and validates conflicts by response id, validates
  root/child billing lineage, keeps token-jump baselines thread-local and
  separates context input from billable input semantics;
- Gate G scans the complete `docs/` tree, README, workflow/runtime sources and
  nested package/lock manifests, with only this exact historical migration plan
  exempted from legacy terminology checks.

- [x] Codex source commit and installed binary are pinned and logged.
- [x] Isolated `CODEX_HOME` and strict trusted config are implemented.
- [x] Existing caller workflow, inputs, variables, secrets and provider JSON run without modification.
- [x] All existing provider formats map through the local Responses bridge.
- [x] Provider, auth, MCP, sandbox and approval contracts are tested.
- [x] app-server and exec adapters parse all required events.
- [x] Native multi-agent v2 gate passes and explicit child fallback is verified.
- [x] Spawn/wait/send/followup/interrupt and reconcile are implemented for native-v2; explicit fallback additionally implements close_agent.
- [x] Root/child deadlines and no-progress termination are enforced.
- [x] TODO and sticky progress are event-driven and root-only.
- [x] Usage ledger separates raw, cumulative, root and child usage.
- [x] Ultra review, leaf permissions and artifact finalizer remain compatible.
- [x] Token rotation, typed GitHub broker and fork scope are preserved.
- [x] Context-mode functionality is implemented by CCHP-owned MCP/index with sandbox parity.
- [x] Existing and new unit/integration/contract/E2E/runner tests are green.
- [x] Pre-cutover acceptance matrix is green and rollback reference is recorded.
- [x] No production legacy engine or plugin reference remains.
- [x] No unresolved `TODO`, `FIXME`, `future work`, `later pass` or `暂不实现` marker remains in the migrated runtime.

以上清单及其 run-owned evidence 均已完成。迁移实现已经完整落地;发布和
consumer workflow ref 切换属于后续 release 操作,不再需要恢复或并行保留旧 runtime。

# Junius

<p align="center">
  <img src="icon.svg" alt="Junius" width="128" height="128" />
</p>

[English](README.md) | **简体中文**

**通过 MCP 为 ChatGPT 提供本地计算机控制能力。**

Junius 是一个面向 ChatGPT 对话的本地 MCP 执行服务。它让调用它的助手能够直接访问本地 Workspace 文件、本地进程、后台 Job、浏览器自动化，以及 Windows 桌面交互能力。

> **Junius 是执行服务，不是策略引擎。**
>
> 某项操作是否合适、是否具有破坏性、是否符合用户意图，由用户和调用 Junius 的助手决定。Junius 不维护第二套命令授权系统。

Junius **不是操作系统沙箱**。由 Junius 启动的进程拥有启动 Junius 的操作系统用户所拥有的权限。

## 一行命令安装

Junius **只支持 Windows**。Linux、macOS 和其他所有操作系统都属于明确不支持的平台，Junius 的运行入口会直接拒绝在这些系统上启动。

用户电脑需要预先具备：

- Node.js 20+，并带有 npm/npx
- Python 3.10+

在 Windows 上通过一条 PowerShell 命令安装 Junius：

    irm https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1 | iex

GitHub Releases 是 Junius 的公开分发渠道。Bootstrap 脚本会：

- 获取最新已发布的 Junius GitHub Release，包括预发布版本；
- 下载 `junius-windows.tgz` 和 `SHA256SUMS.txt`；
- 在执行包内任何内容之前验证 Release 包的 SHA-256；
- 将验证通过的包解压到临时目录；
- 使用用户现有的 Node.js 运行时调用包内 Junius 安装器。

安装器不会下载或替换 Node 或 Python。它要求 Node.js 20 或更高版本，并查找机器上已有的兼容 Python，然后：

- 将 Junius 安装到 `%LOCALAPPDATA%\Junius\app`；
- 将包内依赖锁物化为 `npm-shrinkwrap.json`；
- 安装 Junius 的 npm 依赖，包括 Browser CLI；
- 使用用户现有 Python 创建 `%LOCALAPPDATA%\Junius\app\.venv`；
- 将 `requirements-desktop.txt` 安装到该虚拟环境；
- 运行已安装运行时的完整 Junius 验证套件；
- 将 Junius 注册到当前 Windows 用户的登录启动项；
- 立即启动 Junius，并等待 Host 健康检查通过。

正常的按用户安装路径不需要管理员提权。

安装完成后，该 Windows 用户登录时 Junius 会自动启动。当前用户的 HKCU Run 启动项会调用隐藏的 PowerShell 启动脚本，并记录安装时使用的精确 Node 可执行文件；Junius 不再依赖 VBScript/WScript 启动。Desktop helper 则使用基于用户现有 Python 创建的已安装 `.venv`。

Junius 提供内置更新功能。CLI 支持 `junius update --check` 比较当前包版本与最新已发布 GitHub Release，并通过 `junius update` 安装最新版本。已安装的 Junius 也会直接向 ChatGPT 提供 MCP 工具 `check_junius_update` 与 `update_junius`。源码测试连接不会暴露用于更新已安装副本的工具。

更新器复用安装流程已有的 GitHub Release bootstrap 与 SHA-256 校验。CLI 在 Junius 外部执行更新时，会停止并重启已安装 Host，使新版本立即生效；通过 MCP 自更新时不会杀掉自己的活动工具调用，而是完成安装与验证后返回 `restartRequired: true`，随后需要重启 Junius 才能激活新版本。原来的一行 PowerShell 安装命令仍然可以继续作为原地更新方式。

Host 只使用一个回环 HTTP 监听器：

    http://127.0.0.1:8787

路由如下：

    MCP:        /mcp
    Health:     /__junius/host-health
    Supervisor: /__junius/supervisor

没有单独的 Host 控制端口，也没有管理界面。

## 可用范围与分发模式

Junius 刻意定位为**仅支持 Windows 的个人/本地 MCP 产品**，而不是公开插件目录中的插件。

Junius 的产品支持范围是 **ChatGPT Plus 及以上**。它围绕付费 ChatGPT 的使用方式设计：用户能够在 Developer mode 中自行创建个人 MCP 连接，并使用足够强的模型与 Junius 所需要的 MCP 工具表面完成开放式本地执行。Free 和 Go 不属于 Junius 的目标套餐。项目不会仅仅为了兼容这些套餐而增加降级的只读路径、受限权限兼容层，或专门针对低能力模型的交互方案。

这是 Junius 自己的支持政策，并不意味着 OpenAI 的套餐、模型、Developer mode 权限或 MCP 权限永远不会变化。OpenAI 的产品可用性可以独立于 Junius 调整；实际连接时应以当时最新的 OpenAI 开发者文档为准。

### 为什么 Junius 不进入公开插件目录

Junius **不会**提交到公开的 ChatGPT/Codex 插件目录。

它预期的部署方式就是：

1. 在你自己的 Windows 电脑上安装并运行 Junius；
2. Junius MCP Server 继续只监听本机回环地址；
3. 由你自己创建 OpenAI Secure MCP Tunnel，并且只连接到精确的 `/mcp` 端点；
4. 在 ChatGPT Developer mode 中创建**个人** MCP/插件连接；
5. 只用这个连接控制你明确选择暴露的这台本地电脑。

公开插件目录并不适合 Junius，原因包括：

- **Junius 没有一个所有用户共用的托管服务。** 每个 Junius 实例都属于某一台用户自己的电脑，并以启动 Junius 的本地操作系统用户权限执行。
- **连接天然是私有且绑定具体机器的。** Tunnel ID、运行时凭据、本地路径、Workspace、Browser 状态和 Desktop 访问权都属于拥有这台机器的用户。
- **Junius 不应该把 Host 直接暴露到公网。** Host 始终只监听 loopback；只有精确的 `/mcp` 路由通过用户自己的 Secure MCP Tunnel 暴露给 ChatGPT，旁边的诊断路由仍然只留在本机。
- **“被发现”不是这个产品的使用入口。** 用户先获得并安装 Junius 本地程序，再明确创建自己的个人 MCP 连接；公开目录发现并不会给这条流程增加实际价值。
- **公开目录会制造错误预期。** 安装一个目录条目本身无法替用户把 Junius 安装到 PC、启动本地 Host、创建 Tunnel，也不能自动取得这台电脑的控制能力。这些动作必须由用户明确完成并掌握。
- **Junius 没必要为了扩大目录覆盖面承担最低套餐兼容成本。** 项目支持基线就是 Plus 及以上，因此可以围绕足够强的模型和完整的目标 MCP 执行工作流设计，而不是维护 Free/Go 的 fallback 行为。

GitHub Releases 仍然是 Junius 的**公开软件分发渠道**。这和“把 Junius 发布成公开 ChatGPT/Codex 插件”是两回事：Release 用于分发本地程序；ChatGPT 里的连接始终由用户自己创建并保持为个人连接。

## 将 Junius 连接到 ChatGPT

GitHub Release 安装器负责安装并启动本地 Junius 服务。它**不会**替你创建 OpenAI Secure MCP Tunnel，也不会自动配置 ChatGPT 插件连接。

ChatGPT 无法直接连接仅监听回环地址的 MCP 服务器。对于本地 Junius 安装，请使用 OpenAI Secure MCP Tunnel：

1. 在 OpenAI Platform 的 Tunnel 设置中创建或选择一个 Tunnel。
2. 在同一台 Windows 电脑上安装并配置当前版本的 OpenAI `tunnel-client`。
3. 将该 Tunnel 配置精确指向 Junius MCP URL：

       http://127.0.0.1:8787/mcp

4. 针对该配置运行 `tunnel-client doctor`，确认状态健康。
5. 使用 Junius 期间保持 `tunnel-client run` 运行。
6. 在 ChatGPT 中打开 **Plugins**，点击加号，在 Developer mode 下添加 MCP 连接。
7. 连接类型选择 **Tunnel**，然后选择对应的 Secure MCP Tunnel。
8. 检查发现的 Junius 工具，并创建个人插件连接。

不要把 Tunnel 指向裸的 `http://127.0.0.1:8787` 源地址。与 MCP 共用端口的 `/__junius/*` 路由属于本地运行诊断接口，不属于公开 MCP 表面。

Secure MCP Tunnel 的配置需要相应的 OpenAI Platform Tunnel 权限、Tunnel ID 和运行时 API Key。这些属于 OpenAI 账户/Workspace 资源，Junius 安装器刻意不会收集或保存它们。

当前 OpenAI 开发者文档：

- ChatGPT 开发者平台概览：https://developers.openai.com/chatgpt
- Plugins 快速开始：https://developers.openai.com/plugins/quickstart
- 连接并测试插件：https://developers.openai.com/plugins/deploy/connect-chatgpt
- Secure MCP Tunnel：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

Junius 自己的支持基线从 ChatGPT Plus 开始。实际用于 Junius 的账户或 Workspace 必须具备上述工作流所需要的 Developer mode、Secure MCP Tunnel，以及 MCP 读写能力。OpenAI 可以独立调整套餐权限、模型可用性、界面和 Workspace 策略，而且不同官方文档在功能逐步上线期间也可能描述不同的可用状态。因此实际配置时，应以该账户当前真正具备的能力和最新 OpenAI Developers 文档为准。如果这些能力不存在，Junius 不会再额外维护 Free/Go 的降级 fallback。

## MCP 接口

    load_junius_contracts(modes)

    list_workspaces()
    create_workspace(id, root_path)
    delete_workspace(id)

    ls(workspace, ...)
    read(workspace, ...)
    write(workspace, ...)
    workspace_apply(workspace, files, verify)
    rg(workspace, ...)
    workspace_batch(workspace, operations)

    run_command(workspace, executable, args)

    start_job(workspace, executable, args)
    get_job(job)
    wait_job(job, timeout_ms)
    read_job_output(job, stream, offset, limit)
    cancel_job(job)

    playwright_cli(session, command, args)

    desktop(session, command, ...)

Junius 没有管理 Web 界面。Workspace 的创建、删除与检查，命令执行、Job、浏览器控制和桌面控制，都设计为直接通过 ChatGPT 对话驱动。

## 注入式运行契约

Junius 使用 MCP 原生 instructions 机制向 ChatGPT 提供执行契约。

Core Operating Contract 会通过 MCP 初始化结果中的 `instructions` 字段发送。Core 只包含跨任务通用的 Junius 行为规则：用户明确约束、真实状态汇报、已确认问题的真实路径处理、指令优先级、Workspace/AGENTS.md 语义、进程和 Job 语义、验证、清理，以及最终约束收敛。

体积较大的任务专用行为不会全部塞入 Core。Junius 将它们拆成三个独立契约：

- `engineering` —— 软件工程决策边界、复用优先、禁止无依据的兼容和没必要的机制、Bug 复现与 RED → GREEN、相关结构收敛、真实表面 QA、Git 纪律和最终工程审查；
- `desktop` —— 仅基于截图的桌面 Computer Use、控制生命周期、坐标语义、包括 `key_macro` 和 `action_batch` 在内的原语选择、操作后观察验证和清理；
- `browser` —— 不受 Junius 命令白名单限制的 Playwright CLI 表面、浏览器会话连续性、依赖当前状态的引用、操作后观察验证和会话清理。

ChatGPT 只加载当前任务真正需要的模式：

    load_junius_contracts(
      modes = ["engineering"]
    )

需要多个模式时：

    load_junius_contracts(
      modes = ["engineering", "browser"]
    )

结果首先返回 mode/digest 元数据，随后将每个选中的契约作为独立的原始 Markdown 文本块返回。重复模式会去重，同时保留首次请求的顺序。

Core 契约要求：进行实质性软件工程工作前先加载 Engineering 契约；在某个任务中第一次调用 `desktop` 前先加载 Desktop 契约；第一次调用 `playwright_cli` 前先加载 Browser 契约。

这些契约用于约束调用 Junius 的助手，而不是可执行的授权规则，也不会重新引入 Junius 自己的命令/能力策略层。现有 AGENTS.md 修改前预检仍是内置文件工具的一套独立机制。

### 自定义 Junius 提示词

运行契约不再硬编码在 TypeScript 中。Junius 会从仓库的 `prompts/` 目录读取 UTF-8 Markdown：

- `prompts/core.md` —— 通过 MCP `instructions` 发送的 Core Operating Contract；
- `prompts/engineering.md` —— 软件工程工作模式；
- `prompts/desktop.md` —— Desktop Computer Use 契约；
- `prompts/browser.md` —— Browser Computer Use 契约。

仓库里的 `prompts/*.md` 是随 Junius 版本管理的默认提示词。它们会被纳入源码指纹、last-known-good 快照、Release 包和常规源码验证；从源码开发 Junius 时，直接修改这些文件就是修改产品默认值，并继续走正常的验证后 Worker 重载路径。

安装后的默认提示词位于 `%LOCALAPPDATA%\Junius\app\prompts`，更新时可以由新版 Release 替换。用户长期自定义则存放在应用目录之外的 `%LOCALAPPDATA%\Junius\prompts`；更新不会覆盖这个目录，并且同名用户提示词优先于已安装版本的默认提示词。从旧安装第一次升级时，安装器会在替换默认目录之前保守地把旧 `app\prompts` 文件复制进持久覆盖目录；如果某个持久覆盖已经存在，迁移绝不会覆盖它。

ChatGPT 可以直接通过 `get_junius_prompts`、`set_junius_prompt` 和 `reset_junius_prompt` 读取、修改和重置这些持久覆盖。重置后会自动回到当前已安装 Junius 版本提供的默认提示词。Engineering/Desktop/Browser 提示词会在下一次 `load_junius_contracts` 时生效；Core 提示词会用于新初始化的 MCP 会话，因为已经初始化的会话会保留初始化时收到的 Core instructions。

## 从源码开发

仓库开发使用 pnpm 12.6.0：

    pnpm install
    pnpm dev

`pnpm dev` 会在 `127.0.0.1:18787` 启动一个仅供 Junius 源码开发者测试当前源码的实例。这不是另一个 Junius 产品版本，普通安装用户也不需要在“开发版”和“正式版”之间做选择；通过 Release 安装的就是 **Junius**，使用 `127.0.0.1:8787`。源码测试连接会标识为 **Junius (Source Test)**，只用于当前请求明确要求测试、运行、验证或调试源码构建的场景。普通 Junius 工作——包括只修改仓库而不测试源码实例——仍使用已安装的 Junius。

`pnpm start` 保留普通 launcher 行为和默认 `8787` 端口；`pnpm dev` 只是源码测试入口。

构建 Release 资产：

    npm run release:build

这会生成 `dist/junius-windows.tgz`、`dist/SHA256SUMS.txt`、`dist/install.ps1` 和 `dist/release.json`。Release 说明以 `CHANGELOG.md` 为唯一内容来源：打 tag 前必须存在精确的 `## <package.version>` 小节，GitHub Release 正文只写该小节的正文。

一行安装器不要求用户系统里安装 pnpm。npm 仅作为经过验证的 Junius 应用包内部的依赖安装器使用；npm registry 不是 Junius 的公开分发渠道。

## 高层工程工具

Junius 保留底层执行原语，同时为常见工程流程提供减少 MCP 往返的高层等价能力：

- `workspace_patch` 可一次事务性应用标准多文件 unified diff，继续遵守 Workspace 路径保护和 AGENTS.md 确认，并可在同一调用中验证结果。
- `run_commands` 可在同一个 Workspace 中一次执行最多 16 条短命令，支持并行或串行，并继续复用 `run_command` 的无限制执行路径。
- `git_snapshot` 一次返回 branch/status、已暂存与未暂存摘要以及最近提交。
- `git_prepare_commit` 只暂存显式指定的路径，检查 staged diff，并返回完整 staged diff 和用于审核的 Git tree token。
- `git_commit` 只有在当前 staged tree 仍与审核过的 token 完全一致时才会提交；它永远不会 push。

长时间运行的命令仍使用 Jobs。这些工具只是执行层便利能力，不会把 Junius 变成自动决定工程流程的策略引擎。

## 以对话为中心的工作区管理

Workspace 被刻意设计得很小：

    Workspace
    = 稳定 ID
    + 规范化本地根路径

它没有命令权限、可执行文件注册表或参数规则。

通过 ChatGPT 创建 Workspace：

    create_workspace(
      id = "weave",
      root_path = "C:\Projects\Weave"
    )

查看所有 Workspace：

    list_workspaces()

删除一个 Workspace 注册：

    delete_workspace(id = "weave")

`delete_workspace` 只删除 Junius 中的注册信息，绝不会删除对应目录或目录里的文件。

Workspace 注册状态持久化在仓库之外：

    %LOCALAPPDATA%\Junius\workspace-state.json

可通过 `JUNIUS_WORKSPACE_STATE_PATH` 覆盖默认路径。

迁移时仍接受包含旧授权字段的历史 Workspace 状态；这些字段会被忽略，之后重新写出的状态只使用当前的根路径模型。

## 命令执行

`run_command` 可以启动任意可执行文件，并传入任意参数向量：

    run_command(
      workspace,
      executable,
      args
    )

示例：

    run_command(
      workspace = "default",
      executable = "git",
      args = ["status", "--short", "--branch"]
    )

Junius 不要求事先注册可执行文件，也不会应用参数白名单。

所选 Workspace 决定子进程工作目录：

    cwd = Workspace root

执行使用直接进程生成，并明确关闭 shell：

    child_process.spawn(executable, args, {
      cwd,
      shell: false
    })

如果确实需要 shell 语义，调用方可以显式启动 Windows 的 `cmd.exe` 或 PowerShell，并传入该 shell 的参数。Junius 不会为了判断安全性或意图去解析命令字符串。

同步执行保留以下运行时工程边界：

- 捕获输出有上限；
- 执行时间有上限；
- 返回 stdout/stderr 和退出诊断；
- 强制停止时终止进程树；
- Windows 下通过 `taskkill /T /F` 终止后代进程。

这些属于执行完整性控制，而不是命令授权规则。

## 后台任务

长时间运行的命令使用相同的可执行文件模型：

    start_job(workspace, executable, args)

返回的 Job ID 可用于 `get_job`、`wait_job`、`read_job_output` 和 `cancel_job`。

Job 保留：

- 有上限的 stdout/stderr 捕获；
- 持久化终态历史；
- 取消能力；
- 运行期间的 Worker 所有权和亲和性；
- Windows 下通过 guardian 路径和 Job Object 实现的崩溃收容；
- Worker 或 Host 消失时的中断 Job 恢复。

当前 Job 历史写入使用以 executable 为核心的 v2 schema。历史 v1 记录中保存的 command key 仍可以读取并会被规范化。

终态 Job 历史默认保留 7 天。默认只按时间保留，不设置默认条数上限，因此 Job 数量增加不会让尚未过期的历史提前被淘汰。`JUNIUS_JOB_HISTORY_MAX_AGE_MS` 可以覆盖保留时长，`JUNIUS_JOB_HISTORY_MAX_ENTRIES` 可以额外设置明确的条数上限。Job 捕获的 stdout/stderr 属于历史数据，会随过期 Job 记录一起删除。

## 工作区文件工具

内置文件工具与进程执行刻意采用不同模型。它们使用 Workspace 相对路径，并实现自己的路径包含边界。

重要特性包括：

- 拒绝绝对路径和 `..` 穿越；
- 读取不会沿链接逃出 Workspace；
- 写入拒绝符号链接/junction 父目录别名；
- 事务式多文件写入先 stage，再 commit；提交失败时尝试反向回滚；
- commit 前后重新验证写入父目录，以缩小路径替换竞态窗口；
- 根目录 `.junius` 控制目录被保留；
- `.git` 元数据不能通过通用 Workspace 文件工具访问；
- 如果 Junius 运行时/状态路径和 Browser profile 路径位于 Workspace 内，它们也会受到保护；
- `rg` 不能通过后续 include glob 重新启用受保护路径。

### AGENTS.md 行为

Workspace 检查对 AGENTS.md 采用类似 Codex 的目录作用域规则：

- 一个 AGENTS.md 作用于其所在目录及整个子树；
- 更深层的 AGENTS.md 在指令链中排在更后面，因此在更窄的作用域中具有更具体的约束；
- `ls`、`read`、`rg` 和 `workspace_batch` 会自动返回适用的 AGENTS.md 内容、每份文件的作用域以及 SHA-256 digest；
- 递归扫描还会发现扫描子树中的嵌套 AGENTS.md；
- `write` 和 `workspace_apply` 会执行强制 AGENTS.md 预检。如果存在适用指令，而调用方没有提供当前 `agents_digest`，Junius 会在修改文件前拒绝写入，并返回完整适用指令链和 digest；
- 如果适用的 AGENTS.md 被修改，旧 digest 将不再能授权内置文件修改；
- 过大的 AGENTS.md 指令集合会明确失败，而不是被静默省略。

调用 Junius 的 Agent 必须将这些指令视为对应作用域内的约束。系统、开发者和用户直接给出的指令优先级仍然更高。

这些检查只适用于 Junius 内置文件工具。它们不会限制由 `run_command` 或 `start_job` 启动的可执行文件；进程执行不受 Workspace 文件工具策略限制。

## 浏览器计算机操作

Browser 访问按当前用户任务显式授权。只有当前用户请求明确要求 ChatGPT 控制浏览器时，Junius 才能调用 `playwright_cli`；这同样适用于只读检查，包括 snapshot、tab/session 列表、cookie、storage、console 和网络数据。以前任务中的授权不会延续到当前任务，加载 Browser contract 也不代表获得授权。

某个 session 的第一次 Browser 调用必须携带 `explicit_user_authorization=true`。当前任务的授权被接受后，即使某个具体 Browser 命令执行失败，同一活动 session 的后续调用也不再重复该声明。`close` 会撤销授权，并结束这次 Browser 操作生命周期。

`playwright_cli` 暴露已安装 Playwright CLI 的完整命令表面。Junius 只注入命名 session 参数：

    -s=<session>

其余请求的 command 和参数向量保持原样转发。Junius 不提供 Browser 命令白名单或逐参数策略。只要已安装的 CLI 版本支持，`eval`、`run-code`、storage/cookie 操作、网络请求检查与路由、录制/trace/video、WebMCP、attach/detach、install 命令以及未来新增的 Playwright CLI 命令都可以使用。

Browser 改为惰性启动。正常 Worker 启动和普通项目校验不会预热 Playwright broker，也不会启动 Browser Computer Use。

命名 Browser session 在 Worker 热切换过程中保持 Worker 亲和。空闲 session 数量受限，并会独立关闭。

默认情况下，Junius 管理的 Browser 数据只保留到本次 Browser 操作结束。每个 session 使用独立的管理目录；执行 `close` 时，Junius 会对该 session 调用 Playwright `delete-data`，并删除该 session 的管理目录，其中包括自动生成的 snapshot、截图、console 输出及相关 Browser 产物。用户明确要求保存到该管理目录之外的文件不视为可丢弃的 Browser 数据。

设置 `JUNIUS_BROWSER_RETAIN_DATA=1` 可以让 Junius 管理的 Browser 数据在 `close` 后继续保留。开启后，Junius 不再自动清理这些保留数据，后续检查和删除责任由用户承担。Browser 审计会记录命令标识和参数数量，但不会记录任意参数向量本身。

## Windows 桌面计算机操作

Desktop 访问按当前用户任务显式授权。只有当前用户请求明确要求 ChatGPT 控制本机时，Junius 才能调用 Desktop 工具；这同样适用于只读访问。没有当前任务授权时，不得枚举窗口、截图或读取剪贴板。以前任务中的授权不会延续到当前任务，加载 Desktop contract 也不代表获得授权。授权只能由携带 `explicit_user_authorization=true` 的成功 `control_begin` 建立；后续调用不再重复该声明，只允许同一个仍处于活动状态的 session 使用。执行 `control_end` 后，该 session 的授权立即失效。

Desktop helper 改为惰性启动：只有第一次已授权的 Desktop 调用才会启动。正常 Host/Worker 启动以及普通项目校验都不会预热或查看 Desktop。

Desktop 感知刻意只基于截图。Junius 不使用 Windows UI Automation，也不依赖 accessibility/语义控件树。获得明确授权后，它可以枚举顶层原生窗口、截取整个屏幕或单个窗口、聚焦窗口、执行基于坐标的鼠标操作、拖动、等待、发送键盘操作和宏、读写 Unicode 剪贴板文本，以及在支持的位置直接输入文本。

`action_batch` 可以在一次 helper 往返中执行最多 128 个混合 Desktop 操作。批量操作可以组合聚焦、鼠标移动/点击/按下/抬起/滚轮、拖动、等待、键盘操作/宏、剪贴板访问和文本输入。显式 wait 与 drag 的持续时间均有限制；如果批量执行失败，已按下的按键/鼠标按钮会在清理路径中释放。

对于“操作 → 观察”循环，`action_batch` 支持 `screenshot_after`。启用后，操作后的截图会在同一个 MCP 响应中返回；`screenshot_handle` 可以指定只截取某个顶层窗口，而不是整个屏幕。

Desktop 任务有显式控制生命周期：

    control_begin(session)
    → desktop actions
    → control_end(session)

整个任务必须使用同一个 session。

只要至少存在一个活动 Desktop 控制作用域，Junius 就会在本机顶部中央显示：

    ChatGPT 正通过 Junius 操作电脑

四个可穿透点击、始终置顶的屏幕边缘窗口提供呼吸灯效果。顶部和底部边缘拥有四角像素；左右边缘避开上下边缘的厚度，以防 alpha 重叠导致角落亮度异常。

这个提示会在整个控制作用域期间持续显示，而不是依赖空闲超时。helper 或 Worker 退出时会销毁这些原生窗口，作为崩溃兜底。

Desktop session 在成功 `control_end` 前保持 Worker 亲和，因此 Worker 热切换不会把可见的接管生命周期和真正执行桌面操作的 Worker 拆开。

## 主控进程 / 工作进程架构

Junius 使用稳定 Host + 可替换 Worker 的结构：

    ChatGPT
       |
       v
    127.0.0.1:8787
       |
      Host
       |
       +--> active Worker
       |
       +--> retiring Worker(s)，等待亲和资源/进行中的工作排空

Host 负责公开路由。Worker 在随机回环端口监听，并要求 Host 注入的私有 256 位令牌。

源码热重载流程：

    source change
    → 完整验证
    → 启动 candidate Worker
    → ready IPC
    → 私有健康检查
    → promote candidate
    → 保留上一 Worker 用于回滚/排空

验证失败或 candidate 启动失败时，当前 active Worker 保持不变。新 Worker promote 后如果在回滚窗口内退出，可以回退到此前仍存活的 Worker。

### 资源亲和性

进程内资源会继续留在拥有它们的 Worker 上：

- MCP session ID 在路由仍活动时保留其原 Worker；
- 正在运行的 Job 保留创建它的 Worker；
- 命名 Browser session 在 close 或空闲过期前保留其 Worker；
- Desktop 控制 session 从 `control_begin` 到成功 `control_end` 始终保留其 Worker。

Workspace 修改属于共享持久化配置。

一次成功的 `create_workspace` 或 `delete_workspace` 响应会先由 Host 暂存，直到所有其他仍存活 Worker 都重新加载了持久化 Workspace 状态后才返回给调用方。无法重新加载的 Worker 会被隔离，而不是继续使用过期注册状态。

## 最后已知良好版本启动

`pnpm dev` 和 `pnpm start` 都会进入 `scripts/host-launcher.mjs`。`--dev` 路径只是给贡献者测试源码用的 `18787` 源码测试路径；普通已安装身份始终只是 `8787` 上的 Junius。两条路径分开是为了测试源码改动时不替换已安装副本，而不是定义两个面向用户的版本。

Launcher 优先使用最后一个已验证的 bootstrap 副本。Bootstrap 会为源码/运行时控制输入生成指纹，并且只有完整验证通过后才推进 last-known-good Release。

验证失败或启动失败都不会破坏此前已验证的 Release。

最新三个 Host Release 保存在：

    .junius/runtime/releases

Host-only 变更要求手动重启 Junius，而不是自动自我重启。

## 审计

Audit 用于观察，不是授权层。

它保存有上限的元数据，例如 category/action/status、Workspace、可执行文件标识、参数数量、退出码、输出大小、持续时间，以及 Browser/Desktop 操作元数据。

它刻意不复制：

- 命令 stdout/stderr 内容；
- 任意命令的原始完整参数向量；
- 文件内容或编辑文本；
- 截图；
- Browser/Desktop 输入文本；
- 剪贴板文本。

Browser 导航审计会移除 query/hash。

Audit 持久化采用 best-effort 模型，审计失败不得改变底层操作本身的结果。

## 安全边界

Junius 刻意不判断一个请求的本地命令是否安全、是否具有破坏性、是否合适，或是否符合用户意图。

设计中的决策链是：

    用户
      ↓
    ChatGPT / 调用助手
      ↓
    Junius 执行

任何通过 `run_command` 或 `start_job` 启动的可执行文件，都拥有运行 Junius 的操作系统用户所拥有的权限。

因此，只要该操作系统用户能够访问，启动的进程就可以访问所选 Workspace 之外的资源。

Workspace 的含义是：

    cwd + 内置文件工具根目录

它不是进程沙箱、不是限制已启动可执行文件的文件系统 jail，也不是网络隔离、注册表隔离或凭据隔离。

Host 唯一的 HTTP 监听器始终绑定在回环地址。Worker 私有端点要求内部令牌。如果通过 Tunnel 将 Junius 暴露给 ChatGPT，只应暴露精确的 `/mcp` 端点；不要暴露同端口上的 `/__junius/*` 诊断路由。

更多细节请参阅 `SECURITY.md` 和 `docs/architecture.md`。

## 验证

运行完整项目验证：

    pnpm run check

它会执行 bootstrap 语法验证、TypeScript 类型检查、完整自动化测试，以及源码验证指纹提交。

## 许可证

ISC。

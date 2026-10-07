# Junius

<p align="center">
  <img src="icon.svg" alt="Junius" width="128" height="128" />
</p>

[English](README.md) | **简体中文**

**Work 用完后，继续在 ChatGPT Chat 里工作。**

Junius 是一个已经可以安装使用的 Windows 应用，也是面向 ChatGPT 的本地 MCP 执行服务。它让 ChatGPT 能操作本地 Workspace 文件、进程、后台 Jobs、Git、浏览器自动化、Windows 桌面以及本地 Agent Skills。

## 安装 Junius

Junius **仅支持 Windows**。

前置条件：

- Node.js 20+，包含 npm/npx
- Python 3.10+

> **安全说明：** Junius 不是操作系统沙箱。通过 Junius 启动的命令和进程，会继承启动 Junius 的 Windows 用户权限。

使用一条 PowerShell 命令安装本地 Junius 应用：

```powershell
irm 'https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1' | iex
```

这条命令完成的是**本地 Junius 应用的安装与启动**。通过 OpenAI Secure MCP Tunnel 连接 ChatGPT 是下一步，不包含在这条安装命令里。

当前 bootstrap URL 跟随 `main`。Bootstrap 随后会选择最新发布且非 draft 的 GitHub Release，**包括 prerelease**，下载 `junius-windows.tgz` 和 `SHA256SUMS.txt`，校验包的 SHA-256，再运行 Release 中的安装器。这个 checksum 用来确认下载包与同一个 Release 中发布的校验值一致；它属于完整性校验，不是独立签名或独立信任根。

安装器会：

- 安装到 `%LOCALAPPDATA%\Junius\app`；
- 基于系统现有 Python 创建应用虚拟环境；
- 安装锁定的应用依赖；
- 验证已安装运行时；
- 注册当前 Windows 用户登录启动；
- 立即启动 Junius，并等待 Host health 通过。

普通安装不需要管理员权限。

### 验证安装是否成功

运行：

```powershell
irm http://127.0.0.1:8787/__junius/host-health
```

正常安装会返回 JSON，其中：

- `ok: true`
- `activeWorkerId` 非空

这说明**本地 Junius 应用已经正常运行**。只有继续完成 Secure MCP Tunnel 和个人 MCP 连接后，ChatGPT 侧才算真正接通。

## 目录

- [将 Junius 连接到 ChatGPT](#将-junius-连接到-chatgpt)
- [第一次使用](#第一次使用)
- [Junius 能做什么](#junius-能做什么)
- [MCP 工具表面](#mcp-工具表面)
- [更新](#更新)
- [卸载](#卸载)
- [常见问题](#常见问题)
- [支持范围](#支持范围)
- [源码开发](#源码开发)

## 将 Junius 连接到 ChatGPT

Junius 的 MCP 服务只监听本地回环地址。ChatGPT 通过 **OpenAI Secure MCP Tunnel** 连接它。

1. 在 OpenAI Platform 的 Tunnel 设置中创建或选择一个 Tunnel。
2. 在同一台 Windows 电脑上安装并配置当前版本的 OpenAI `tunnel-client`。
3. 将 Tunnel 配置精确指向 Junius MCP endpoint：

   ```text
   http://127.0.0.1:8787/mcp
   ```

4. 运行 `tunnel-client doctor`，然后启用或检查 Tunnel health listener。当前客户端默认是 `127.0.0.1:8080`。确认：

   ```text
   /health?details=true
   ```

   同时返回 `live: true` 和 `ready: true`。Junius 默认探测 `127.0.0.1:18080` 和 `127.0.0.1:8080`。如果 health listener 在其他地址，请把 `JUNIUS_TUNNEL_HEALTH_URL` 设置为完整 health URL。

5. 使用 Junius 期间保持 `tunnel-client run` 运行。
6. 在 ChatGPT 中打开 **Plugins**，点击加号，在 Developer mode 下添加 MCP 连接。
7. 连接类型选择 **Tunnel**，然后选择对应的 Secure MCP Tunnel。
8. 检查发现的 Junius 工具，并创建个人连接。

不要把 Tunnel 指向裸的 `http://127.0.0.1:8787`。只有 `/mcp` 应该暴露给 Tunnel；`/__junius/*` 是本地诊断接口。

当前 OpenAI 文档：

- ChatGPT 开发者平台：https://developers.openai.com/chatgpt
- Plugins 快速开始：https://developers.openai.com/plugins/quickstart
- 连接并测试插件：https://developers.openai.com/plugins/deploy/connect-chatgpt
- Secure MCP Tunnel：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

### 怎样才算真的完成

下面四条全部成立，才算配置完成：

1. `http://127.0.0.1:8787/__junius/host-health` 返回 `ok: true`。
2. Tunnel health 同时返回 `live: true` 和 `ready: true`。
3. ChatGPT 能发现 Junius MCP 工具。
4. 从 ChatGPT 发起一个简单 Junius 工具调用，能够在本机成功执行。

## 第一次使用

先为希望 Junius 操作的目录创建 Workspace：

```text
create_workspace(
  id = "weave",
  root_path = "C:\Projects\Weave"
)
```

之后使用同一个 Workspace ID：

```text
run_command(
  workspace = "weave",
  executable = "git",
  args = ["status", "--short", "--branch"]
)
```

Workspace 只是一个稳定 ID 加一个规范化本地根路径。它既是进程执行的工作目录，也是内置文件工具的根边界。它**不是**进程沙箱。

## Junius 能做什么

Junius 是执行服务，不是第二套策略引擎。ChatGPT 和用户决定要做什么；Junius 执行选定的本地操作并报告结果。

主要能力：

- Workspace 文件读取、搜索和修改
- 直接进程执行与有上限的命令批处理
- 用于长任务的后台 Jobs
- Git snapshot / staged review / commit 辅助工具
- 本地 Agent Skills
- 浏览器自动化
- Windows 桌面 Computer Use
- 持久化 Junius prompt override
- 已安装副本的更新检查与更新

已安装 Junius Host 监听：

```text
http://127.0.0.1:8787
```

路由：

```text
MCP:        /mcp
Health:     /__junius/host-health
Supervisor: /__junius/supervisor
```

Junius 没有管理 Web UI。

## MCP 工具表面

当前 MCP 工具包括：

- Operating contracts：`load_junius_contracts`
- Prompt overrides：`get_junius_prompts`、`set_junius_prompt`、`reset_junius_prompt`
- Workspaces：`list_workspaces`、`create_workspace`、`delete_workspace`
- Workspace 读取：`ls`、`read`、`rg`、`workspace_batch`
- Workspace 修改：`write_file`、`apply_patch`、`delete_file`、`move_file`、`copy_file`、`mkdir`、`workspace_mutate`
- Agent Skills：`list_skills`、`read_skill`、`install_skill`、`remove_skill`
- 进程：`run_command`、`run_commands`
- Jobs：`start_job`、`get_job`、`wait_job`、`read_job_output`、`cancel_job`
- Git：`git_snapshot`、`git_prepare_commit`、`git_commit`
- 已安装副本更新：`check_junius_update`、`update_junius`
- Computer Use：`playwright_cli`、`desktop`
- Turn / observability plumbing：`junius_turn_begin`、`junius_turn_end`、`junius_observability_panel`、`close_junius_test_window`

源码测试连接不会暴露已安装副本的更新工具。

工具参数、路由、持久化、Worker affinity、Audit、Computer Use 内部实现以及 prompt 生命周期，见 [docs/architecture.md](docs/architecture.md)。

## 更新

已安装 Junius CLI：

```powershell
junius update --check
junius update
junius restart
```

ChatGPT 也可以对已安装副本调用 `check_junius_update` 和 `update_junius`。MCP 自更新不会终止自己当前的工具调用，而会返回 `restartRequired: true`；随后在该活动调用之外重启 Junius。

重新运行 PowerShell 安装命令同样是受支持的原地更新方式。

## 卸载

Junius 当前还没有独立的 uninstall 命令。要移除已安装副本和当前用户的本地 Junius 状态：

```powershell
$health = Invoke-RestMethod http://127.0.0.1:8787/__junius/host-health -ErrorAction SilentlyContinue
if ($health.pid) { taskkill /PID $health.pid /T /F | Out-Null }

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v Junius /f
Remove-Item "$env:LOCALAPPDATA\Junius" -Recurse -Force
```

这会移除已安装应用、登录启动项、Workspace 注册、prompt overrides，以及 `%LOCALAPPDATA%\Junius` 下保存的其他 Junius 状态。

被注册成 Workspace 的项目目录和其中的文件不会被删除。

## 常见问题

**8787 端口已被占用**

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

先停止或重新配置冲突进程，再启动 Junius。

**找不到 Python**

```powershell
python --version
py -0p
```

Junius 要求系统已经安装 Python 3.10+；安装器不会替你下载 Python。

**Junius 已安装，但 Tunnel 一直没 ready**

运行 `tunnel-client doctor`，并直接检查配置的 health listener。它必须同时返回 `live: true` 和 `ready: true`。如果 listener 不在 `127.0.0.1:18080` 或 `127.0.0.1:8080`，请设置 `JUNIUS_TUNNEL_HEALTH_URL`。

**ChatGPT 看不到工具**

确认 Tunnel 精确指向 `http://127.0.0.1:8787/mcp`、Tunnel 已 ready、当前账户/Workspace 已启用 Developer mode，然后重新连接个人 MCP connection。

**需要重启 Junius**

```powershell
junius restart
```

## 支持范围

Junius 是一个**仅支持 Windows 的个人/本地 MCP 产品**，支持基线为 **ChatGPT Plus 及以上**。Free 和 Go 不是目标套餐。

Junius 刻意不进入公开插件目录。GitHub Releases 用于分发本地应用；每位用户自行创建与自己机器对应的 Secure MCP Tunnel 和个人 ChatGPT MCP 连接。

<a href="https://www.producthunt.com/products/junius?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-junius" target="_blank" rel="noopener noreferrer"><img alt="Junius - Keep working in ChatGPT Chat after Work runs out | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1270641&amp;theme=neutral&amp;t=1791214371048"></a>

## 源码开发

仓库开发使用 pnpm 12.6.0：

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 启动仅供贡献者使用的源码测试实例 `127.0.0.1:18787`。已安装 Junius 仍然是运行在 `127.0.0.1:8787` 的正常应用。

运行完整项目验证：

```powershell
pnpm run check
```

Release / 分发验证：

```powershell
pnpm run check:release
```

实现细节和维护者说明属于 [docs/architecture.md](docs/architecture.md)，不再塞进这份上手 README。

## 项目文档

- [架构](docs/architecture.md)
- [安全](SECURITY.md)
- [更新日志](CHANGELOG.md)
- [许可证](LICENSE)

## 许可证

[ISC](LICENSE)。

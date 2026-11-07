# LUMA 游戏开发控制台

面向 UE5.8 游戏研发的六大管线任务看板（渲染、物理、动画、特效、客户端、网络）。无需构建工具：直接用浏览器打开 `index.html` 即可离线使用；连接 Supabase 后可部署为公网多人协作系统。

## 模式

- **本地模式**：任务存储在当前浏览器的 localStorage，支持新增、编辑、删除、筛选、看板拖动和 JSON 导入导出。
- **团队模式**：邮箱登录、团队空间、邀请码、成员权限、PostgreSQL 云端存储、Realtime 实时刷新、在线成员和本地副本。

## 为什么使用 Supabase

调研了以下开源项目：

| 项目 | 结论 |
| --- | --- |
| [mattermost-community/focalboard](https://github.com/mattermost-community/focalboard) | 官方 README 明确标注目前不维护，不建议作为新系统的协作后端。 |
| [makeplane/plane](https://github.com/makeplane/plane) | 功能完整、维护活跃，但适合独立部署；嵌入会形成两套界面、账号和任务数据。采用 AGPL-3.0。 |
| [supabase/supabase](https://github.com/supabase/supabase) | 提供 Postgres、Auth、自动 API 和 Realtime，适合保留 LUMA 界面并增加协作层；采用 Apache-2.0。 |

Supabase 可使用云服务，也可自部署。这里不使用 service role，不让前端绕过数据库权限。

## 第一次部署

### 1. 创建 Supabase 项目

1. 在 [supabase.com](https://supabase.com) 创建项目。
2. 打开 SQL Editor，完整执行 `supabase/schema.sql`。
3. 在 Authentication → Providers 中启用 Email。
4. 小团队建议保留邮箱验证；也可以在测试阶段暂时关闭 Confirm email。
5. 在 Authentication → URL Configuration 中，将 Site URL 设为最终的 GitHub Pages 地址。

SQL 会创建团队、成员、任务表，以及行级安全策略。非成员无法读取团队任务，观察员无法修改任务。

### 2. 配置公开连接信息

在项目 Settings → API Keys 中找到 Project URL 和 anon public key。新版控制台可能将后者称为 Publishable key。

把它们填入 `config.js`：

```js
window.LUMA_CONFIG = {
  SUPABASE_URL: "https://你的项目.supabase.co",
  SUPABASE_ANON_KEY: "你的 anon / publishable 公钥"
};
```

这些值会出现在公开网页中，这是前端 Supabase 应用的正常工作方式，安全性由 RLS 保证。**不要填写 service_role 或 secret key。**

### 3. 部署 GitHub Pages

1. 将本目录提交到一个 GitHub 仓库，默认分支使用 `main`。
2. 打开仓库 Settings → Pages，将 Source 设为 **GitHub Actions**。
3. 推送到 `main`，`.github/workflows/deploy.yml` 会自动发布。
4. 在 Actions 或 Pages 设置中获得公网地址，通常为：

```text
https://你的用户名.github.io/仓库名/
```

5. 把这个地址填回 Supabase 的 Site URL 和允许的重定向地址。

不需要 Python、Node.js、npm 或任何本机构建步骤。

## 团队协作

1. 第一位成员注册并登录，创建团队空间。
2. LUMA 会将当前任务初始化为云端任务；已有云端任务时则下载云端版本。
3. 在“团队协作与云端同步”窗口复制邀请码。
4. 其他成员注册登录，选择“加入团队”，输入邀请码。
5. 成员修改任务后，其他在线成员会通过 Realtime 自动刷新。

邀请码加入后默认是编辑者，只分享给信任的团队成员。需要只读成员时，可在 Supabase 的 `workspace_members` 表中将其 `role` 改为 `viewer`。

## 数据与冲突规则

- 修改以单个任务为单位同步，不同任务可以并行编辑。
- 同一任务同时编辑时采用最后一次成功写入，不做字段级合并。
- 本地始终保留一份任务副本；断网时界面仍可查看，未成功写入的操作会自动重试。
- 导入备份会替换当前空间的任务，操作前需要确认。
- 建议定期使用“导出备份”，重要项目同时在 Supabase 中配置数据库备份。

## 本地预览

直接双击 `index.html` 即可使用本地模式。测试云端登录、Realtime 和剪贴板时，应使用 HTTPS 公网地址或本地 HTTP 服务，不建议使用 `file://`。

## 文件

- `index.html`：应用界面
- `styles.css`：桌面与移动端样式
- `data.js`：89 项 UE5.8 初始研发任务与路线
- `app.js`：看板、任务管理与本地数据
- `collaboration.js`：账号、团队、权限、同步与在线状态
- `config.js`：Supabase 公开连接配置
- `supabase/schema.sql`：数据库、邀请函数与 RLS
- `.github/workflows/deploy.yml`：GitHub Pages 自动部署

## 任务数据与自定义需求

- 默认任务定义在 `data.js` 的 `DEFAULT_TASKS`；看板 UI 可新增自定义任务（`custom: true`），本地与团队模式都会保留。
- 小功能需求请直接上板，例如渲染项 **R-22「低画质点光 4 面投影」**：标题可测、可回退，并挂到 Scalability，不必另起长文档。
- 海岛生存立项重点：三档帧率（High 144+ / Mid 2060@1080p 100+ / Low 60）、中档 SSGI、高档压缩 Lumen GI、Chaos 预算与建设期 Actor 变体管控。


## 制作管线

内置：渲染、物理、动画、特效、音频、界面、关卡内容、客户端、网络。可在新建任务里继续「+ 新建管线」。开发路线页已改为美术向制作清单；踩坑记在「开发备忘」。

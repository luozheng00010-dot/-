# 无限画布 Windows 客户端壳

Electron 主进程，把 web + server 打包成一个 Windows 客户端窗口。

## 开发

前置依赖（后端需要）：Docker Desktop 可用。壳启动时若检测到 PostgreSQL（5432）未运行，
会自动用仓库根目录的 `docker-compose.yml` + `docker-compose.local.yml` 拉起 postgres 与 minio。

```bash
cd electron
npm install
npm run dev
```

`npm run dev` 会自动：

1. 启动后端 `server`（端口 3001；若已运行则复用）；新启动时生成 Prisma Client、同步开发数据库，并通过 tsx watch 运行源码，后台 worker 同样使用源码
2. 启动前端 Vite（端口 3000；若已运行则复用）
3. 打开客户端窗口，开发时带热更新，DevTools 停靠右侧

前后端代码改动会热更新；开发模式不再优先运行可能过期的 `server/dist`。数据库结构变化后需完整退出并重新启动客户端，以重新生成 Prisma Client 和同步数据库。数据库同步失败时查看启动日志，不会自动接受数据丢失。

如果此前已由旧启动器拉起后端，需完整退出客户端后重新启动，仅刷新网页不会替换旧进程。外部启动且占用 3001 的后端仍会被复用，请先停止旧服务再启动客户端。

## 打包

```bash
cd web && npm run build
cd ../server && npm run build
cd ../electron && npm run dist
```

产物在 `electron/release/`。electron-builder 会把 web/dist、server/dist、server/.env 和
server/node_modules 作为 extraResources 打进安装包，主进程从 `process.resourcesPath` 读取。

> 注意：当前打包产物仍依赖目标机器上有 Node.js 运行时，且依赖外部 PostgreSQL + MinIO。
> 后续真正发布需要：内嵌 Node 二进制（或用 pkg 把 server 编译成 exe）、
> 内嵌 PostgreSQL（如 embedded-postgres）或切换 SQLite、MinIO 换本地文件存储。
> 这些属于发行阶段工作，开发期不需要。

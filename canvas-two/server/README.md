# Infinite Canvas Server

多用户版本的业务 API，提供账号认证、成员权限、画布/生成记录/资产持久化、MinIO 媒体存储和模型渠道代理。

## 本地开发

需要 Node.js 22、PostgreSQL 和 MinIO。根目录的 Compose 配置可只启动依赖服务：

```bash
cd ..
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres minio
cd server
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:push
npm run dev
```

开发 API 默认监听 `http://localhost:3001`，Vite 会将同源 `/api` 请求代理到该地址。数据库为空时会自动创建管理员 `root/root`，首次登录必须把密码修改为 8–72 位的新密码。

## 数据库迁移

开发环境可以使用 `npm run prisma:push` 快速同步结构。Docker/生产环境启动时执行 `prisma migrate deploy`，迁移文件位于 `prisma/migrations`。

## 安全配置

生产环境必须设置并妥善保存：

- `DATABASE_URL` / PostgreSQL 密码。
- `SESSION_SECRET`，用于数据库 Session Token 摘要。
- `CHANNEL_ENCRYPTION_KEY`，用于 AES-256-GCM 加密模型渠道 API Key；更换后已有密钥无法解密。
- MinIO Endpoint、Access Key、Secret Key 和私有 Bucket。

生产环境会拒绝明显的示例或默认凭据。普通用户只能读取已启用渠道的名称、模型与能力，不会收到 Base URL 或 API Key。

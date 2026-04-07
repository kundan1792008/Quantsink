# Quantsink

Unified Quantsink repository containing:

- the **Next.js frontend** from `main`
- the **biometric SSO / graph / DM API** from `copilot/add-biometric-sso-integration`

## Features

- Biometric Quantmail JWT authentication
- Digital Twin networking and zero-spam DM backend
- Graph-based connections and endorsements API
- Next.js landing/feed frontend
- Docker + CI workflow for the merged codebase

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+ (CI runs on PostgreSQL 16)

### Setup

```bash
npm ci
cp .env.example .env
npm run prisma:generate
npx prisma db push
```

### Local development

```bash
# Frontend (default Next.js app on :3000)
npm run dev:frontend

# Backend API (Express app on :3001 by default)
npm run dev:backend
```

### Validation

```bash
npm run lint
npm test
npm run build
```

### Docker

```bash
docker build -t quantsink .
docker run -p 3000:3000 \
  -e PORT=3000 \
  -e DATABASE_URL=postgresql://... \
  -e QUANTMAIL_JWT_SECRET=your-secret \
  quantsink
```

## API Reference

All API endpoints require `Authorization: Bearer <quantmail-jwt>`.
The JWT must include `biometricVerified: true`.

### Posts

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/posts/short` | Create a short post |
| `POST` | `/api/v1/posts/deep` | Create a deep article |
| `GET`  | `/api/v1/posts/feed` | Read the merged feed |
| `GET`  | `/api/v1/posts/short/:id` | Get a short post |
| `GET`  | `/api/v1/posts/deep/:id` | Get a deep article |
| `DELETE` | `/api/v1/posts/short/:id` | Soft-delete a short post |
| `DELETE` | `/api/v1/posts/deep/:id` | Soft-delete a deep article |

### Connections

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/connections/connect` | Send a connection request |
| `PATCH` | `/api/v1/connections/:id` | Accept or decline a request |
| `GET`  | `/api/v1/connections` | List accepted connections |
| `POST` | `/api/v1/connections/follow` | Follow a user |
| `DELETE` | `/api/v1/connections/follow/:targetId` | Unfollow |
| `POST` | `/api/v1/connections/skills` | Add a skill |
| `POST` | `/api/v1/connections/endorse` | Endorse a skill |

### Direct messages

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/dms` | Send a DM |
| `GET`  | `/api/v1/dms/inbox` | View delivered messages |
| `GET`  | `/api/v1/dms/shadow` | View filtered messages |
| `PATCH` | `/api/v1/dms/:id/read` | Mark a message as read |

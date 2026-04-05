# Quantsink

**The LinkedIn / Twitter / Threads Killer** — part of the interconnected Quant Ecosystem.

## Features

- **Biometric SSO** — authenticates exclusively via the Quantmail JWT (no local passwords)
- **Digital Twin Networking** — AI agent that automatically replies, networks, and negotiates 24/7 on your behalf
- **Graph-based Connection Engine** — professional relationships, skills, endorsements, and follower graphs (Prisma/PostgreSQL)
- **Dual-Feed System** — `/api/v1/posts/short` (Threads-style microblogging) + `/api/v1/posts/deep` (LinkedIn-style articles) merged into a single feed
- **Zero-Spam DMs** — tied to the Quantmail shadow inbox filter; unsolicited pitches are auto-negotiated or dropped by the Digital Twin
- **Production-ready** — Pino structured logging, Zod validation, Dockerfile, CI/CD

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- A running Quantmail service (for JWT validation)

### Setup

```bash
# 1. Install dependencies
npm ci

# 2. Configure environment
cp .env.example .env
# Edit .env and set DATABASE_URL and QUANTMAIL_JWT_SECRET

# 3. Generate Prisma client & run migrations
npm run prisma:generate
npm run prisma:migrate

# 4. Start dev server
npm run dev
```

### Docker

```bash
docker build -t quantsink .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgresql://... \
  -e QUANTMAIL_JWT_SECRET=your-secret \
  quantsink
```

---

## API Reference

All endpoints require a `Authorization: Bearer <quantmail-jwt>` header.  
The JWT must have `biometricVerified: true`.

### Posts

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/posts/short` | Create a short post (≤500 chars) |
| `POST` | `/api/v1/posts/deep` | Create a deep article |
| `GET`  | `/api/v1/posts/feed` | Merged dual-feed (short + deep) |
| `GET`  | `/api/v1/posts/short/:id` | Get a short post |
| `GET`  | `/api/v1/posts/deep/:id` | Get a deep article |
| `DELETE` | `/api/v1/posts/short/:id` | Soft-delete a short post |
| `DELETE` | `/api/v1/posts/deep/:id` | Soft-delete a deep article |

### Connections & Graph

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/connections/connect` | Send a connection request |
| `PATCH` | `/api/v1/connections/:id` | Accept or decline a request |
| `GET`  | `/api/v1/connections` | List accepted connections |
| `POST` | `/api/v1/connections/follow` | Follow a user |
| `DELETE` | `/api/v1/connections/follow/:targetId` | Unfollow |
| `POST` | `/api/v1/connections/skills` | Add a skill to your profile |
| `POST` | `/api/v1/connections/endorse` | Endorse a skill |

### Direct Messages (Zero-Spam)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/dms` | Send a DM (runs through Digital Twin spam filter) |
| `GET`  | `/api/v1/dms/inbox` | View delivered messages |
| `GET`  | `/api/v1/dms/shadow` | View shadow inbox (filtered messages) |
| `PATCH` | `/api/v1/dms/:id/read` | Mark a message as read |

---

## Architecture

```
src/
├── app.ts                          # Express app setup
├── index.ts                        # Server entry point
├── lib/
│   ├── logger.ts                   # Pino structured logging
│   └── prisma.ts                   # Prisma client singleton
├── middleware/
│   ├── auth.ts                     # Quantmail JWT / Biometric SSO
│   └── errorHandler.ts             # Central error handler
├── routes/
│   ├── posts.ts                    # Dual-feed post endpoints
│   ├── connections.ts              # Graph engine endpoints
│   └── dms.ts                      # Zero-Spam DM endpoints
└── services/
    └── DigitalTwinNetworking.ts    # AI twin service stub
prisma/
└── schema.prisma                   # Graph DB schema
```

## Running Tests

```bash
npm test
```

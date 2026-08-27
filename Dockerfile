# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# base — tzdata จำเป็น เพราะ HOSxP v3 เก็บ vstdate/vsttime เป็นเวลาท้องถิ่น
# ถ้า container เป็น UTC การ query ช่วงวันจะเพี้ยนไป 7 ชั่วโมง
# ---------------------------------------------------------------------------
FROM node:24-alpine AS base
RUN apk add --no-cache tzdata
ENV TZ=Asia/Bangkok
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package*.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# dev — ใช้กับ docker-compose ตอนพัฒนา source mount ทับเข้ามา
# ---------------------------------------------------------------------------
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3333
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node ace build

# ---------------------------------------------------------------------------
FROM base AS production
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./
EXPOSE 3333
CMD ["node", "bin/server.js"]

# Stage 1: Build React frontend
FROM node:20-slim AS frontend

WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src/ src/
COPY public/ public/
RUN npm run build

# Stage 2: Python backend + serve static files
FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=frontend /build/dist /app/static

EXPOSE ${PORT:-8000}

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]

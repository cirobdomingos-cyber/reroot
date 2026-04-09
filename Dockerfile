# Stage 1: Build React frontend
FROM node:20-slim AS frontend

# Declare build-time variables so Railway injects them during `npm run build`.
# VITE_ vars are baked into the JS bundle by Vite — they must be present at
# build time, not runtime.
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_API_URL
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ENV VITE_API_URL=$VITE_API_URL

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

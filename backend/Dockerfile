FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System build deps. truedata-ws pulls an older lz4 that has no cp311 wheel, so it
# compiles from source -> we need a full toolchain incl. libc headers (build-essential
# provides gcc/g++/make/libc6-dev; plain gcc alone is missing stdlib.h).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . .

# Tick recordings volume mount target.
RUN mkdir -p /data/ticks

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

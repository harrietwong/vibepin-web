# VibePin cloud worker — pipeline jobs (trends, crawl, stl-score, daily, smoke)
FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libcurl4 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY requirements-cloud.txt .
RUN pip install --no-cache-dir -r requirements-cloud.txt

COPY . .

# Override --job in cron / platform scheduler. Examples:
#   python run_worker.py --job smoke
#   python run_worker.py --job trends
#   python run_worker.py --job crawl --limit-keywords 80
#   python run_worker.py --job stl-score
#   python run_worker.py --job daily
ENTRYPOINT ["python", "-u", "run_worker.py"]
CMD ["--job", "smoke"]

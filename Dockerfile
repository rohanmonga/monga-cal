FROM python:3.11-slim

WORKDIR /app

# Set timezone environment variable
ENV TZ=America/Los_Angeles
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install system build dependencies, postgres libraries, and tzdata
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    tzdata \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

ENV PORT=8000
ENV HOST=0.0.0.0
ENV PYTHONPATH=/app

CMD ["python", "-m", "monga_cal.main"]

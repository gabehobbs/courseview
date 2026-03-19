FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libffi-dev && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data /app/courses && \
    groupadd -g 568 courseview && \
    useradd -u 568 -g 568 -d /app -s /bin/bash courseview && \
    chown -R 568:568 /app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chown -R 568:568 /app

USER 568:568

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "120", "--access-logfile", "-", "app:app"]

# Observability Stack

This stack runs Prometheus and Grafana for the production app.

## Start locally

```bash
docker compose -f observability/docker-compose.yml up -d
```

Prometheus is available at http://localhost:9090.
Grafana is available at http://localhost:3000.

## Current scrape targets

- `app:8080`

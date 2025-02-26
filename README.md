# Render.com Prometheus Exporter

A Prometheus exporter for collecting metrics from Render.com services.

## Overview

This exporter connects to the Render.com API and exposes various metrics about your services in Prometheus format, including:

- CPU usage
- Memory usage
- Instance count
- Total service count

## Requirements

- Node.js (v22 or higher recommended)
- A Render.com [API token](https://render.com/docs/api#1-create-an-api-key)

## Usage

### Running locally

```bash
npm install
export RENDER_API_TOKEN=your_render_api_token
export NODE_ENV=development
npm run watch
```

### Bearer auth

If `AUTH_BEARER_TOKEN` is set, the exporter will require the token in an
Authorization header to server `/metrics`

### Basic auth

If both the `AUTH_USERNAME` and `AUTH_PASSWORD` variabeles are present, and
bearer auth is not enabled, the exporter will require basic authentication to
serve `/metrics`.

If either is absent or empty, it will serve unencrypted.

### Deploying to Render.com

1. Create a new Web Service on Render.com
2. Connect it to the public repository at `https://github.com/readmeio/render_exporter`
3. Set the build command to `npm ci --include dev && npm run build`
4. Set the run command to `npm run start`
5. Add environment variables for configuration
6. Deploy

## Configuration

The exporter is configured using environment variables:

| Variable              | Description                                 | Required | Default           |
| --------------------- | ------------------------------------------- | -------- | ----------------- |
| `RENDER_API_TOKEN`    | Your Render.com API token                   | Yes      | -                 |
| `PORT`                | Port to run the exporter on                 | No       | 3000              |
| `NODE_ENV`            | Environment (development, production, test) | Yes      | -                 |
| `SERVICE_NAME_FILTER` | Filter services by name                     | No       | "" (all services) |
| `AUTH_USERNAME`       | Basic auth username                         | No       | -                 |
| `AUTH_PASSWORD`       | Basic auth password                         | No       | -                 |
| `AUTH_BEARER_TOKEN`   | Bearer auth token                           | Noe      | -                 |

## Metrics

The exporter exposes the following metrics at the `/metrics` endpoint:

- `render_service_count`: Total number of services
- `render_service_instance_count_count`: Current number of instances for each service
- `render_service_cpu_usage_percent`: CPU usage for each service
- `render_service_memory_usage_bytes`: Memory usage for each service in bytes

## Prometheus Configuration

Add the following to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "render"
    scrape_interval: 60s
    static_configs:
      - targets: ["your-exporter-host:3000"]
```

## License

MIT

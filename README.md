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

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/render-prometheus-exporter.git
cd render-prometheus-exporter

# Install dependencies
npm install
```

## Configuration

The exporter is configured using environment variables:

| Variable              | Description                                 | Required | Default           |
| --------------------- | ------------------------------------------- | -------- | ----------------- |
| `RENDER_API_TOKEN`    | Your Render.com API token                   | Yes      | -                 |
| `PORT`                | Port to run the exporter on                 | No       | 3000              |
| `NODE_ENV`            | Environment (development, production, test) | Yes      | -                 |
| `SERVICE_NAME_FILTER` | Filter services by name                     | No       | "" (all services) |

## Usage

### Running locally

```bash
export RENDER_API_TOKEN=your_render_api_token
export NODE_ENV=development
npm start
```

### Running with Docker

```bash
docker build -t render-prometheus-exporter .
docker run -p 3000:3000 -e RENDER_API_TOKEN=your_render_api_token -e NODE_ENV=production render-prometheus-exporter
```

### Deploying to Render.com

1. Create a new Web Service on Render.com
2. Connect your repository
3. Add the required environment variables
4. Deploy

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

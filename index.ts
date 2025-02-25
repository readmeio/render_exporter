import type {
  FastifyBaseLogger,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";

import { fastify } from "fastify";
import {
  getServices,
  cpuUsage,
  memoryUsage,
  instanceCount,
  MetricLabel,
  MetricResponse,
  ScalingResourceID,
  Service,
} from "@llimllib/renderapi";

function requiredEnvVar(name: string) {
  if (!process.env[name])
    throw new Error(`required env var ${name} is not set`);
  return process.env[name];
}

const ENV = requiredEnvVar("NODE_ENV");
const RENDER_API_TOKEN = requiredEnvVar("RENDER_API_TOKEN");
const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVICE_NAME_FILTER = process.env.SERVICE_NAME_FILTER || "";
const BATCH_SIZE = 50;

if (!RENDER_API_TOKEN) {
  console.error("RENDER_API_TOKEN environment variable is required");
  process.exit(1);
}

// Chunk an array into batches
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

interface MetricDefinition {
  name: string;
  help: string;
  type: string;
}

interface MetricValue {
  labels: Record<string, string>;
  value: number;
}

interface MetricResult {
  definition: MetricDefinition;
  values: MetricValue[];
}

// Helper function to generate Prometheus metric headers
function formatMetricHeader(metric: MetricDefinition): string {
  return `# HELP ${metric.name} ${metric.help}\n# TYPE ${metric.name} ${metric.type}\n`;
}

// Helper function to format metric values in Prometheus format
function formatMetricValues(metricName: string, values: MetricValue[]): string {
  return (
    values
      .map((value) => {
        const labels = Object.entries(value.labels)
          .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
          .map(([key, val]) => `${key}="${val}"`)
          .join(", ");
        return `${metricName}{${labels}} ${value.value}`;
      })
      .join("\n") + "\n"
  );
}

async function collectMetrics(
  services: Service[],
  apiToken: string,
  metricFn: (
    token: string,
    serviceIds: ScalingResourceID[],
    startTime: string,
  ) => Promise<MetricResponse[]>,
  metricDefinition: MetricDefinition,
): Promise<MetricResult> {
  const serviceMap = new Map<string, Service>();
  services.forEach((service) => serviceMap.set(service.id, service));

  // Create batches for API limits
  const idBatches = chunkArray(
    services.map((service) => service.id),
    BATCH_SIZE,
  );

  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  // Make all API calls in parallel with the startTime parameter
  const allMetricsPromises = idBatches.map((batch) =>
    metricFn(apiToken, batch, twoMinutesAgo),
  );

  // Wait for all API calls to complete
  const allMetricsResults = await Promise.all(allMetricsPromises);

  // Flatten and process all results
  const values: MetricValue[] = [];

  allMetricsResults.flat().forEach((metric: MetricResponse) => {
    if (metric.labels?.length > 0 && metric.values.length > 0) {
      const latestValue = metric.values[metric.values.length - 1].value;

      const labels: Record<string, string> = {
        unit: metric.unit,
        service_name:
          serviceMap.get(
            metric.labels.find((x) => x.field == "service")?.value || "",
          )?.name || "unknown",
      };

      // Add all labels from the API response
      metric.labels.forEach((label: MetricLabel) => {
        if (label.field && label.value !== undefined) {
          labels[label.field] = String(label.value);
        }
      });

      values.push({
        labels,
        value: latestValue,
      });
    }
  });

  const updatedDefinition = { ...metricDefinition };
  // get the unit from the first data point and assume it's the unit for all
  // points; if that's not true, the label in the point will be accurate anyway
  updatedDefinition.name = `${updatedDefinition.name}_${values[0].labels["unit"]}`;

  return {
    definition: updatedDefinition,
    values,
  };
}

function collectServiceCountMetric(services: Service[]): MetricResult {
  return {
    definition: {
      name: "render_service_count",
      help: "Total number of services",
      type: "gauge",
    },
    values: [
      {
        labels: {},
        value: services.length,
      },
    ],
  };
}

async function collectInstanceCountMetrics(
  services: Service[],
  apiToken: string,
): Promise<MetricResult> {
  return collectMetrics(services, apiToken, instanceCount, {
    name: "render_service_instance_count",
    help: "Current number of instances for a Render service",
    type: "gauge",
  });
}

async function collectCPUMetrics(
  services: Service[],
  apiToken: string,
): Promise<MetricResult> {
  return collectMetrics(services, apiToken, cpuUsage, {
    name: "render_service_cpu_usage",
    help: "CPU usage for a Render service",
    type: "gauge",
  });
}

async function collectMemoryMetrics(
  services: Service[],
  apiToken: string,
): Promise<MetricResult> {
  return collectMetrics(services, apiToken, memoryUsage, {
    name: "render_service_memory_usage",
    help: "Memory usage for a Render service in bytes",
    type: "gauge",
  });
}

// Format a single metric result into Prometheus format
function formatMetricResult(result: MetricResult): string {
  if (result.values.length === 0) {
    return "";
  }

  let output = formatMetricHeader(result.definition);
  output += formatMetricValues(result.definition.name, result.values);
  return output;
}

// Main metrics handler function with parallel metric collection
async function metrics(request: FastifyRequest, reply: FastifyReply) {
  try {
    // Fetch all services
    const services = await getServices(RENDER_API_TOKEN, SERVICE_NAME_FILTER);

    // Collect all metrics in parallel
    const metricResults = await Promise.all([
      collectInstanceCountMetrics(services, RENDER_API_TOKEN),
      collectServiceCountMetric(services),
      collectCPUMetrics(services, RENDER_API_TOKEN),
      collectMemoryMetrics(services, RENDER_API_TOKEN),
    ]);

    // Build metrics output
    const metricsOutput = metricResults
      .map(formatMetricResult)
      .filter((output) => output.length > 0)
      .join("\n");

    // Set content type for Prometheus
    reply.header("Content-Type", "text/plain");
    return metricsOutput;
  } catch (error) {
    request.log.error(error);
    reply.code(500).send("Error fetching metrics");
  }
}

// Start the server
const start = async () => {
  const logger: Record<string, FastifyServerOptions["logger"]> = {
    development: {
      transport: {
        target: "pino-pretty",
        options: {
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
          colorize: true,
          useLevel: "debug",
        },
      },
    },
    production: true,
    test: false,
  };
  if (!logger[ENV]) {
    throw new Error(`Invalid env: ${ENV}`);
  }

  const server = fastify({ logger: logger[ENV] as FastifyBaseLogger });
  server.get("/metrics", metrics);

  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server listening on port ${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();

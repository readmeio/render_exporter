import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./server";

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
  batchSize: number,
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
    batchSize,
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
            metric.labels.find((x) => x.field == "resource")?.value || "",
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
  batchSize: number,
): Promise<MetricResult> {
  return collectMetrics(services, apiToken, batchSize, instanceCount, {
    name: "render_service_instance_count",
    help: "Current number of instances for a Render service",
    type: "gauge",
  });
}

async function collectCPUMetrics(
  services: Service[],
  apiToken: string,
  batchSize: number,
): Promise<MetricResult> {
  return collectMetrics(services, apiToken, batchSize, cpuUsage, {
    name: "render_service_cpu_usage",
    help: "CPU usage for a Render service",
    type: "gauge",
  });
}

async function collectMemoryMetrics(
  services: Service[],
  apiToken: string,
  batchSize: number,
): Promise<MetricResult> {
  return collectMetrics(services, apiToken, batchSize, memoryUsage, {
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
export function createMetricsHandler(config: Config) {
  return async function metrics(request: FastifyRequest, reply: FastifyReply) {
    try {
      // Fetch all services
      const services = await getServices(
        config.renderApiToken,
        config.serviceNameFilter,
      );

      // Collect all metrics in parallel
      const metricResults = await Promise.all([
        collectInstanceCountMetrics(
          services,
          config.renderApiToken,
          config.batchSize,
        ),
        collectServiceCountMetric(services),
        collectCPUMetrics(services, config.renderApiToken, config.batchSize),
        collectMemoryMetrics(services, config.renderApiToken, config.batchSize),
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
  };
}

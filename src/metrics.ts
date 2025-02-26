import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";

import { inspect } from "node:util";

import {
  getServices,
  bandwidth,
  activeConnections,
  cpuUsage,
  memoryUsage,
  instanceCount,
  MetricLabel,
  MetricResponse,
  ScalingResourceID,
  Service,
} from "@llimllib/renderapi";
import { debug as Debug } from "debug";

import type { Config } from "./server";

const debug = Debug("render_exporter");

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
  startTime?: string,
): Promise<MetricResult> {
  const serviceMap = new Map<string, Service>();
  services.forEach((service) => serviceMap.set(service.id, service));

  // Create batches for API limits
  const idBatches = chunkArray(
    services.map((service) => service.id),
    batchSize,
  );

  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  // Make all API calls in parallel
  const allMetricsPromises = idBatches.map((batch) =>
    metricFn(apiToken, batch, startTime || twoMinutesAgo),
  );

  // Wait for all API calls to complete
  const allMetricsResults = await Promise.all(allMetricsPromises);

  // Flatten and process all results
  const values: MetricValue[] = [];

  allMetricsResults
    .flat()
    .filter(Boolean)
    .forEach((metric: MetricResponse) => {
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

  if (values.length == 0) {
    debug(`full results ${inspect(allMetricsResults)}`);
    throw new Error(
      `Empty metrics result ${metricFn.name} ${services.map((svc) => `«${svc.id} ${svc.name}»`)}`,
    );
  }

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

async function collectBandwidth(
  services: Service[],
  apiToken: string,
  batchSize: number,
  logger: FastifyBaseLogger,
): Promise<MetricResult> {
  const definition = {
    name: "render_service_bandwidth",
    help: "Bandwidth used by a render service",
    type: "gauge",
  };

  // As far as I can tell, only web services are valid here. Waiting on
  // response from render
  const relevantServices = services.filter((svc) => svc.id.startsWith("srv-"));
  if (relevantServices.length == 0) {
    logger.debug("No relevant services found for active connections");
    return { definition, values: [] };
  }

  // bandwidth is only collected every hour, so start an hour ago
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  return collectMetrics(
    relevantServices,
    apiToken,
    batchSize,
    bandwidth,
    definition,
    hourAgo,
  );
}

async function collectActiveConnections(
  services: Service[],
  apiToken: string,
  batchSize: number,
  logger: FastifyBaseLogger,
): Promise<MetricResult> {
  const definition = {
    name: "render_service_active_connections",
    help: "Active connections for redis or postgres servers",
    type: "gauge",
  };

  // connection metrics are only valid for redis and postgres services
  const relevantServices = services.filter(
    (svc) => svc.id.startsWith("red-") || svc.id.startsWith("dpg-"),
  );
  if (relevantServices.length == 0) {
    logger.debug("No relevant services found for active connections");
    return { definition, values: [] };
  }

  return collectMetrics(
    relevantServices,
    apiToken,
    batchSize,
    activeConnections,
    definition,
  );
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
    const logger = request.log;

    try {
      // Fetch all services
      const services = await getServices(
        config.renderApiToken,
        config.serviceNameFilter,
      );
      debug(`services: ${services.map((svc) => `${svc.id} ${svc.name}, `)}`);

      // Collect all metrics in parallel
      const metricResults = await Promise.all([
        collectInstanceCountMetrics(
          services,
          config.renderApiToken,
          config.batchSize,
        ).catch((err) => {
          logger.error(`Error collecting instance counts\n${err}`);
          return null;
        }),
        collectServiceCountMetric(services),
        collectCPUMetrics(
          services,
          config.renderApiToken,
          config.batchSize,
        ).catch((err) => {
          logger.error(`Error collecting CPU metrics\n${err}`);
          return null;
        }),
        collectMemoryMetrics(
          services,
          config.renderApiToken,
          config.batchSize,
        ).catch((err) => {
          logger.error(`Error collecting memory metrics\n${err}`);
          return null;
        }),
        collectBandwidth(
          services,
          config.renderApiToken,
          config.batchSize,
          logger,
        ).catch((err) => {
          logger.error(`Error collecting bandwidth metrics\n${err}`);
          return null;
        }),
        collectActiveConnections(
          services,
          config.renderApiToken,
          config.batchSize,
          logger,
        ).catch((err) => {
          logger.error(`Error collecting active connections:\n${err}`);
          return null;
        }),
      ]);

      if (metricResults.filter((x) => x != null).length === 0) {
        logger.error("All metric collections failed");
        return reply
          .code(500)
          .send("Error fetching metrics: all collectors failed");
      }

      // Build metrics output
      const metricsOutput = metricResults
        .filter((x) => x != null)
        .map(formatMetricResult)
        .filter((output) => output.length > 0)
        .join("\n");

      // Set content type for Prometheus
      reply.header("Content-Type", "text/plain");
      return metricsOutput;
    } catch (error) {
      logger.error(error);
      reply.code(500).send("Error fetching metrics");
    }
  };
}

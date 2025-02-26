import type { FastifyBaseLogger, FastifyServerOptions } from "fastify";

import { fastify } from "fastify";
import fastifyBasicAuth from "@fastify/basic-auth";

import { createMetricsHandler } from "./metrics.js";

export interface Config {
  env: string;
  renderApiToken: string;
  port: number;
  serviceNameFilter: string;
  batchSize: number;
  auth: {
    username?: string;
    password?: string;
    bearer_token?: string;
  };
}

function requiredEnvVar(name: string): string {
  if (!process.env[name]) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return process.env[name] as string;
}

function loadConfig(): Config {
  return {
    env: requiredEnvVar("NODE_ENV"),
    renderApiToken: requiredEnvVar("RENDER_API_TOKEN"),
    port: parseInt(process.env.PORT || "3000", 10),
    serviceNameFilter: process.env.SERVICE_NAME_FILTER || "",
    batchSize: 50,
    auth: {
      username: process.env.AUTH_USERNAME,
      password: process.env.AUTH_PASSWORD,
      bearer_token: process.env.AUTH_BEARER_TOKEN,
    },
  };
}

// Start the server
const start = async () => {
  const config = loadConfig();

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
  if (!logger[config.env]) {
    throw new Error(`Invalid env: ${config.env}`);
  }

  const server = fastify({ logger: logger[config.env] as FastifyBaseLogger });
  if (config.auth.username && config.auth.password) {
    server.log.info("enabling basic auth");
    await server.register(fastifyBasicAuth, {
      validate: async (username: string, password: string) => {
        if (
          username !== config.auth.username ||
          password !== config.auth.password
        ) {
          throw new Error("Invalid credentials");
        }
      },
      authenticate: { realm: "Metrics API" },
    });
    // Apply auth to metrics endpoint
    server.get("/metrics", {
      onRequest: server.basicAuth,
      handler: createMetricsHandler(config),
    });
  } else {
    server.get("/metrics", {
      handler: createMetricsHandler(config),
    });
  }

  // Other routes will not have auth applied
  server.get("/", (request, reply) => {
    reply.send({ status: "ok" });
  });

  // You can add other non-authenticated routes here
  server.get("/favicon.ico", (request, reply) => {
    reply.code(204).send();
  });

  try {
    await server.listen({ port: config.port, host: "0.0.0.0" });
    console.log(`Server listening on port ${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();

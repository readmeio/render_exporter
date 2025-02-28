import type { Service, Redis, Postgres } from "@llimllib/renderapi";

import { getServices, listRedis, listPostgres } from "@llimllib/renderapi";

/**
 * Manages cached resources (services, Redis instances, Postgres instances)
 * and automatically refreshes them as a group when they become stale.
 */
export class ResourceCache {
  private services: Service[] = [];
  private redises: Redis[] = [];
  private postgreses: Postgres[] = [];

  private lastRefreshed: Date | null = null;

  private readonly apiToken: string;
  private readonly serviceNameFilter: string;
  private readonly maxAge: number; // in milliseconds

  /**
   * Creates a new ResourceCache instance.
   *
   * @param apiToken - API token for authentication
   * @param serviceNameFilter - Filter to apply when fetching services
   * @param maxAgeMs - Maximum age of cached data in milliseconds (default: 1 hour)
   */
  constructor(
    apiToken: string,
    serviceNameFilter: string,
    maxAgeMs: number = 60 * 60 * 1000,
  ) {
    this.apiToken = apiToken;
    this.serviceNameFilter = serviceNameFilter;
    this.maxAge = maxAgeMs;
  }

  /**
   * Checks if the cached resources are stale and need refreshing.
   *
   * @returns True if resources need refreshing, false otherwise
   */
  private isStale(): boolean {
    if (!this.lastRefreshed) return true;

    const now = new Date();
    const ageMs = now.getTime() - this.lastRefreshed.getTime();
    return ageMs > this.maxAge;
  }

  /**
   * Refreshes all resources (services, Redis instances, Postgres instances).
   *
   * @returns Promise that resolves when all resources are refreshed
   */
  async refreshResources(): Promise<void> {
    try {
      // Fetch all resources in parallel
      const [newServices, newRedises, newPostgreses] = await Promise.all([
        getServices(this.apiToken, this.serviceNameFilter),
        listRedis(this.apiToken, this.serviceNameFilter),
        listPostgres(this.apiToken, this.serviceNameFilter),
      ]);

      // Update cache with new data
      this.services = newServices;
      this.redises = newRedises;
      this.postgreses = newPostgreses;

      // Update refresh timestamp
      this.lastRefreshed = new Date();
    } catch (error) {
      console.error("Failed to refresh resources:", error);
      throw error;
    }
  }

  /**
   * Gets all resources, refreshing them if they are stale. It does not update
   * the resources synchronously, because that is slow
   *
   * @returns Promise resolving to an object containing all resources
   */
  async getResources(): Promise<{
    services: Service[];
    redises: Redis[];
    postgreses: Postgres[];
  }> {
    if (this.isStale()) {
      // defer execution of this.refreshResources, the caller does not want to
      // wait on it but it should happen in the background
      setTimeout(() => this.refreshResources(), 0);
    }

    return {
      services: this.services,
      redises: this.redises,
      postgreses: this.postgreses,
    };
  }
}

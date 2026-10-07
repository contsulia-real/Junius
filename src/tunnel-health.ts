export interface TunnelHealthSnapshot {
  readonly checkedAt: string;
  readonly url: string;
  readonly reachable: boolean;
  readonly live?: boolean;
  readonly ready?: boolean;
  readonly lifecycle?: string;
  readonly snapshotAt?: string;
  readonly controlPlaneLastError?: string;
  readonly controlPlaneConsecutiveFailures?: number;
  readonly dispatcherFailures?: number;
  readonly dispatcherTimeouts?: number;
  readonly responseDeliveryRetries?: number;
  readonly responseDeliveryTerminalFailures?: number;
  readonly responseDeliveryLastFailure?: string;
  readonly responseDeliveryDisposition?: string;
  readonly responseDeliveryHttpStatus?: number;
  readonly error?: string;
}

const DEFAULT_URLS = [
  "http://127.0.0.1:18080/health?details=true",
  "http://127.0.0.1:8080/health?details=true",
] as const;

function record(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function booleanField(
  source: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberField(
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringField(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function add<T>(
  key: string,
  value: T | undefined,
): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function healthUrls(
  environment = process.env,
): readonly string[] {
  const configured =
    environment.JUNIUS_TUNNEL_HEALTH_URL?.trim();
  return [
    ...(configured ? [configured] : []),
    ...DEFAULT_URLS,
  ].filter(
    (url, index, urls) => urls.indexOf(url) === index,
  );
}

export class TunnelHealthMonitor {
  readonly #urls: readonly string[];
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  #preferredUrl: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #latest: TunnelHealthSnapshot | undefined;

  constructor(
    urls: readonly string[] = healthUrls(),
    intervalMs = 2_000,
    timeoutMs = 500,
  ) {
    this.#urls = [...urls];
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.refresh();
    this.#timer = setInterval(
      () => void this.refresh(),
      this.#intervalMs,
    );
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  latest(): TunnelHealthSnapshot | undefined {
    return this.#latest;
  }

  async refresh(): Promise<TunnelHealthSnapshot> {
    const urls = this.#preferredUrl === undefined
      ? this.#urls
      : [
          this.#preferredUrl,
          ...this.#urls.filter(
            (url) => url !== this.#preferredUrl,
          ),
        ];
    let error = "tunnel_health_unreachable";

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(this.#timeoutMs),
          cache: "no-store",
        });
        if (!response.ok) {
          error = `http_${response.status}`;
          continue;
        }

        const body = record(await response.json());
        const runtime = record(body?.runtime);
        const components = record(body?.components);
        const controlPlane = record(
          record(components?.["control-plane"])?.details,
        );
        const dispatcher = record(
          record(components?.dispatcher)?.details,
        );
        const delivery = record(
          record(components?.["response-delivery"])?.details,
        );

        const snapshot: TunnelHealthSnapshot = {
          checkedAt: new Date().toISOString(),
          url,
          reachable: true,
          ...add("live", booleanField(body, "live")),
          ...add("ready", booleanField(body, "ready")),
          ...add(
            "lifecycle",
            stringField(runtime, "lifecycle"),
          ),
          ...add(
            "snapshotAt",
            stringField(body, "snapshot_at"),
          ),
          ...add(
            "controlPlaneLastError",
            stringField(controlPlane, "last_error"),
          ),
          ...add(
            "controlPlaneConsecutiveFailures",
            numberField(
              controlPlane,
              "consecutive_failures",
            ),
          ),
          ...add(
            "dispatcherFailures",
            numberField(dispatcher, "failures"),
          ),
          ...add(
            "dispatcherTimeouts",
            numberField(dispatcher, "timeouts"),
          ),
          ...add(
            "responseDeliveryRetries",
            numberField(delivery, "retries"),
          ),
          ...add(
            "responseDeliveryTerminalFailures",
            numberField(delivery, "terminal_failures"),
          ),
          ...add(
            "responseDeliveryLastFailure",
            stringField(delivery, "last_failure"),
          ),
          ...add(
            "responseDeliveryDisposition",
            stringField(delivery, "disposition"),
          ),
          ...add(
            "responseDeliveryHttpStatus",
            numberField(delivery, "http_status"),
          ),
        };

        this.#preferredUrl = url;
        this.#latest = snapshot;
        return snapshot;
      } catch (caught) {
        error =
          caught instanceof Error
            ? caught.message
            : String(caught);
      }
    }

    const snapshot: TunnelHealthSnapshot = {
      checkedAt: new Date().toISOString(),
      url: this.#preferredUrl ?? this.#urls[0] ?? "",
      reachable: false,
      error,
    };
    this.#latest = snapshot;
    return snapshot;
  }
}

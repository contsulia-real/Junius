import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

function nodeHeadersToWeb(req: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    headers.set(name, value);
  }

  return headers;
}

export function toWebRequest(
  req: IncomingMessage,
  fallbackOrigin: string,
): Request {
  const url = new URL(req.url ?? "/", fallbackOrigin);
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: nodeHeadersToWeb(req),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  return new Request(url, init);
}

export async function writeWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;

  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });

  if (response.body === null) {
    res.end();
    return;
  }

  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!res.write(Buffer.from(value))) {
        await once(res, "drain");
      }
    }

    res.end();
  } finally {
    reader.releaseLock();
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

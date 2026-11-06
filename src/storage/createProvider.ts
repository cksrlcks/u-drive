import type { Connection, StorageProvider } from "./StorageProvider";
import { MockProvider } from "./mock/MockProvider";
import { SeafileProvider } from "./seafile/SeafileProvider";
import { WapleProvider } from "./waple/WapleProvider";

export function createProvider(conn: Connection, token?: string | null): StorageProvider {
  switch (conn.kind) {
    case "seafile":
      return new SeafileProvider(conn.baseUrl, token ?? null);
    case "waple":
      return new WapleProvider(conn.baseUrl, token ?? null);
    case "mock":
      return new MockProvider(token ?? null);
  }
}

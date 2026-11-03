import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { MainScreen } from "@/features/browse/MainScreen";
import { McpBridge, McpToolProvider } from "@/features/mcp/McpBridge";
import { NearbyRoot } from "@/features/nearby/NearbyRoot";
import { SyncRoot } from "@/features/sync/SyncRoot";
import { UploadQueueRoot } from "@/features/upload/useUploadQueue";
import { StorageError } from "@/storage/StorageProvider";
import { StorageRoot, useSession } from "@/storage/StorageContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/features/shell/ErrorBoundary";
import { logError } from "@/lib/errorLog";

function Gate() {
  const { session, onUnauthorized } = useSession();
  const onError = (e: unknown) => {
    logError("server", e);
    if (e instanceof StorageError && e.kind === "unauthorized") onUnauthorized();
  };
  // 세션(서버·토큰)이 바뀌면 캐시도 새로: 다른 계정의 목록이 남지 않게
  const client = useMemo(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError }),
        mutationCache: new MutationCache({ onError }),
        defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onUnauthorized, session.connection.baseUrl, session.token],
  );
  return <QueryClientProvider client={client}>{session.token ? (
        <UploadQueueRoot>
          <McpToolProvider />
          <NearbyRoot />
          <SyncRoot />
          <MainScreen />
        </UploadQueueRoot>
      ) : (
        <LoginScreen />
      )}</QueryClientProvider>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <StorageRoot>
        <McpBridge />
        <TooltipProvider delay={400}>
          <Gate />
        </TooltipProvider>
      </StorageRoot>
    </ErrorBoundary>
  );
}

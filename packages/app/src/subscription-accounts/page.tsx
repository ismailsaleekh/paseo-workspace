import { useEffect, useState, useSyncExternalStore } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { AccountsModel } from "./model";
import { AccountsScreen } from "./screen";

export function SubscriptionAccountsPage({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.subscriptionAccounts === true,
  );
  const [model] = useState(() => new AccountsModel());
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    model.connect(
      connected && supported ? client : null,
      connected
        ? "Update the Paseo host to manage subscription accounts"
        : "Connect to your Mac to manage accounts",
    );
    return () => model.connect(null);
  }, [client, connected, supported, model]);
  useEffect(() => () => model.close(), [model]);
  return <AccountsScreen model={model} state={state} />;
}

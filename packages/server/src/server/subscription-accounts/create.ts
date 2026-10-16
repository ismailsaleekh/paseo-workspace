import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { PaseoDaemonConfig } from "../bootstrap.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import { AccountStore } from "./store.js";
import { SubscriptionOAuth } from "./oauth.js";
import { PiAuthFile } from "./pi-auth-file.js";
import { PiLogins } from "./pi-logins.js";
import { CodexAccounts } from "./codex.js";
import { SubscriptionAccounts } from "./service.js";

function piAgentDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? homedir();
  const directory = env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  if (directory === "~") return home;
  return directory.startsWith("~/") ? join(home, directory.slice(2)) : directory;
}

interface CreateAccountsOptions {
  config: Pick<PaseoDaemonConfig, "paseoHome" | "agentProviderSettings" | "providerOverrides">;
  logger: Logger;
  processes: ManagedProcessRegistry;
}

export function createSubscriptionAccounts({
  config,
  logger,
  processes,
}: CreateAccountsOptions): SubscriptionAccounts {
  const store = new AccountStore(config.paseoHome);
  const oauth = new SubscriptionOAuth();
  const settings = config.agentProviderSettings?.pi;
  const override = config.providerOverrides?.pi;
  const env = { ...process.env, ...settings?.env, ...override?.env };
  let command = override?.command;
  if (!command && settings?.command?.mode === "replace") command = settings.command.argv;
  const binary = command?.[0] ?? env.PI_COMMAND ?? env.PI_ACP_PI_COMMAND ?? "pi";
  const args =
    command?.slice(1) ?? (settings?.command?.mode === "append" ? settings.command.args : []);
  const logins = new PiLogins({
    store,
    oauth,
    env,
    auth: new PiAuthFile(join(piAgentDirectory(env), "auth.json"), binary),
    explicitKey: args?.some((arg) => arg === "--api-key" || arg.startsWith("--api-key=")) === true,
  });
  return new SubscriptionAccounts({
    store,
    oauth,
    logins,
    codex: new CodexAccounts(store.directory, logger, processes),
    logger,
  });
}

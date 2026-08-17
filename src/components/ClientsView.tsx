import { useState } from "react";
import { ChevronRight, Download, MonitorCog, Puzzle } from "lucide-react";
import { ClientLogo } from "@/components/ClientLogo";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { importableServers, type DetectedClient, type Registry } from "@/lib/types";

type ClientStatus = "connected" | "ready" | "error" | "missing";

function statusOf(client: DetectedClient): ClientStatus {
  if (client.error) return "error";
  if (client.gatewayInstalled) return "connected";
  if (client.appPresent) return "ready";
  return "missing";
}

function sortClients(clients: DetectedClient[]): DetectedClient[] {
  const rank = (client: DetectedClient) => {
    switch (statusOf(client)) {
      case "connected":
        return 0;
      case "ready":
        return 1;
      case "error":
        return 2;
      case "missing":
        return 3;
    }
  };
  return [...clients].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function StatusBadge({ status }: { status: ClientStatus }) {
  switch (status) {
    case "connected":
      return <Badge variant="success">Connected</Badge>;
    case "ready":
      return <Badge variant="info">Ready to connect</Badge>;
    case "error":
      return <Badge variant="warning">Couldn&apos;t read config</Badge>;
    case "missing":
      return <Badge variant="outline">Not installed</Badge>;
  }
}

function ClientRow({
  client,
  importCount,
  onSelect,
}: {
  client: DetectedClient;
  importCount: number;
  onSelect: () => void;
}) {
  const status = statusOf(client);
  const detail =
    status === "missing"
      ? "Install this client to configure it with Toolport"
      : client.configPath ||
        (client.usesConnectors ? "Uses account connectors" : "Config path unavailable");

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid min-h-14 w-full grid-cols-[32px_minmax(0,1fr)_auto_16px] items-center gap-3 border-b border-border/60 px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
        status === "missing" ? "opacity-60" : ""
      }`}
    >
      <ClientLogo id={client.id} name={client.name} size={32} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{client.name}</span>
          {client.usesConnectors && (
            <Puzzle
              className="size-3.5 shrink-0 text-info"
              aria-label="Uses connectors"
            />
          )}
        </span>
        <span className="block truncate font-mono text-2xs text-muted-foreground">
          {detail}
        </span>
      </span>
      <span className="flex items-center gap-2">
        {importCount > 0 && status !== "error" && status !== "missing" && (
          <Badge variant="owned">
            <Download />
            {importCount} to import
          </Badge>
        )}
        <StatusBadge status={status} />
      </span>
      <ChevronRight className="size-4 text-muted-foreground/50" aria-hidden="true" />
    </button>
  );
}

export function ClientsView({
  clients,
  registry,
  onSelectClient,
}: {
  clients: DetectedClient[];
  registry: Registry | null;
  onSelectClient: (id: string) => void;
}) {
  const [showMissing, setShowMissing] = useState(false);
  const sorted = sortClients(clients);
  const present = sorted.filter((client) => statusOf(client) !== "missing");
  const missing = sorted.filter((client) => statusOf(client) === "missing");
  const connected = present.filter((client) => statusOf(client) === "connected").length;
  const ready = present.filter((client) => statusOf(client) === "ready").length;

  if (clients.length === 0) {
    return (
      <EmptyState
        icon={<MonitorCog />}
        title="No AI clients detected"
        description="Install Claude Desktop, Cursor, VS Code, or another supported client, then refresh."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {present.length === 0 && (
        <EmptyState
          icon={<MonitorCog />}
          title="No supported clients installed"
          description="Install Claude Desktop, Cursor, VS Code, or another supported client, then refresh."
          className="py-12"
        />
      )}

      {connected + ready > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-success/20 bg-success/5 px-4 py-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-success/10 text-success">
            <MonitorCog className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">
              {connected === 0
                ? `${ready} client${ready === 1 ? "" : "s"} ready to connect`
                : `${connected} client${connected === 1 ? "" : "s"} connected`}
            </p>
            <p className="text-xs text-muted-foreground">
              {connected > 0 && ready > 0
                ? `${ready} more installed and ready when you are.`
                : connected > 0
                  ? "Your installed clients are connected to Toolport."
                  : "Choose a client below to connect it to Toolport."}
            </p>
          </div>
        </div>
      )}

      {present.length > 0 && (
        <section>
          <SectionHeader count={present.length}>On this machine</SectionHeader>
          <div className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
            {present.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                importCount={importableServers(client, registry).length}
                onSelect={() => onSelectClient(client.id)}
              />
            ))}
          </div>
        </section>
      )}

      {missing.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowMissing((value) => !value)}
            aria-expanded={showMissing}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${showMissing ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
            <span className="font-medium">Not installed</span>
            <span>{missing.length}</span>
          </button>
          {showMissing && (
            <div className="mt-2 overflow-hidden rounded-xl border border-border/60 bg-card/30">
              {missing.map((client) => (
                <ClientRow
                  key={client.id}
                  client={client}
                  importCount={0}
                  onSelect={() => onSelectClient(client.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

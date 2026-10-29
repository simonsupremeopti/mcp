import { type FormEvent, useState } from "react";

import { ArrowLeftIcon } from "lucide-react";

import {
  sendBrowserControlMessage,
  useBrowserControl,
} from "@browsermcp/extension-core/popup";
import { RELAY_PORTS, isValidRelayPort } from "@browsermcp/protocol";

import { Button, ErrorAlert } from "./ui";

/**
 * The popup's settings: the port of a server started with `--port`, and, for a server on another machine (`--host`), its address and join token. Add a setting only when users can't do without it, since each one is more for every user to read
 */
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [view, refresh] = useBrowserControl();
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
  };

  return (
    <div className="w-80 text-[13px]">
      <div className="flex items-center gap-1 px-2 py-2.5">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon className="size-5 rtl:rotate-180" />
        </Button>
        <h1 className="text-[15px] font-semibold">Settings</h1>
      </div>
      {error && (
        <div className="px-4 pb-3">
          <ErrorAlert>{error}</ErrorAlert>
        </div>
      )}
      {view && (
        <div className="border-t px-4 py-3">
          <PortSetting
            // Remounts with the saved port, so the field shows it
            key={view.relayPort ?? "default"}
            relayPort={view.relayPort}
            onSave={(port) =>
              run(() => sendBrowserControlMessage("setRelayPort", { port }))
            }
          />
        </div>
      )}
      {view && (
        <div className="space-y-3 border-t px-4 py-3">
          <TextSetting
            key={`host-${view.relayHost ?? "local"}`}
            id="settings-host"
            label="Server address"
            placeholder="This computer"
            initial={view.relayHost ?? ""}
            help="Only if the server runs on another machine with --host. Enter the address it listens on."
            onSave={(host) =>
              run(() => sendBrowserControlMessage("setRelayHost", { host }))
            }
          />
          {view.relayHost && (
            <TextSetting
              key={`token-${view.hasJoinToken}`}
              id="settings-token"
              label="Join token"
              placeholder={view.hasJoinToken ? "Saved" : "From the server"}
              initial=""
              help="A server on another machine only drives browsers you allowed. Paste its join token once."
              onSave={(token) =>
                run(() => sendBrowserControlMessage("setJoinToken", { token }))
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The port of a server started with `--port`: the default ports (`RELAY_PORTS`) are tried while it's empty
 */
function PortSetting({
  relayPort,
  onSave,
}: {
  relayPort: number | null;
  onSave: (port: number | null) => void;
}) {
  const [value, setValue] = useState(relayPort?.toString() ?? "");
  const [invalid, setInvalid] = useState(false);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (text === "") {
      onSave(null);
      return;
    }
    const port = Number(text);
    if (!/^\d+$/.test(text) || !isValidRelayPort(port)) {
      setInvalid(true);
      return;
    }
    onSave(port);
  };

  return (
    <form onSubmit={save} className="space-y-2">
      <label htmlFor="settings-port" className="block font-medium">
        Server port
      </label>
      <div className="flex gap-2">
        <input
          id="settings-port"
          className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
          inputMode="numeric"
          placeholder={RELAY_PORTS.join(", ")}
          value={value}
          aria-invalid={invalid}
          aria-describedby="settings-port-help"
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
        />
        <Button type="submit" variant="outline">
          Save
        </Button>
      </div>
      <p
        id="settings-port-help"
        className={`text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}
      >
        {invalid
          ? "Enter a port from 1024 to 65535, other than 9009."
          : "Only if the server runs with --port. Enter the same port here. Leave it empty for the default ports."}
      </p>
      {relayPort !== null && (
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={() => onSave(null)}
        >
          Use default ports
        </Button>
      )}
    </form>
  );
}

/** A one-line setting saved as text, or null when empty */
function TextSetting({
  id,
  label,
  placeholder,
  initial,
  help,
  onSave,
}: {
  id: string;
  label: string;
  placeholder: string;
  initial: string;
  help: string;
  onSave: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);

  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave(value.trim() || null);
  };

  return (
    <form onSubmit={save} className="space-y-2">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={placeholder}
          value={value}
          aria-describedby={`${id}-help`}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" variant="outline">
          Save
        </Button>
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {help}
      </p>
    </form>
  );
}

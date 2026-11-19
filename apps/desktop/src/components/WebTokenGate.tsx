import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IS_WEB_APP, saveWebToken, tokenWasRefused, webToken } from "@/lib/webApp";

const hasToken = !IS_WEB_APP || webToken() !== null;

/// Holds the web build at a token form until the browser has one. Everywhere
/// else, and once a token is kept, it draws the app untouched.
export default function WebTokenGate({ children }: { children: ReactNode }) {
  return hasToken ? children : <TokenForm />;
}

function TokenForm() {
  const [token, setToken] = useState("");
  const [refused] = useState(tokenWasRefused);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token.trim()) saveWebToken(token.trim());
  };

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background p-6 text-foreground">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Open Dray</h1>
          <p className="text-sm text-muted-foreground">
            This page talks to the Dray server on {location.host}. Paste the token from{" "}
            <code>~/.dray/serve-token</code> on that machine.
          </p>
        </div>
        <Input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Token"
          aria-label="Server token"
          aria-invalid={refused || undefined}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {refused && <p className="text-sm text-destructive">The server refused that token.</p>}
        <Button type="submit" disabled={!token.trim()}>
          Connect
        </Button>
      </form>
    </div>
  );
}

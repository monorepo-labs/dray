import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { trackRenderError } from "@/lib/analytics";

/// Catches a render error anywhere in the app and draws a Reload button in its
/// place. Without it React unmounts the whole root, and the window is glass
/// whose only fill is the page — so a crash read as the app going dark and
/// see-through, with a restart the only way back (#522).
export default class CrashScreen extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    trackRenderError(error, info.componentStack ?? "");
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background text-center text-ui text-muted-foreground">
        <p>Dray hit an error and stopped drawing. Your sessions are still running.</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}

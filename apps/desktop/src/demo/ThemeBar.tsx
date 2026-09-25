import Segmented from "@/components/Segmented";
import ThemeSwatches from "@/components/ThemeSwatches";
import { useTheme } from "@/hooks/useTheme";

/// A demo page's palette and mode switch, pinned to its corner: Settings' own
/// swatches, so a click focuses the group and the arrow keys walk the palettes.
/// It drives the app's theme store, so a demo is judged in exactly what
/// `applyTheme` draws. A dark-only palette stays dark under Light, as in the app.
export default function DemoThemeBar() {
  const { resolvedMode, setMode } = useTheme();
  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col items-start gap-3 rounded-xl border border-border bg-popover p-3 shadow-card">
      <ThemeSwatches label="Theme" compact />
      <Segmented
        label="Mode"
        value={resolvedMode}
        onPick={setMode}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
    </div>
  );
}

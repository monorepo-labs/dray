import PanelLeftIcon from "@/components/icons/PanelLeftIcon";
import { cn } from "@/lib/utils";

/// The sidebar glyph mirrored, for the right-hand panel toggle.
///
/// A CSS flip rather than a second drawing: the two toggles sit in the same
/// header and any tweak to stroke weight or corner radius has to land on both,
/// which a copy would eventually miss.
export default function PanelRightIcon({
  className,
  ...props
}: React.ComponentProps<typeof PanelLeftIcon>) {
  return <PanelLeftIcon {...props} className={cn("-scale-x-100", className)} />;
}

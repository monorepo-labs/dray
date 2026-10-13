import React, { useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import ReactDOM from "react-dom/client";
import { ChevronDown } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";

/// Ways to demote "Quit and stop sessions" in the quit dialog (#479).
///
/// Each variant is drawn twice: a static copy to compare side by side, and the
/// real `AlertDialog` behind Try it, so focus and Tab order can be felt. The
/// real dialog lands focus on Quit, as `QuitDialog` does.

const DESCRIPTION = "Sessions keep running in the background.";

type Ref = RefObject<HTMLButtonElement | null>;
type ActionProps = ComponentProps<typeof AlertDialogAction>;
/// The two buttons Radix only lets live inside an open dialog, swapped for
/// plain look-alikes in the static previews.
type Kit = { quitRef: Ref; Cancel: (p: { children: ReactNode }) => ReactNode; Action: (p: ActionProps) => ReactNode };
type Body = (kit: Kit) => ReactNode;

const LIVE = { Cancel: AlertDialogCancel, Action: AlertDialogAction };

const PREVIEW = {
  Cancel: ({ children }: { children: ReactNode }) => (
    <button className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-ui")}>{children}</button>
  ),
  Action: ({ className, destructive, variant, ref, ...p }: ActionProps) => (
    <button
      ref={ref}
      className={cn(
        buttonVariants({ variant, size: "sm" }),
        "text-ui",
        destructive && "bg-destructive text-white hover:bg-destructive/90",
        className,
      )}
      {...(p as ComponentProps<"button">)}
    />
  ),
};

const quit = ({ quitRef, Action }: Kit, label = "Quit") => <Action ref={quitRef}>{label}</Action>;

const ghost = ({ Action }: Kit, label: string) => (
  <Action variant="ghost" className="px-px text-muted-foreground hover:bg-transparent hover:text-destructive dark:hover:bg-transparent">
    {label}
  </Action>
);

function Header({ description = DESCRIPTION }: { description?: ReactNode }) {
  return (
    <AlertDialogHeader>
      <AlertDialogTitle>Quit Dray?</AlertDialogTitle>
      <AlertDialogDescription>{description}</AlertDialogDescription>
    </AlertDialogHeader>
  );
}

/// Quit with a chevron half opening the stop-everything item.
function SplitQuit({ quitRef, Action }: Kit) {
  return (
    <div className="flex">
      <Action ref={quitRef} className="rounded-r-none">
        Quit
      </Action>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" className="rounded-l-none border-l border-l-black/15" aria-label="More quit options">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="text-ui whitespace-nowrap">Quit and stop sessions</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function CheckboxBody({ quitRef, Cancel, Action }: Kit) {
  const [stop, setStop] = useState(false);
  return (
    <>
      <Header />
      <label className="flex cursor-pointer items-center gap-2 text-ui text-muted-foreground">
        <input
          type="checkbox"
          checked={stop}
          onChange={(e) => setStop(e.target.checked)}
          className="size-3.5 accent-destructive"
        />
        Also stop running sessions
      </label>
      <AlertDialogFooter>
        <Cancel>Cancel</Cancel>
        <Action ref={quitRef} destructive={stop}>
          {stop ? "Quit and stop" : "Quit"}
        </Action>
      </AlertDialogFooter>
    </>
  );
}

const VARIANTS: { id: string; name: string; note: string; body: Body }[] = [
  {
    id: "current",
    name: "Before",
    note: "What shipped before #479. Red stop button beside Cancel.",
    body: (kit) => (
      <>
        <Header />
        <AlertDialogFooter>
          <kit.Cancel>Cancel</kit.Cancel>
          <kit.Action destructive>Quit and stop sessions</kit.Action>
          {quit(kit)}
        </AlertDialogFooter>
      </>
    ),
  },
  {
    id: "ghost-right",
    name: "A · Ghost, right",
    note: "Cancel, Quit, then a quiet ghost past Quit.",
    body: (kit) => (
      <>
        <Header />
        <AlertDialogFooter>
          <kit.Cancel>Cancel</kit.Cancel>
          {quit(kit)}
          {ghost(kit, "Quit and stop sessions")}
        </AlertDialogFooter>
      </>
    ),
  },
  {
    id: "ghost-left",
    name: "B · Ghost, left",
    note: "The stop option across the footer from Cancel and Quit.",
    body: (kit) => (
      <>
        <Header />
        <AlertDialogFooter className="sm:justify-between">
          {ghost(kit, "Quit and stop sessions")}
          <div className="flex gap-2">
            <kit.Cancel>Cancel</kit.Cancel>
            {quit(kit)}
          </div>
        </AlertDialogFooter>
      </>
    ),
  },
  {
    id: "completely",
    name: "C · Quit completely",
    note: "Ghost on the left with shorter copy. What QuitDialog ships.",
    body: (kit) => (
      <>
        <Header description="Sessions keep running in the background. Quit completely stops them too." />
        <AlertDialogFooter className="sm:justify-between">
          {ghost(kit, "Quit completely")}
          <div className="flex gap-2">
            <kit.Cancel>Cancel</kit.Cancel>
            {quit(kit)}
          </div>
        </AlertDialogFooter>
      </>
    ),
  },
  {
    id: "split",
    name: "D · Dropdown on Quit",
    note: "Two buttons. The stop option is behind Quit's chevron.",
    body: (kit) => (
      <>
        <Header />
        <AlertDialogFooter>
          <kit.Cancel>Cancel</kit.Cancel>
          <SplitQuit {...kit} />
        </AlertDialogFooter>
      </>
    ),
  },
  {
    id: "checkbox",
    name: "E · Checkbox",
    note: "Two buttons. Ticking the box turns Quit red and renames it.",
    body: (kit) => <CheckboxBody {...kit} />,
  },
];

/// The dialog's own frame without the portal and overlay, so six sit in a grid.
/// The closed `AlertDialog` around it only lends the buttons their context.
function Preview({ body }: { body: Body }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={false}>
      <div className="grid w-full max-w-100 gap-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg backdrop-blur-xl">
        {body({ quitRef: ref, ...PREVIEW })}
      </div>
    </AlertDialog>
  );
}

function Live({ body, open, onOpenChange }: { body: Body; open: boolean; onOpenChange: (v: boolean) => void }) {
  const quitRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          quitRef.current?.focus();
        }}
      >
        {body({ quitRef, ...LIVE })}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Demo() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="min-h-screen p-10 pb-24">
      <h1 className="mb-1 text-lg font-medium">Quit dialog</h1>
      <p className="mb-8 max-w-lg text-xs text-muted-foreground">
        Ways to tuck away “Quit and stop sessions”. Try it opens the real dialog with focus on Quit, so
        Tab and Enter behave as they would after ⌘Q.
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(26rem,1fr))] gap-10">
        {VARIANTS.map((v) => (
          <section key={v.id} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <h2 className="text-ui font-medium">{v.name}</h2>
                <p className="text-xs text-muted-foreground">{v.note}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setOpen(v.id)}>
                Try it
              </Button>
            </div>
            <Preview body={v.body} />
            <Live body={v.body} open={open === v.id} onOpenChange={(o) => setOpen(o ? v.id : null)} />
          </section>
        ))}
      </div>
      <DemoThemeBar />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

/// Frame, overlay and animation match `alert-dialog`'s exactly: to a reader the
/// two are the same object, and they differ only in whether the app is asking a
/// question or the reader opened something.
///
/// That difference is the close cross. An alert is answered by its own buttons,
/// so it carries no dismiss; a dialog the reader opened is dismissed rather than
/// answered, and Escape alone is a way out only for people who already know it
/// is there.
function DialogContent({
  className,
  children,
  showClose = true,
  dismissible = true,
  onEscapeKeyDown,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /// Off where the header's right end holds a control of its own.
  showClose?: boolean
  /// Off while something the dialog started is still running: Escape and the
  /// overlay do nothing, and the overlay stops promising otherwise.
  dismissible?: boolean
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="dialog-overlay"
        // Lifts under the pointer because a click there closes the dialog; an
        // alert's overlay, which a click does not close, stays put. Light lifts
        // less, its scrim already reading thinner over a bright page. Durations
        // are set raw: `duration-250` also sets `--tw-duration`, which would
        // slow the open and close fades with it.
        className={cn(
          "peer fixed inset-0 z-50 bg-black/50 transition-colors [transition-duration:250ms] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          dismissible && "hover:bg-black/48 dark:hover:bg-black/40"
        )}
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-100 -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-popover backdrop-blur-xl p-5 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        onEscapeKeyDown={(e) => {
          if (!dismissible) e.preventDefault()
          onEscapeKeyDown?.(e)
        }}
        onInteractOutside={(e) => {
          if (!dismissible) e.preventDefault()
          onInteractOutside?.(e)
        }}
        {...props}
      >
        {children}
        {/* Says what the lifted overlay means, dropping into place as it
            fades in. Inside the card so it rides the card wherever its height
            puts it; matched off the overlay's hover by sibling selector, since
            `peer-hover` reaches siblings and not their children.
            `pointer-events-none` so it never takes the hover off the overlay. */}
        {dismissible && (
          <p
            aria-hidden
            className="pointer-events-none absolute bottom-full left-1/2 mb-3 -translate-x-1/2 -translate-y-1 text-ui whitespace-nowrap text-white/50 opacity-0 transition-[opacity,translate] [transition-duration:250ms] [.peer:hover~*_&]:translate-y-0 [.peer:hover~*_&]:opacity-100"
          >
            Click or press Esc to close
          </p>
        )}
        {showClose && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-5 right-5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-ui font-medium", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-ui text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
}

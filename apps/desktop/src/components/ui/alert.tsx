import * as React from "react"

import { cn } from "@/lib/utils"

// `--popover`, not `--card`, and the two are the same colour with an opaque
// page under them — so this changes nothing until vibrancy is on. There
// `--card` becomes a 5.5% white veil, right for a surface sitting *in* the page;
// an alert floats over one, and lands on the sidebar, which has no fill at all
// under vibrancy. `--popover` plus the blur is what makes that readable — the
// veil alone was not, which is why this was an opaque fill until the frames
// gained one.
const ALERT =
  "group/alert relative grid w-full gap-0.5 rounded-lg border bg-popover px-2.5 py-2 text-left text-sm text-popover-foreground backdrop-blur-xl has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4"

function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert" role="alert" className={cn(ALERT, className)} {...props} />
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }

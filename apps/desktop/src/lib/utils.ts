import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Our semantic sizes are custom `text-*` utilities, and tailwind-merge can't
// tell them from `text-*` colors — it treats the two as one group and drops the
// size whenever a color follows it (`text-tool text-destructive` silently became
// just the color, leaving the element at the browser default). Registering them
// as font sizes keeps both.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["chat", "code", "tool", "ui", "composer"] },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

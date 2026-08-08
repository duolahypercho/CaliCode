import * as React from "react";
import { cn } from "./utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors hover:border-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";


import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "./utils";

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => {
  const innerRef = React.useRef<HTMLDivElement>(null);
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      const currentRef = innerRef as { current: HTMLDivElement | null };
      currentRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object") Object.assign(ref, { current: node });
    },
    [ref],
  );
  React.useEffect(() => {
    const el = innerRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const keepVisible = () => {
      const active = el.querySelector('[data-state="active"]');
      if (!active) return;
      const left = (active as HTMLElement).offsetLeft;
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      const target = Math.max(0, Math.min(left, max));
      if (el.scrollLeft !== target) el.scrollTo({ left: target });
    };
    const observer = new MutationObserver(keepVisible);
    observer.observe(el, { attributes: true, childList: true, subtree: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        requestAnimationFrame(keepVisible);
      }
    };
    el.addEventListener("keydown", onKeyDown);
    keepVisible();
    return () => {
      observer.disconnect();
      el.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return (
    <TabsPrimitive.List
      ref={setRefs}
      className={cn("inline-flex h-8 w-full max-w-full flex-nowrap items-center justify-start gap-1 overflow-x-auto border-b border-border", className)}
      {...props}
    />
  );
});
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex min-h-[28px] shrink-0 items-center whitespace-nowrap rounded-t-md border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground active:bg-surface-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-foreground",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("pt-2", className)} {...props} />
));
TabsContent.displayName = "TabsContent";

import { useRef, type ReactNode, type RefObject } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

interface ConfirmDialogProps {
  /** Rendered only while a target is pending, so the copy can name it. */
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  /** Off for reversible actions; the confirm button loses its danger fill. */
  destructive?: boolean;
  /**
   * Where focus goes when the trigger does not survive the confirmation.
   *
   * Confirming here destroys the thing the trigger belonged to, so by the time
   * Radix tries to hand focus back the button is detached and focus lands on
   * <body> — keyboard users restart at the top of the document and screen
   * readers announce nothing. Point this at a container that outlives the
   * removal (give it `tabIndex={-1}`); it is only used when the trigger is
   * really gone, so an ordinary cancel still returns focus to the trigger.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The one confirmation shape for destructive actions inside a tab.
 *
 * Nothing in the project document has undo, so anything that drops data has to
 * say what it drops before it happens. Styled to match the project-action
 * confirmation in the shell (App.tsx) so the two read as the same control.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onOpenChange,
  destructive = true,
  returnFocusRef,
}: ConfirmDialogProps) {
  // Whatever had focus when the dialog opened — in practice the trigger. Radix
  // fires this before the content steals focus, so it is still the opener.
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm border-line bg-popover text-ink-strong shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
        onOpenAutoFocus={() => {
          openerRef.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(event) => {
          // Radix's own close handler focuses `DialogTrigger`, and this dialog
          // is opened from state rather than a Trigger, so its restore is a
          // no-op and focus falls to <body> on Cancel as well as on confirm.
          // Do it here instead: the opener when it survived, otherwise the
          // container the caller nominated.
          const opener = openerRef.current;
          const target = opener?.isConnected ? opener : returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-1 leading-relaxed text-ink-subtle">{description}</DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            size="sm"
            onClick={onConfirm}
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

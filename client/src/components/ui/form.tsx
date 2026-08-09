import * as React from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label } from "./label";
import { cn } from "./utils";

export const Form = FormProvider;

const FormFieldContext = React.createContext<{ name: string } | null>(null);
const FormItemContext = React.createContext<{ id: string } | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

export function FormItem({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const id = React.useId();
  return (
    <FormItemContext.Provider value={{ id }}>
      <div className={cn("space-y-1", className)} {...props} />
    </FormItemContext.Provider>
  );
}

export function FormLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  const { error, formItemId } = useFormField();
  return <Label htmlFor={formItemId} className={cn(error && "text-destructive", className)} {...props} />;
}

export function FormControl({ children }: { children: React.ReactElement<Record<string, unknown>> }) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  return React.cloneElement(children, {
    id: formItemId,
    "aria-describedby": error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId,
    "aria-invalid": Boolean(error),
  });
}

export function FormMessage({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error.message ?? "") : children;
  if (!body) return null;
  return (
    <p id={formMessageId} role="alert" className={cn("text-xs text-destructive", className)} {...props}>
      {body}
    </p>
  );
}

function useFormField() {
  const field = React.useContext(FormFieldContext);
  const item = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();
  if (!field || !item) throw new Error("Form fields must be rendered inside FormField and FormItem");
  const state = getFieldState(field.name, formState);
  return {
    ...state,
    formItemId: `${item.id}-form-item`,
    formDescriptionId: `${item.id}-form-item-description`,
    formMessageId: `${item.id}-form-item-message`,
  };
}

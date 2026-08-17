import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import type { VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { actionButtonVariants } from "./action-button.styles";

interface ActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof actionButtonVariants> {
  asChild?: boolean;
}

const ActionButton = React.forwardRef<HTMLButtonElement, ActionButtonProps>(
  ({ asChild = false, className, intent, size, type = "button", ...props }, ref) => {
    const Component = asChild ? Slot : "button";

    return (
      <Component
        ref={ref}
        className={cn(actionButtonVariants({ intent, size }), className)}
        type={asChild ? undefined : type}
        {...props}
      />
    );
  },
);

ActionButton.displayName = "ActionButton";

export { ActionButton };
export type { ActionButtonProps };
